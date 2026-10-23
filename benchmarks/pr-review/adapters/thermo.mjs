import { execFileSync, spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";

const config = JSON.parse(await readFile("/config/reviewer.json", "utf8"));
const pr = JSON.parse(await readFile("/work/pr/pr.json", "utf8"));
const home = "/tmp/benchmark-home";
await mkdir(home, { recursive: true });
const actualVersion = execFileSync("opencode", ["--version"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: home } }).trim();
if (actualVersion !== config.cliVersion) {
  throw new Error("OpenCode version differs from the frozen configuration");
}
const permissions = { "*": "deny", read: "allow", glob: "allow", grep: "allow", list: "allow", bash: "deny", webfetch: "deny", websearch: "deny", codesearch: "deny", edit: "deny", external_directory: { "*": "deny", "/work/pr/*": "allow", "/instructions/*": "allow" } };
const localConfig = {
  $schema: "https://opencode.ai/config.json",
  enabled_providers: ["benchmark"],
  small_model: `benchmark/${config.requestModel}`,
  provider: { benchmark: { npm: "@ai-sdk/openai-compatible", name: "Benchmark", options: { baseURL: "http://benchmark-gateway:8080/v1", apiKey: "benchmark-no-provider-key" }, models: { [config.requestModel]: { ...config.modelMetadata, name: config.requestModel, limit: config.modelLimit } } } },
  instructions: config.instructions.map((_, i) => `/instructions/${i}.md`),
  permission: permissions,
  agent: { review: { mode: "primary", description: "Frozen review replay", permission: permissions, steps: config.maxSteps } },
  share: "disabled", autoupdate: false,
};
await writeFile(`${home}/opencode.json`, JSON.stringify(localConfig));
const prompt = `${config.deliveryInstructions}\n\nReview the frozen PR ${pr.repo}#${pr.pr_number}, base ${pr.base}, head ${pr.head}.\nRead /work/pr/diff.patch and /work/pr/pr.json, then investigate the code in /work/repo.\nThe existing instructions and skills are mounted under /instructions. This is an isolated replay: return the final verdict block as your final response. Delivery to Paperclip/GitHub is replaced by this local response.\n`;
const args = ["run", "--pure", "--format", "json", "--agent", "review", "--model", `benchmark/${config.requestModel}`, "--dir", "/work/repo"];
if (config.variant) {
  args.push("--variant", config.variant);
}
args.push(prompt);
const child = spawn("opencode", args, { cwd: "/tmp", env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_CACHE_HOME: home, OPENCODE_CONFIG: `${home}/opencode.json`, OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_LSP_DOWNLOAD: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1" }, stdio: ["ignore", "pipe", "ignore"] });
let text = "";
let failed = false;
let buffer = "";
let bytes = 0;
let toolCalls = 0;
const toolTrace = [];
child.stdout.on("data", (chunk) => {
  bytes += chunk.length;
  if (bytes > 16 * 1024 * 1024) {
    failed = true;
    child.kill("SIGKILL");
    return;
  }
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop();
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type === "text" && typeof event.part?.text === "string") {
        text += event.part.text + "\n";
      }
      if (event.type === "tool_use") {
        toolCalls += 1;
        toolTrace.push({ tool: event.part?.tool, status: event.part?.state?.status, filePath: event.part?.state?.input?.filePath, truncated: event.part?.state?.metadata?.truncated, reachedEndOfFile: /\(End of file\b/.test(event.part?.state?.output ?? "") });
      }
      if (event.type === "error") {
        failed = true;
      }
    } catch {
      failed = true;
    }
  }
});
const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
if (code !== 0 || failed || !text.trim()) {
  throw new Error("Thermo replay produced no valid response");
}
await writeFile("/out/review.json", JSON.stringify(text));
let coverage = "unknown";
if (toolTrace.some((item) => item.tool === "read" && item.status === "completed")) {
  coverage = "partial";
}
if (toolTrace.some((item) => item.filePath === "/work/pr/diff.patch" && item.status === "completed" && item.truncated === false && item.reachedEndOfFile)) {
  coverage = "complete";
}
await writeFile("/out/adapter.json", JSON.stringify({ coverage, coverageEvidence: { toolCalls, toolTrace, instructionsLoaded: config.instructions.length, cliVersion: actualVersion } }));
