#!/usr/bin/env node
import { randomUUID } from "node:crypto";
const extra = process.argv.slice(2);
const command = extra.shift();
let argument;
if (extra[0] && !extra[0].startsWith("--")) argument = extra.shift();
const flags = new Map();
while (extra.length) {
  const key = extra.shift();
  const value = extra.shift();
  if (command !== "runs" || !["--before", "--before-id", "--limit", "--environment"].includes(key) || !value) {
    process.stderr.write("Invalid list option. Use --before TIME --before-id ID --limit N --environment ENV.\n");
    process.exit(1);
  }
  flags.set(key, value);
}
const origin = process.env.PAPERCLIP_API_URL;
const token = process.env.PAPERCLIP_API_KEY;
const companyId = process.env.PAPERCLIP_COMPANY_ID;
if (!origin || !token || !companyId) {
  process.stderr.write("Set PAPERCLIP_API_URL, PAPERCLIP_API_KEY and PAPERCLIP_COMPANY_ID through your secret manager.\n");
  process.exit(1);
}
let path;
let method = "GET";
let body;
if (command === "targets") path = "/targets";
if (command === "runs") path = "/runs";
if (command === "show" && argument) path = `/runs/${encodeURIComponent(argument)}`;
if (command === "review" && argument) {
  path = "/reviews"; method = "POST";
  body = JSON.stringify({ targetKey: argument, requestKey: process.env.PERFORMANCE_REQUEST_KEY || randomUUID() });
}
if (!path) { process.stderr.write("Usage: performance targets | review TARGET | runs [TARGET] | show RUN_ID\n"); process.exit(1); }
const url = new URL(`/api/plugins/journey-studios.performance-observatory/api${path}`, origin);
url.searchParams.set("companyId", companyId);
if (command === "runs" && argument) url.searchParams.set("targetKey", argument);
for (const [flag, field] of [["--before", "before"], ["--before-id", "beforeId"], ["--limit", "limit"], ["--environment", "environment"]]) {
  if (flags.has(flag)) url.searchParams.set(field, flags.get(flag));
}
try {
  const response = await fetch(url, { method, body, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  process.stdout.write(JSON.stringify(await response.json(), null, 2) + "\n");
} catch (error) {
  let message = "REQUEST_FAILED";
  if (error instanceof Error && /^HTTP_[0-9]+$/.test(error.message)) message = error.message;
  process.stderr.write(message + "\n"); process.exitCode = 1;
}
