import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { command, readJson, writeJson } from "./io.mjs";
import { normalizeReview } from "./normalize.mjs";
import { verifySnapshot } from "./prepare.mjs";
import { adapterDir, freezeProfile } from "./runtime.mjs";
import { digest, requireValue } from "./score.mjs";
import { measurementFingerprint } from "./fingerprint.mjs";

const docker = (args, options = {}) => command("docker", args, { timeout: 30_000, ...options });
const exists = async (path) => stat(path).then(() => true, () => false);
const resources = ["--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--pids-limit", "256", "--memory", "4g", "--cpus", "2", "--tmpfs", "/tmp:rw,mode=1777"];

async function ready(name) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await docker(["exec", name, "python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=1).read()"]);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Model-only gateway did not become ready");
}

export function usageReceipt(events, basis) {
  const started = events.filter((item) => item.event === "started");
  const finished = events.filter((item) => item.event === "finished");
  const usage = { attempts: started.length, completedRequests: finished.length, promptTokens: 0, completionTokens: 0, cachedTokens: 0, usageComplete: started.length > 0 && started.length === finished.length };
  for (const event of finished) {
    if (!Number.isSafeInteger(event.usage?.prompt_tokens) || !Number.isSafeInteger(event.usage?.completion_tokens)) {
      usage.usageComplete = false;
      continue;
    }
    usage.promptTokens += event.usage.prompt_tokens;
    usage.completionTokens += event.usage.completion_tokens;
    usage.cachedTokens += event.usage.cached_tokens ?? 0;
  }
  return { costUsd: null, costBasis: basis, usage };
}

async function executeTrial(plan, job, profile, snapshotRoot, trialRoot, executionMode) {
  const { frozen, pins } = await freezeProfile(profile, job.layer);
  requireValue(digest(pins) === digest(plan.treatmentPins[`${job.layer}/${job.treatment}`]), "Runtime changed after planning; freeze a new experiment");
  const snapshot = await verifySnapshot(snapshotRoot, job, plan.corpusDigest);
  for (const image of new Set([profile.image, profile.gateway.image])) {
    requireValue((await docker(["image", "inspect", "--format", "{{.Id}}", image])).trim() === image, "Image unavailable or different from pin");
  }
  const uid = profile.user.split(":")[0];
  await mkdir(trialRoot, { recursive: false });
  for (const dir of ["config", "instructions", "reviewer", "gateway"]) {
    await mkdir(join(trialRoot, dir));
  }
  // Only the reviewer output is writable by the agent; it cannot forge the gateway's usage journal.
  await chmod(join(trialRoot, "reviewer"), 0o777);
  await chmod(join(trialRoot, "gateway"), 0o777);
  const config = join(trialRoot, "config");
  await writeFile(join(config, "gateway.json"), JSON.stringify(profile.gateway));
  await writeFile(join(config, "reviewer.json"), JSON.stringify(frozen.reviewer));
  for (const [index, text] of (frozen.reviewer.instructions ?? []).entries()) {
    if (job.layer === "thermo") {
      await writeFile(join(trialRoot, "instructions", `${index}.md`), text);
    }
  }
  const id = `rb-${randomUUID()}`;
  const gateway = `${id}-gateway`;
  const reviewer = `${id}-reviewer`;
  const begun = new Date().toISOString();
  await writeJson(join(trialRoot, "started.json"), { jobId: job.id, experimentDigest: plan.experimentDigest, pins, begun, container: reviewer });
  let durationMs = 0;
  let status = "failed";
  let error = null;
  let candidate = null;
  let adapter = { coverage: "unknown" };
  let reviewStarted;
  try {
    await docker(["network", "create", "--internal", id]);
    await docker(["create", "--name", gateway, ...resources, "--network", id, "--network-alias", "benchmark-gateway", "--user", profile.user, "--env", "RB_GATEWAY_KEY", "--mount", `type=bind,src=${adapterDir},dst=/bench,readonly`, "--mount", `type=bind,src=${config},dst=/config,readonly`, "--mount", `type=bind,src=${join(trialRoot, "gateway")},dst=/out`, "--entrypoint", "python", profile.gateway.image, "/bench/gateway.py"]);
    await docker(["network", "connect", profile.gateway.network, gateway]);
    await docker(["start", gateway]);
    await ready(gateway);
    let executable = "python";
    let script = "/bench/triage.py";
    if (job.layer === "thermo") {
      executable = "node";
      script = "/bench/thermo.mjs";
    }
    reviewStarted = performance.now();
    await docker(["run", "--name", reviewer, "--pull", "never", ...resources, "--tmpfs", `/home/triage:rw,uid=${uid},gid=${profile.user.split(":")[1]},mode=700`, "--network", id, "--user", profile.user,
      "--env", "GIT_CONFIG_COUNT=1", "--env", "GIT_CONFIG_KEY_0=safe.directory", "--env", "GIT_CONFIG_VALUE_0=/work/repo",
      "--mount", `type=bind,src=${adapterDir},dst=/bench,readonly`, "--mount", `type=bind,src=${config},dst=/config,readonly`,
      "--mount", `type=bind,src=${join(trialRoot, "instructions")},dst=/instructions,readonly`,
      "--mount", `type=bind,src=${join(snapshotRoot, "repo")},dst=/work/repo,readonly`, "--mount", `type=bind,src=${join(snapshotRoot, "pr")},dst=/work/pr,readonly`,
      "--mount", `type=bind,src=${join(trialRoot, "reviewer")},dst=/out`, "--workdir", "/work/repo", "--entrypoint", executable, profile.image, script], { timeout: profile.timeoutSeconds * 1000 });
    durationMs = Math.round(performance.now() - reviewStarted);
    status = "invalid";
    const review = await readJson(join(trialRoot, "reviewer/review.json"));
    candidate = normalizeReview({ layer: job.layer, pr: snapshot.pr, agent: `${job.layer}/${job.treatment}`, review });
    adapter = await readJson(join(trialRoot, "reviewer/adapter.json"));
    requireValue(["complete", "partial", "unknown"].includes(adapter.coverage), "Invalid coverage artifact");
    status = "completed";
  } catch {
    error = "Trial failed or output validation failed; credentials and raw logs withheld";
    if (reviewStarted) {
      durationMs = Math.round(performance.now() - reviewStarted);
    }
  } finally {
    // Killing a timed-out docker client does not kill its container.
    await docker(["rm", "--force", reviewer, gateway]).catch(() => {});
    await docker(["network", "rm", id]).catch(() => {});
  }
  let journal = "";
  if (await exists(join(trialRoot, "gateway/requests.jsonl"))) {
    journal = await readFile(join(trialRoot, "gateway/requests.jsonl"), "utf8");
  }
  const events = journal.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const responseEvents = events.filter((item) => item.event === "finished");
  if (status === "completed" && (!responseEvents.length || responseEvents.some((item) => item.model !== pins.effectiveModel || item.finishReasons?.includes("length")))) {
    status = "invalid";
    candidate = null;
    error = "No attested model response, model drift, or truncated model output";
  }
  if (candidate && status === "completed") {
    await writeJson(join(trialRoot, "candidate.json"), candidate);
  } else {
    candidate = null;
  }
  const receipt = {
    jobId: job.id, experimentDigest: plan.experimentDigest, base: job.base, head: job.head, executionMode,
    ...pins, durationMs, coverage: adapter.coverage, status, error, ...usageReceipt(events, profile.gateway.costBasis),
    snapshotDigest: digest(snapshot), goldDigest: snapshot.goldDigest, gatewayJournalDigest: digest(journal), candidateDigest: digest(candidate), coverageEvidence: adapter.coverageEvidence,
  };
  await writeJson(join(trialRoot, "trial.json"), receipt);
  return receipt;
}

/** Sequential by design: a trial cap is checked before starting any provider-capable container. */
export async function runPlan(plan, execution, snapshots, output) {
  requireValue(plan.ready, "Freeze reviewer/model/configuration pins first");
  requireValue(plan.measurementDigest === await measurementFingerprint(), "Measurement code changed after planning");
  requireValue(["live", "fixture"].includes(execution.executionMode), "Declare live or fixture execution explicitly");
  requireValue(Number.isSafeInteger(execution.maxTrials) && execution.maxTrials > 0, "Set a positive maxTrials for this invocation");
  requireValue(Boolean(process.env.RB_GATEWAY_KEY), "Supply RB_GATEWAY_KEY only to the gateway process environment");
  const root = resolve(output);
  await mkdir(root, { recursive: true });
  const savedPlan = join(root, "plan.json");
  if (await exists(savedPlan)) {
    requireValue(digest(await readJson(savedPlan)) === digest(plan), "Run directory belongs to another plan");
  } else {
    await writeJson(savedPlan, plan);
  }
  const completed = [];
  let newTrials = 0;
  for (const job of plan.jobs) {
    const trialRoot = join(root, ...job.id.split("/"));
    if (await exists(join(trialRoot, "trial.json"))) {
      const receipt = await readJson(join(trialRoot, "trial.json"));
      requireValue(receipt.experimentDigest === plan.experimentDigest && receipt.jobId === job.id, "Resume receipt mismatch");
      completed.push(receipt);
      continue;
    }
    requireValue(!(await exists(trialRoot)), "Interrupted attempt exists; reconcile its usage before resuming (never auto-repeat a billed call)");
    if (newTrials >= execution.maxTrials) {
      continue;
    }
    await mkdir(join(trialRoot, ".."), { recursive: true });
    completed.push(await executeTrial(plan, job, execution.profiles[`${job.layer}/${job.treatment}`], resolve(snapshots, job.caseId), trialRoot, execution.executionMode));
    newTrials += 1;
  }
  return { experimentDigest: plan.experimentDigest, newTrials, recorded: completed.length, planned: plan.jobs.length, pending: plan.jobs.length - completed.length, statuses: completed.map(({ jobId, status }) => ({ jobId, status })) };
}
