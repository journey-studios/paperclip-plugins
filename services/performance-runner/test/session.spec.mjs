import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import session from "../src/session.cjs";
test("cookie selection respects host boundaries", () => {
  const input = [{ domain: "dash.tessel.app" }, { domain: ".tessel.app" }, { domain: "other.tessel.app" }, { domain: "tessel.app.evil.test" }];
  assert.equal(session.cookiesForHost(input, "dash.tessel.app").length, 2);
});
test("persist renewed credentials atomically without keeping unrelated browser storage", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "session-spec-"));
  const file = path.join(directory, "storage-state.json");
  try {
    const browser = { cookies: async () => [{ name: "session", value: "new-refresh-value", domain: "dash.tessel.app", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }] };
    const page = { isClosed: () => false, url: () => "https://dash.tessel.app/chat", evaluate: async () => [{ name: "sb-session", value: "renewed" }] };
    await session.saveSession(browser, page, "https://dash.tessel.app", file);
    const stored = JSON.parse(await fs.readFile(file, "utf8"));
    assert.equal(stored.cookies[0].value, "new-refresh-value");
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    await session.saveSession({ cookies: async () => [{ ...stored.cookies[0], value: "next-refresh-value" }] }, null, "https://dash.tessel.app", file);
    assert.equal(JSON.parse(await fs.readFile(file, "utf8")).cookies[0].value, "next-refresh-value");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
