import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";
import { targetOf, validateResult } from "../../../plugins/performance-observatory/src/contract.js";
import { sampleOf } from "./metrics.mjs";
import session from "./session.cjs";
const exec = promisify(execFile);
process.umask(0o077);
const base = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(base);
const request = JSON.parse(await fs.readFile("/job/request.json", "utf8"));
let scratch;
let stage = "initialization";
async function captureFailure(error) {
  const lines = `${error?.stderr || ""}\n${error?.stdout || ""}`.split("\n")
    .map((line) => line.trim()).filter((line) => /^(Error|TypeError|SyntaxError|ProtocolError|TimeoutError):/.test(line))
    .slice(0, 3).map((line) => line.replace(/https?:\/\/\S+/g, "[URL]").replace(/(?:eyJ|sbp_|sb_secret_|sb_publishable_)[A-Za-z0-9._-]+/g, "[REDACTED]").slice(0, 400));
  await fs.writeFile("/job/diagnostics.json", JSON.stringify({ stage, name: error?.name, code: error?.code ?? error?.cause?.code, lines }), { mode: 0o600 });
}
async function anchor(target) {
  let headers = { accept: "application/json", "cache-control": "no-cache" };
  if (target.authProfile !== "public") {
    const { cookies = [] } = JSON.parse(await fs.readFile("/auth/storage-state.json", "utf8"));
    const hostname = new URL(target.url).hostname;
    const cookie = session.cookiesForHost(cookies, hostname)
      .map((c) => `${c.name}=${c.value}`).join("; ");
    headers = { ...headers, cookie };
  }
  const response = await fetch(new URL("/version.json", target.url), { headers, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error("BUILD_ANCHOR_UNAVAILABLE");
  const value = (await response.json()).buildId;
  if (typeof value !== "string" || !/^[a-zA-Z0-9_.-]{1,80}$/.test(value)) throw new Error("BUILD_ANCHOR_INVALID");
  return value;
}
async function main() {
  const target = targetOf(request.target);
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "performance-"));
  process.env.HOME = scratch;
  process.env.XDG_CONFIG_HOME = scratch;
  process.env.XDG_CACHE_HOME = scratch;
  const chromeVersion = (await exec(process.env.CHROME_PATH, ["--version"])).stdout.trim();
  const samples = [];
  stage = "build-anchor";
  const initialBuild = await anchor(target);
  let noSessionControlPassed = false;
  if (target.authProfile !== "public") {
    stage = "negative-control";
    const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    try {
      const page = await browser.newPage();
      await page.goto(target.url, { waitUntil: "networkidle2", timeout: 60000 });
      noSessionControlPassed = /\/(login|signin|auth)(\/|$)/.test(new URL(page.url()).pathname);
      if (!noSessionControlPassed) throw new Error("NO_SESSION_CONTROL_FAILED");
    } finally { await browser.close(); }
  }
  for (const cache of ["cold", "warm"]) {
    for (let index = 1; index <= 3; index++) {
      const cwd = path.join(scratch, `${cache}-${index}`);
      await fs.mkdir(cwd, { mode: 0o700 });
      // LHCI 0.15 joins this path to the collection CWD, including absolute paths.
      await fs.copyFile(path.join(base, "prepare.cjs"), path.join(cwd, "prepare.cjs"));
      await fs.copyFile(path.join(base, "session.cjs"), path.join(cwd, "session.cjs"));
      const proofFile = path.join(cwd, "proof.json");
      const inputFile = path.join(cwd, "input.json");
      await fs.writeFile(inputFile, JSON.stringify({ target, cache, proofFile }), { mode: 0o600 });
      const desktop = target.profile === "desktop";
      let settings = { onlyCategories: ["performance"], disableStorageReset: true, maxWaitForLoad: 60000 };
      if (desktop) settings = { ...settings, formFactor: "desktop", screenEmulation: { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false }, throttling: { cpuSlowdownMultiplier: 1 } };
      const config = { ci: { collect: { url: [target.url], numberOfRuns: 1, chromePath: process.env.CHROME_PATH,
        puppeteerScript: "prepare.cjs",
        puppeteerLaunchOptions: { headless: true, executablePath: process.env.CHROME_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage"] }, settings },
        assert: { assertions: { "categories:performance": ["warn", { minScore: cache === "warm" ? 0.94 : 0.7 }] } } } };
      const configFile = path.join(cwd, "lighthouserc.json");
      await fs.writeFile(configFile, JSON.stringify(config));
      const before = await anchor(target);
      if (before !== initialBuild) throw new Error("BUILD_CHANGED");
      const cli = path.join(root, "node_modules/@lhci/cli/src/cli.js");
      const env = { ...process.env, HOME: scratch, XDG_CONFIG_HOME: scratch, XDG_CACHE_HOME: scratch, PERFORMANCE_REQUEST_FILE: inputFile };
      try {
        stage = "lhci-collect";
        await exec(process.execPath, [cli, "collect", `--config=${configFile}`], { cwd, env, timeout: 180000, maxBuffer: 1024 * 1024 });
      } catch (error) { await captureFailure(error); throw new Error("LHCI_COLLECT_FAILED"); }
      stage = "evidence-validation";
      const directory = path.join(cwd, ".lighthouseci");
      const files = (await fs.readdir(directory)).filter((file) => /^lhr-.*\.json$/.test(file));
      if (files.length !== 1) throw new Error("COHORT_INCOMPLETE");
      const lhr = JSON.parse(await fs.readFile(path.join(directory, files[0]), "utf8"));
      const proof = JSON.parse(await fs.readFile(proofFile, "utf8"));
      const after = await anchor(target);
      samples.push(sampleOf(lhr, proof, target, before, after, cache, index));
      // LHCI asserts locally. No upload command or public report endpoint is used.
      stage = "lhci-assert";
      await exec(process.execPath, [cli, "assert", `--config=${configFile}`], { cwd, env, timeout: 30000, maxBuffer: 1024 * 1024 });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  }
  const result = { schema: "performance-review.v1", targetKey: target.key, environment: target.environment,
    scenario: target.scenario, profile: target.profile, lighthouseVersion: "13.4.1", chromeVersion, samples, noSessionControlPassed };
  validateResult(result, target);
  return result;
}
let output;
try { output = { ok: true, result: await main() }; }
catch (error) {
  let errorCode = "COLLECTION_FAILED";
  if (error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message)) errorCode = error.message;
  output = { ok: false, errorCode };
} finally {
  if (scratch) await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
}
await fs.writeFile("/job/result.tmp", JSON.stringify(output), { mode: 0o600 });
await fs.rename("/job/result.tmp", "/job/result.json");
