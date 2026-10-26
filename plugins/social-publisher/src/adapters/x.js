import { readSocialMetrics } from "./metrics-read.js";
import {
  AdapterError,
  assertTrustedMedia,
  checkpointOf,
  credentials,
  mediaItems,
  requestJson,
  requireId,
  saveCheckpoint,
  composeText,
  validateBase,
} from "./common.js";

const X_API_BASE = "https://api.x.com/2";
const MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4"]);

// X counts links at the t.co length and non-Latin/emoji characters at weight two.
export function weightedTextLength(text) {
  let result = 0;
  const urls = /https?:\/\/[^\s]+/gu;
  let offset = 0;
  const countText = (value) => {
    let count = 0;
    for (const { segment } of new Intl.Segmenter("en", { granularity: "grapheme" }).segment(
      value,
    )) {
      if (/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(segment)) {
        count += 2;
        continue;
      }
      for (const char of segment) {
        const point = char.codePointAt(0);
        count +=
          point <= 0x10ff ||
          (point >= 0x2000 && point <= 0x200d) ||
          (point >= 0x2010 && point <= 0x201f) ||
          (point >= 0x2032 && point <= 0x2037)
            ? 1
            : 2;
      }
    }
    return count;
  };
  for (const match of text.matchAll(urls)) {
    result += countText(text.slice(offset, match.index));
    const punctuation = match[0].match(/[.,!?;:)]+$/u)?.[0] || "";
    result += 23 + countText(punctuation);
    offset = match.index + match[0].length;
  }
  return result + countText(text.slice(offset));
}

async function downloadMedia(url, options) {
  const maxBytes = Math.min(options.maxMediaBytes ?? 5 * 1024 * 1024, 50 * 1024 * 1024);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new AdapterError("invalid_media_size_limit");
  let response;
  try {
    response = await (options.mediaFetch || options.fetchImpl || globalThis.fetch)(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs || 30_000),
    });
  } catch {
    throw new AdapterError("media_download_failed", { retryable: true });
  }
  if (!response.ok || response.status >= 300)
    throw new AdapterError("media_download_rejected", { status: response.status });
  const mimeType = response.headers.get("content-type")?.split(";")[0].toLowerCase();
  if (!MIME_TYPES.has(mimeType)) throw new AdapterError("media_type_not_supported");
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) throw new AdapterError("media_size_exceeded");
  const reader = response.body?.getReader();
  if (!reader && typeof response.arrayBuffer === "function") {
    let bytes;
    try {
      bytes = await response.arrayBuffer();
    } catch {
      throw new AdapterError("media_download_failed", { retryable: true });
    }
    if (!bytes.byteLength) throw new AdapterError("media_empty");
    if (bytes.byteLength > maxBytes) throw new AdapterError("media_size_exceeded");
    return { blob: new Blob([bytes], { type: mimeType }), mimeType, size: bytes.byteLength };
  }
  if (!reader) throw new AdapterError("media_stream_required");
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new AdapterError("media_size_exceeded");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    throw new AdapterError("media_download_failed", { retryable: true });
  }
  if (!size) throw new AdapterError("media_empty");
  return { blob: new Blob(chunks, { type: mimeType }), mimeType, size };
}

async function checkMediaProcessing(mediaId, processing, options, accessToken, checkpoint) {
  if (!processing || processing.state === "succeeded") return;
  if (processing.state === "failed")
    throw new AdapterError("media_processing_failed", { checkpoint });
  const data = await requestJson(
    `${X_API_BASE}/media/upload?media_id=${encodeURIComponent(mediaId)}`,
    { ...options, accessToken, checkpoint },
  );
  const status = data.data?.processing_info;
  if (status?.state === "failed") throw new AdapterError("media_processing_failed", { checkpoint });
  if (status?.state === "succeeded") return;
  throw new AdapterError("media_processing", {
    retryable: true,
    retryAfterMs: Math.max(
      1_000,
      Math.min((status?.check_after_secs || processing.check_after_secs || 60) * 1_000, 300_000),
    ),
    checkpoint,
  });
}

async function uploadMedia(index, media, options, accessToken, checkpoint) {
  const stored = checkpoint.media?.[index];
  if (stored?.id) {
    await checkMediaProcessing(stored.id, stored.processing, options, accessToken, checkpoint);
    return stored.id;
  }
  const downloaded = await downloadMedia(media.url, options);
  const category = downloaded.mimeType.startsWith("video/")
    ? "tweet_video"
    : downloaded.mimeType === "image/gif"
      ? "tweet_gif"
      : "tweet_image";
  let data;
  if (category === "tweet_image") {
    const mediaBase64 = Buffer.from(await downloaded.blob.arrayBuffer()).toString("base64");
    data = await requestJson(`${X_API_BASE}/media/upload`, {
      ...options,
      accessToken,
      method: "POST",
      json: { media: mediaBase64, media_category: category },
      checkpoint,
    });
  } else {
    const initialized = await requestJson(`${X_API_BASE}/media/upload/initialize`, {
      ...options,
      accessToken,
      method: "POST",
      json: {
        media_type: downloaded.mimeType,
        total_bytes: downloaded.size,
        media_category: category,
      },
      checkpoint,
    });
    const mediaId = requireId(initialized.data?.id || initialized.media_id, checkpoint);
    for (let start = 0, segment = 0; start < downloaded.size; start += 1024 * 1024, segment++) {
      const mediaBase64 = Buffer.from(
        await downloaded.blob.slice(start, start + 1024 * 1024).arrayBuffer(),
      ).toString("base64");
      await requestJson(`${X_API_BASE}/media/upload/${encodeURIComponent(mediaId)}/append`, {
        ...options,
        accessToken,
        method: "POST",
        json: { media: mediaBase64, segment_index: segment },
        emptyResponse: true,
        checkpoint,
      });
    }
    data = await requestJson(`${X_API_BASE}/media/upload/${encodeURIComponent(mediaId)}/finalize`, {
      ...options,
      accessToken,
      method: "POST",
      checkpoint,
    });
    if (!data.data?.id) data.data = { ...data.data, id: mediaId };
  }
  const mediaId = requireId(data.data?.id, checkpoint);
  checkpoint.media ||= [];
  checkpoint.media[index] = { id: mediaId, processing: data.data?.processing_info || null };
  await saveCheckpoint(checkpoint, options.onCheckpoint);
  await checkMediaProcessing(mediaId, data.data?.processing_info, options, accessToken, checkpoint);
  return mediaId;
}

function receipt(postId, checkpoint) {
  return {
    platform: "x",
    platformPostId: postId,
    platformPostUrl: `https://x.com/i/web/status/${encodeURIComponent(postId)}`,
    checkpoint,
    rawResponse: { id: postId },
  };
}

export class XAdapter {
  constructor() {
    this.platform = "x";
  }
  async readMetrics(options) {
    return readSocialMetrics(this.platform, options);
  }
  validate(content = {}) {
    const result = validateBase(content, { maxChars: Number.MAX_SAFE_INTEGER, maxMedia: 4 });
    const length = weightedTextLength(composeText(content));
    const media = mediaItems(content);
    result.charCount = length;
    result.maxChars = 280;
    if (length > 280)
      result.errors.push(
        `X / Twitter post exceeds 280 characters weighted limit (${length} chars)`,
      );
    if (media.length > 1 && media.some((item) => item.kind !== "image"))
      result.errors.push("X allows one video/GIF or up to four static images");
    result.valid = result.errors.length === 0;
    return result;
  }
  preview(content = {}) {
    const validation = this.validate(content);
    return {
      platform: this.platform,
      text: composeText(content),
      mediaUrls: content.mediaUrls || [],
      ...validation,
      remainingChars: 280 - validation.charCount,
    };
  }
  async publish(options) {
    const { account, content, idempotencyKey, onCheckpoint, resume } = options;
    if (!this.validate(content).valid) throw new AdapterError("x_content_invalid");
    if (options.apiCostApproved !== true && account.apiCostApproved !== true)
      throw new AdapterError("x_api_cost_approval_required");
    assertTrustedMedia(content, options.mediaAllowedHosts || account.mediaAllowedHosts);
    const { accessToken } = credentials(account, this.platform);
    const checkpoint = checkpointOf(this.platform, account, content, idempotencyKey, resume);
    if (checkpoint.externalPostId) return receipt(checkpoint.externalPostId, checkpoint);
    if (checkpoint.publicationAttempted)
      throw new AdapterError("publication_outcome_unknown", {
        needsReconciliation: true,
        checkpoint,
      });
    const media = mediaItems(content);
    const mediaIds = [];
    for (let index = 0; index < media.length; index++)
      mediaIds.push(await uploadMedia(index, media[index], options, accessToken, checkpoint));
    const json = { text: composeText(content) };
    if (mediaIds.length) json.media = { media_ids: mediaIds };
    if (content.replyToPostId) json.reply = { in_reply_to_tweet_id: content.replyToPostId };
    checkpoint.publicationAttempted = true;
    await saveCheckpoint(checkpoint, onCheckpoint);
    let published;
    try {
      published = await requestJson(`${X_API_BASE}/tweets`, {
        ...options,
        accessToken,
        method: "POST",
        json,
        publicWrite: true,
        checkpoint,
      });
    } catch (error) {
      if (error instanceof AdapterError && !error.needsReconciliation) {
        checkpoint.publicationAttempted = false;
        await saveCheckpoint(checkpoint, onCheckpoint);
        error.checkpoint = { ...checkpoint };
      }
      throw error;
    }
    checkpoint.externalPostId = requireId(published.data?.id, checkpoint, true);
    await saveCheckpoint(checkpoint, onCheckpoint);
    return receipt(checkpoint.externalPostId, checkpoint);
  }
  async reconcile(options) {
    const checkpoint = options.resume || options.checkpoint;
    if (!checkpoint?.externalPostId) return null;
    const scoped = checkpointOf(
      this.platform,
      options.account,
      options.content,
      options.idempotencyKey,
      checkpoint,
    );
    const { accessToken } = credentials(options.account, this.platform);
    const data = await requestJson(
      `${X_API_BASE}/tweets/${encodeURIComponent(scoped.externalPostId)}?tweet.fields=author_id`,
      { ...options, accessToken, checkpoint: scoped },
    );
    if (
      data.data?.id !== scoped.externalPostId ||
      data.data?.author_id !== options.account.accountIdExternal
    )
      return null;
    return { ...receipt(scoped.externalPostId, scoped), reconciled: true };
  }
}
