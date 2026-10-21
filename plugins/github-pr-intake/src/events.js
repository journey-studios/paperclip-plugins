import { headerValue } from "./signature.js";

/** Shared by webhook payloads and REST responses: both use the same pull request shape. */
export function normalizePull(repoFullName, pull) {
  const login = String(pull?.user?.login ?? "");
  return {
    repo: repoFullName,
    number: Number(pull?.number),
    title: String(pull?.title ?? ""),
    url: String(pull?.html_url ?? `https://github.com/${repoFullName}/pull/${pull?.number}`),
    state: pull?.state === "closed" || pull?.merged || pull?.merged_at ? "closed" : "open",
    merged: Boolean(pull?.merged || pull?.merged_at),
    draft: Boolean(pull?.draft),
    author: { login, isBot: pull?.user?.type === "Bot" || login.endsWith("[bot]") },
    headSha: String(pull?.head?.sha ?? ""),
    headRef: String(pull?.head?.ref ?? ""),
    baseSha: String(pull?.base?.sha ?? ""),
    baseRef: String(pull?.base?.ref ?? ""),
    labels: (pull?.labels ?? []).map((label) => (typeof label === "string" ? label : label?.name)).filter(Boolean),
  };
}

function parseBody({ parsedBody, rawBody }) {
  if (parsedBody && typeof parsedBody === "object") return parsedBody;
  try {
    return JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody ?? ""));
  } catch {
    return null;
  }
}

/** @returns {{ kind: "ping"|"pull_request"|"ignored", deliveryId?: string, action?: string, repo?: string, pull?: object }} */
export function normalizeWebhook(input) {
  const event = headerValue(input.headers, "x-github-event");
  const deliveryId = headerValue(input.headers, "x-github-delivery");
  if (event === "ping") return { kind: "ping", deliveryId };
  if (event !== "pull_request") return { kind: "ignored", deliveryId };
  const body = parseBody(input);
  const repo = body?.repository?.full_name;
  if (!body?.pull_request || typeof repo !== "string") return { kind: "ignored", deliveryId };
  return {
    kind: "pull_request",
    deliveryId,
    action: String(body.action ?? ""),
    repo,
    pull: normalizePull(repo, body.pull_request),
  };
}
