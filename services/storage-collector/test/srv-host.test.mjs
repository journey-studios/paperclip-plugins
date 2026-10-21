import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseDirectoryConfig } from "../src/lib.mjs";

test("the /srv host directories file passes the collector's own validation", async () => {
  const text = await readFile(new URL("../systemd/srv-directories.json", import.meta.url), "utf8");
  const directories = parseDirectoryConfig(text);
  assert.ok(directories.length >= 1);
  assert.ok(directories.every((dir) => dir.path.startsWith("/srv") || dir.path.startsWith("/var/lib") || dir.path === "/root"));
});
