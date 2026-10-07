const REDACTED = "[REDACTED]";
const OMITTED = "[OMITTED]";
const TRUNCATED = "[TRUNCATED]";

const SENSITIVE_KEY = /(?:^|[_-])(?:token|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth(?:orization)?|cookie|password|passwd|secret|credential|private[_-]?key|client[_-]?secret)(?:$|[_-])/i;
const OMIT_KEY = /(?:^|[_-])(?:prompt(?:_?template)?|system_?prompt|developer_?prompt|bootstrap_?prompt|cwd|working_?directory|instructions_?file_?path)(?:$|[_-])/i;
const ENV_KEY = /^(?:env|env_?vars|env_?variables|environment|environment_?vars|environment_?variables)$/i;
const MAX_SNAPSHOT_BYTES = 24_000;

function normalizedKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(normalizedKey(key));
}

function isOmittedKey(key: string): boolean {
  return OMIT_KEY.test(normalizedKey(key));
}

function redactText(input: string): string {
  return input
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gi, REDACTED)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,}|sk-(?:proj-)?[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{16})\b/g, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s:]+(?::[^/@\s]*)?@/gi, `$1${REDACTED}@`)
    .replace(/([?&](?:token|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|password|authorization)=)[^&#\s]+/gi, `$1${REDACTED}`)
    .replace(/((?:^|[\s,{])(?:["']?(?:token|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|cookie|password|passwd|secret|credential|private[_-]?key|client[_-]?(?:secret|password|token|key))["']?)\s*[:=]\s*)(?:"([^"\n]*)"|'([^'\n]*)'|([^,\n;}&]+))/gim, `$1${REDACTED}`)
    .replace(/(^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*).+$/gm, `$1${REDACTED}`)
    .replace(/(\s--(?:api[-_]?key|token|password|secret|authorization)\s+)(?:"[^"]*"|'[^']*'|\S+)/gi, `$1${REDACTED}`)
    .replace(/(\s--(?:api[-_]?key|token|password|secret|authorization)=)(?:"[^"]*"|'[^']*'|\S+)/gi, `$1${REDACTED}`)
    .replace(/(Authorization\s*:\s*)(?:Bearer\s+)?[^\s,;]+/gi, `$1${REDACTED}`);
}

/** Redact common credentials in useful instruction text, keeping Markdown readable. */
export function sanitizeTextSnapshot(text: string, maxChars = 24_000): string {
  const limit = Math.max(0, Math.min(Math.floor(maxChars), 24_000));
  if (!limit) return text.length ? TRUNCATED : "";
  const wasTruncated = text.length > limit;
  let bounded = wasTruncated ? text.slice(0, limit) : text;
  if (wasTruncated) {
    // Drop the last partial line so truncation cannot cut through a value before redaction.
    const lastLine = bounded.lastIndexOf("\n");
    bounded = lastLine >= 0 ? bounded.slice(0, lastLine) : "";
  }
  const safe = redactText(bounded);
  return wasTruncated ? `${safe}${safe ? "\n" : ""}${TRUNCATED}` : safe;
}

/**
 * Produce a bounded JSON-compatible snapshot. Prompt bodies and path-bearing
 * runtime settings are omitted; every environment value is redacted, and known
 * secret fields/patterns are removed from all remaining strings.
 */
export function sanitizeSnapshot(value: unknown): unknown {
  const seen = new WeakSet<object>();
  let nodes = 0;
  let truncated = false;
  // Reserve room for root braces and the visible truncation marker.
  let remainingBytes = MAX_SNAPSHOT_BYTES - 256;
  const noSpace = Symbol("no snapshot space");
  const encoder = new TextEncoder();

  function jsonBytes(item: unknown): number {
    return encoder.encode(JSON.stringify(item) ?? "null").byteLength;
  }

  function spend(size: number): boolean {
    if (size > remainingBytes) return false;
    remainingBytes -= size;
    return true;
  }

  function visit(current: unknown, key = "", depth = 0): unknown | typeof noSpace {
    nodes += 1;
    if (nodes > 1_000 || depth > 24) {
      truncated = true;
      return noSpace;
    }
    if (isOmittedKey(key)) return spend(jsonBytes(OMITTED)) ? OMITTED : noSpace;
    if (isSensitiveKey(key)) return spend(jsonBytes(REDACTED)) ? REDACTED : noSpace;
    if (ENV_KEY.test(normalizedKey(key)) && (!current || typeof current !== "object" || Array.isArray(current))) {
      return spend(jsonBytes(REDACTED)) ? REDACTED : noSpace;
    }
    if (typeof current === "string") {
      const isInstructionText = /^(?:markdown|content|skilltext)$/i.test(normalizedKey(key));
      let limit = Math.min(isInstructionText ? MAX_SNAPSHOT_BYTES : 4_000, remainingBytes);
      while (limit > 0) {
        const safe = sanitizeTextSnapshot(current, limit);
        const size = jsonBytes(safe);
        if (size <= remainingBytes && spend(size)) {
          if (current.length > limit || safe.endsWith(TRUNCATED)) truncated = true;
          return safe;
        }
        limit = Math.floor(limit * 0.7);
      }
      truncated = true;
      return noSpace;
    }
    if (current === null || typeof current === "boolean" || typeof current === "number") {
      const safe = typeof current === "number" && !Number.isFinite(current) ? null : current;
      return spend(jsonBytes(safe)) ? safe : noSpace;
    }
    if (Array.isArray(current)) {
      if (seen.has(current)) {
        truncated = true;
        return spend(jsonBytes(TRUNCATED)) ? TRUNCATED : noSpace;
      }
      seen.add(current);
      if (!spend(2)) return noSpace;
      const out: unknown[] = [];
      for (const item of current.slice(0, 100)) {
        const separatorBytes = out.length ? 1 : 0;
        if (remainingBytes <= separatorBytes) {
          truncated = true;
          break;
        }
        remainingBytes -= separatorBytes;
        const child = visit(item, "", depth + 1);
        if (child === noSpace) {
          if (separatorBytes) remainingBytes += separatorBytes;
          truncated = true;
          break;
        }
        out.push(child);
      }
      if (current.length > 100) truncated = true;
      return out;
    }
    if (current && typeof current === "object") {
      if (seen.has(current)) {
        truncated = true;
        return spend(jsonBytes(TRUNCATED)) ? TRUNCATED : noSpace;
      }
      seen.add(current);
      if (!spend(2)) return noSpace;
      const out: Record<string, unknown> = {};
      const environment = ENV_KEY.test(normalizedKey(key));
      const entries = Object.entries(current as Record<string, unknown>).slice(0, 200);
      for (const [childKey, childValue] of entries) {
        if (childKey.length > 256) {
          truncated = true;
          continue;
        }
        const safeKeyBytes = jsonBytes(childKey) + 1 + (Object.keys(out).length ? 1 : 0);
        if (safeKeyBytes + 2 > remainingBytes) {
          truncated = true;
          break;
        }
        remainingBytes -= safeKeyBytes;
        const child = environment
          ? (spend(jsonBytes(REDACTED)) ? REDACTED : noSpace)
          : visit(childValue, childKey, depth + 1);
        if (child === noSpace) {
          remainingBytes += safeKeyBytes;
          truncated = true;
          break;
        }
        out[childKey] = child;
      }
      if (Object.keys(current as Record<string, unknown>).length > 200) truncated = true;
      return out;
    }
    return spend(jsonBytes(null)) ? null : noSpace;
  }

  let safe = visit(value);
  if (safe === noSpace) {
    truncated = true;
    safe = {};
  }
  if (truncated) {
    const marker = { truncated: true, reason: "safety_bound" };
    if (safe && typeof safe === "object" && !Array.isArray(safe)) {
      (safe as Record<string, unknown>)._evolutionSnapshotSafety = marker;
    } else {
      safe = { value: safe, _evolutionSnapshotSafety: marker };
    }
  }
  return safe;
}
