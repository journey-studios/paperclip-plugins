import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { digest, requireValue } from "./score.mjs";

export const adapterDir = fileURLToPath(new URL("./adapters", import.meta.url));
const IMAGE = /^sha256:[a-f0-9]{64}$/;

/** Hash instruction contents, not machine-specific source paths. No credentials belong in this document. */
export async function freezeProfile(profile, layer) {
  requireValue(profile && IMAGE.test(profile.image), "Use a locally available immutable reviewer image id");
  requireValue(IMAGE.test(profile.gateway?.image), "Pin the gateway image id");
  requireValue(/^[a-zA-Z0-9_.-]+$/.test(profile.gateway.network), "Invalid model network name");
  requireValue(/^https?:\/\/[a-zA-Z0-9_.:-]+(?:\/v1)?\/?$/.test(profile.gateway.upstream), "Use a fixed model gateway endpoint without credentials or query strings");
  const gateway = profile.gateway;
  requireValue(typeof gateway.effectiveModel === "string" && gateway.effectiveModel.length > 0 && !/pool|^auto\//i.test(gateway.effectiveModel), "Select a fixed model response; automatic pools cannot be frozen");
  requireValue(typeof gateway.requestModel === "string" && gateway.requestModel.length > 0 && !/^auto\//i.test(gateway.requestModel), "Select a fixed model route");
  if (/pool/i.test(gateway.requestModel)) {
    const snapshot = gateway.routingSnapshot;
    const responseModel = snapshot?.responseModel ?? snapshot?.models?.[0]?.model;
    requireValue(snapshot?.name === gateway.requestModel && snapshot.models?.length === 1 && responseModel === gateway.effectiveModel && typeof snapshot.models[0].provider === "string", "Select a fixed model route or snapshot a single-model pool; every response remains checked");
    if (snapshot.responseModel) {
      requireValue(typeof snapshot.responseModelEvidence === "string" && snapshot.responseModelEvidence.trim(), "A different reported response model needs calibration evidence");
    }
  }
  for (const key of ["maxRequests", "maxOutputTokens", "maxInputBytes", "timeoutSeconds"]) {
    requireValue(Number.isSafeInteger(profile.gateway[key]) && profile.gateway[key] > 0, `Set a positive gateway ${key}`);
  }
  requireValue(["unknown", "subscription"].includes(profile.gateway.costBasis), "This adapter reports unpriced gateway usage; dollar estimates need a separate rate receipt");
  if (profile.gateway.normalizeStepLimitRole !== undefined) {
    requireValue(typeof profile.gateway.normalizeStepLimitRole === "boolean", "Step-limit role normalization must be an explicit boolean");
  }
  requireValue(Number.isSafeInteger(profile.timeoutSeconds) && profile.timeoutSeconds > 0 && profile.timeoutSeconds <= 3600, "Set a reviewer timeout at most one hour");
  requireValue(/^\d{4,6}:\d{4,6}$/.test(profile.user), "Run the reviewer as an unprivileged uid:gid");
  requireValue(profile.reviewer?.requestModel === profile.gateway.requestModel, "Reviewer/gateway model mismatch");
  const instructions = [];
  if (layer === "thermo") {
    requireValue(profile.reviewer.instructions?.length > 0, "Snapshot the real Thermo instructions and skills first");
    requireValue(typeof profile.reviewer.deliveryInstructions === "string" && profile.reviewer.deliveryInstructions.trim(), "Missing local verdict delivery contract");
    requireValue(profile.reviewer.cliVersion && profile.reviewer.modelLimit?.context > 0 && profile.reviewer.modelLimit?.output > 0, "Pin the CLI version and model limits");
    if (profile.reviewer.maxSteps !== undefined) {
      requireValue(Number.isSafeInteger(profile.reviewer.maxSteps) && profile.reviewer.maxSteps > 0 && profile.gateway.maxRequests >= profile.reviewer.maxSteps + 3, "Reserve requests for the final response and auxiliary model after the agent step limit");
    }
    for (const path of profile.reviewer.instructions) {
      requireValue(typeof path === "string" && path.endsWith(".md"), "Instructions must name explicit Markdown files");
      instructions.push(await readFile(path, "utf8"));
    }
  } else {
    requireValue(layer === "triage" && profile.reviewer.settings && typeof profile.reviewer.settings === "object", "Missing triage settings snapshot");
  }
  const adapterFiles = ["gateway.py", "triage.py", "thermo.mjs"];
  const adapterDigest = digest(await Promise.all(adapterFiles.map((name) => readFile(`${adapterDir}/${name}`, "utf8"))));
  const reviewer = { ...profile.reviewer };
  if (layer === "thermo") {
    reviewer.instructions = instructions;
  }
  const frozen = { ...profile, reviewer, adapterDigest };
  return { frozen, pins: { reviewerRevision: profile.image, effectiveModel: profile.gateway.effectiveModel, configDigest: digest(frozen) } };
}

export async function configureStudy(study, execution) {
  const configured = structuredClone(study);
  for (const treatment of configured.treatments) {
    treatment.pins = {};
    for (const layer of configured.layers) {
      const { pins } = await freezeProfile(execution.profiles?.[`${layer}/${treatment.id}`], layer);
      treatment.pins[layer] = pins;
    }
  }
  return configured;
}
