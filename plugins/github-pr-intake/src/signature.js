import { createHmac, timingSafeEqual } from "node:crypto";

export function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

/**
 * Verifies GitHub's X-Hub-Signature-256 over the exact bytes received.
 * The host does not verify webhook signatures, so this is the only gate.
 */
export function verifyGithubSignature(rawBody, signatureHeader, secret) {
  if (typeof secret !== "string" || secret.length === 0) return false;
  if (typeof signatureHeader !== "string" || !signatureHeader.startsWith("sha256=")) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ""), "utf8");
  const expected = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(signatureHeader.slice("sha256=".length), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
