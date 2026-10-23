import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

export const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
export const writeJson = async (path, value, mode = 0o600) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode });

/** Commands use argument arrays; provider credentials and raw stderr never enter an exception. */
export function command(program, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    const output = [];
    let bytes = 0;
    let exceeded = false;
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 32 * 1024 * 1024) {
        exceeded = true;
        child.kill("SIGKILL");
        return;
      }
      output.push(chunk);
    });
    child.stderr.resume();
    child.on("error", () => reject(new Error(`${program} could not start`)));
    child.on("close", (code, signal) => {
      if (code !== 0 || exceeded) {
        reject(new Error(`${program} failed (${signal ?? code}); raw stderr withheld`));
        return;
      }
      resolve(Buffer.concat(output).toString("utf8"));
    });
  });
}

export function git(repo, args) {
  return command("git", ["-c", `safe.directory=${repo}`, "-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", "-c", "protocol.file.allow=never", "-C", repo, ...args], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    timeout: 180_000,
  });
}
