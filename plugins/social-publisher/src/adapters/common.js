import { createHash } from "node:crypto";
import { isIP } from "node:net";

export class AdapterError extends Error {
  constructor(
    code,
    {
      status = null,
      retryable = false,
      needsReconciliation = false,
      retryAfterMs = null,
      checkpoint = null,
      providerCode = null,
    } = {},
  ) {
    super(code);
    this.name = "AdapterError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.needsReconciliation = needsReconciliation;
    this.retryAfterMs = retryAfterMs;
    this.checkpoint = checkpoint;
    this.providerCode = Number.isSafeInteger(providerCode) ? providerCode : null;
  }
}

export function composeText(content = {}) {
  const text = typeof content.text === "string" ? content.text : "";
  const link = typeof content.linkUrl === "string" ? content.linkUrl : "";
  if (!link || text.includes(link)) return text;
  return `${text}${text ? "\n" : ""}${link}`;
}

export function publicHttpsUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      (url.port && url.port !== "443")
    )
      return null;
    if (
      !host.includes(".") ||
      isIP(host.replace(/^\[|\]$/g, "")) ||
      /(^|\.)(localhost|local|internal|lan|test|invalid)$/.test(host)
    )
      return null;
    return url;
  } catch {
    return null;
  }
}

export function mediaItems(content = {}) {
  const urls = Array.isArray(content.mediaUrls) ? content.mediaUrls : [];
  return urls.map((url, index) => {
    const declared = content.mediaTypes?.[index] || content.mediaMimeTypes?.[index];
    let kind = "image";
    if (
      declared === "video" ||
      declared?.startsWith?.("video/") ||
      /\.(mp4|mov|webm)(?:\?|$)/i.test(url)
    )
      kind = "video";
    if (declared === "gif" || declared === "image/gif" || /\.gif(?:\?|$)/i.test(url)) kind = "gif";
    return { url, kind, altText: content.altTexts?.[index] || null };
  });
}

export function validateBase(content = {}, { maxChars, maxMedia, requireMedia = false } = {}) {
  const text = composeText(content);
  const errors = [];
  const media = mediaItems(content);
  if (text.length > maxChars)
    errors.push(`Post exceeds ${maxChars} characters limit (${text.length} chars)`);
  if (!text.trim() && !media.length) errors.push("A post must contain text or media");
  if (requireMedia && !media.length)
    errors.push("Instagram Professional API requires at least one image or video attachment");
  if (media.length > maxMedia) errors.push(`Post exceeds ${maxMedia} media attachments limit`);
  if (content.linkUrl && !publicHttpsUrl(content.linkUrl))
    errors.push("Link must use a public secure HTTPS URL");
  for (const [index, item] of media.entries()) {
    if (!publicHttpsUrl(item.url))
      errors.push(`Media item ${index + 1} must use a public secure HTTPS URL`);
  }
  return {
    valid: errors.length === 0,
    errors,
    charCount: text.length,
    maxChars,
    mediaCount: media.length,
  };
}

export function assertTrustedMedia(content, allowedHosts) {
  const items = mediaItems(content);
  if (!items.length) return;
  if (!Array.isArray(allowedHosts) || !allowedHosts.length)
    throw new AdapterError("media_host_allowlist_required");
  const hosts = allowedHosts.map((host) => (typeof host === "string" ? host.toLowerCase() : ""));
  for (const item of items) {
    const url = publicHttpsUrl(item.url);
    if (!url || !hosts.includes(url.hostname.toLowerCase()))
      throw new AdapterError("media_host_not_allowed");
  }
}

export function credentials(account, platform) {
  const accessToken = account?.credentials?.pageAccessToken || account?.credentials?.accessToken;
  const userId = account?.accountIdExternal;
  if (typeof accessToken !== "string" || !accessToken || typeof userId !== "string" || !userId)
    throw new AdapterError(`${platform}_credentials_missing`);
  return { accessToken, userId };
}

export function graphBase(platform, account = {}) {
  if (platform === "threads") return "https://graph.threads.net/v1.0";
  const version = account.graphApiVersion || account.credentials?.graphApiVersion || "v23.0";
  if (!/^v\d{2}\.\d+$/.test(version)) throw new AdapterError("invalid_graph_api_version");
  if (platform === "instagram") return `https://graph.instagram.com/${version}`;
  return `https://graph.facebook.com/${version}`;
}

export function retryDelay(response, now = Date.now()) {
  const retry = response.headers?.get?.("retry-after");
  if (retry) {
    const seconds = Number(retry);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 86_400_000);
    const date = Date.parse(retry);
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - now), 86_400_000);
  }
  const reset = Number(response.headers?.get?.("x-rate-limit-reset"));
  if (Number.isFinite(reset) && reset > 0)
    return Math.min(Math.max(0, reset * 1000 - now), 86_400_000);
  return 60_000;
}

export async function requestJson(
  url,
  {
    accessToken,
    method = "GET",
    form,
    json,
    body,
    fetchImpl = globalThis.fetch,
    timeoutMs = 30_000,
    publicWrite = false,
    emptyResponse = false,
    checkpoint = null,
  } = {},
) {
  const headers = { Authorization: `Bearer ${accessToken}` };
  let payload = body;
  if (form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    payload = new URLSearchParams(form).toString();
  }
  if (json) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(json);
  }
  const signal = AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, 60_000)));
  let response;
  try {
    response = await fetchImpl(url, { method, headers, body: payload, signal, redirect: "manual" });
  } catch {
    throw new AdapterError(publicWrite ? "publication_outcome_unknown" : "provider_network_error", {
      retryable: !publicWrite,
      needsReconciliation: publicWrite,
      checkpoint,
    });
  }
  let data;
  try {
    data = emptyResponse && response.status === 204 ? {} : await response.json();
  } catch {
    if (response.status === 429)
      throw new AdapterError("provider_rate_limited", {
        status: 429,
        retryable: true,
        retryAfterMs: retryDelay(response),
        checkpoint,
      });
    throw new AdapterError(
      publicWrite && response.ok ? "publication_outcome_unknown" : "provider_invalid_response",
      {
        status: response.status,
        retryable: !publicWrite && response.status >= 500,
        needsReconciliation: publicWrite && (response.ok || response.status >= 500),
        checkpoint,
      },
    );
  }
  const graphRateLimit = [4, 17, 32, 613].includes(Number(data?.error?.code));
  if (response.status === 429 || graphRateLimit)
    throw new AdapterError("provider_rate_limited", {
      status: response.status,
      retryable: true,
      retryAfterMs: retryDelay(response),
      checkpoint,
    });
  if (!response.ok || data?.error || (Array.isArray(data?.errors) && data.errors.length)) {
    throw new AdapterError("provider_request_rejected", {
      status: response.status,
      retryable: !publicWrite && response.status >= 500,
      needsReconciliation: publicWrite && (response.ok || response.status >= 500),
      checkpoint,
      providerCode: data?.error?.code,
    });
  }
  return data;
}

export function checkpointOf(platform, account, content, idempotencyKey, resume) {
  const base = {
    platform,
    accountExternalId: account.accountIdExternal,
    idempotencyKey: idempotencyKey || null,
    contentHash: createHash("sha256").update(JSON.stringify(content)).digest("hex"),
  };
  if (resume) {
    for (const key of Object.keys(base)) {
      if (resume[key] !== base[key]) throw new AdapterError("checkpoint_scope_mismatch");
    }
  }
  return { ...base, ...(resume || {}) };
}

export async function saveCheckpoint(checkpoint, callback) {
  if (typeof callback !== "function") throw new AdapterError("durable_checkpoint_required");
  try {
    await callback({ ...checkpoint });
  } catch {
    throw new AdapterError("checkpoint_persistence_failed", {
      needsReconciliation:
        checkpoint.publicationAttempted === true || Boolean(checkpoint.externalPostId),
      checkpoint,
    });
  }
}

export function requireId(value, checkpoint, publicWrite = false) {
  if (typeof value !== "string" || !value)
    throw new AdapterError(publicWrite ? "publication_outcome_unknown" : "provider_id_missing", {
      needsReconciliation: publicWrite,
      checkpoint,
    });
  return value;
}

export function providerPermalink(value, platform) {
  try {
    const url = new URL(value);
    const hosts = {
      instagram: ["instagram.com", "www.instagram.com"],
      threads: ["threads.net", "www.threads.net", "threads.com", "www.threads.com"],
      facebook_page: ["facebook.com", "www.facebook.com", "m.facebook.com"],
    };
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !hosts[platform]?.includes(url.hostname)
    )
      return null;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export async function readReceipt({
  platform,
  base,
  postId,
  accessToken,
  fetchImpl,
  timeoutMs,
  checkpoint,
}) {
  let data;
  try {
    data = await requestJson(
      `${base}/${encodeURIComponent(postId)}?fields=id,permalink${platform === "facebook_page" ? "_url" : ""}`,
      { accessToken, fetchImpl, timeoutMs, checkpoint },
    );
  } catch {
    throw new AdapterError("receipt_lookup_required", { needsReconciliation: true, checkpoint });
  }
  const link = providerPermalink(data.permalink || data.permalink_url, platform);
  if (!link)
    throw new AdapterError("receipt_lookup_required", { needsReconciliation: true, checkpoint });
  return {
    platform,
    platformPostId: postId,
    platformPostUrl: link,
    checkpoint,
    rawResponse: { id: postId, permalink: link },
  };
}

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
