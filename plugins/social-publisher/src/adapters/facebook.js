import { readSocialMetrics } from "./metrics-read.js";
import {
  AdapterError,
  assertTrustedMedia,
  checkpointOf,
  credentials,
  graphBase,
  mediaItems,
  requestJson,
  requireId,
  saveCheckpoint,
  readReceipt,
  composeText,
  validateBase,
} from "./common.js";

export class FacebookPageAdapter {
  constructor() {
    this.platform = "facebook_page";
  }
  async readMetrics(options) {
    return readSocialMetrics(this.platform, options);
  }
  validate(content = {}) {
    const result = validateBase(content, { maxChars: 63206, maxMedia: 10 });
    const media = mediaItems(content);
    if (media.length > 1 && media.some((item) => item.kind === "video"))
      result.errors.push("Facebook publishing accepts one video or a static photo collection");
    if (media.some((item) => item.kind === "gif"))
      result.errors.push("Facebook Page photo publishing requires static images");
    result.valid = result.errors.length === 0;
    return result;
  }
  preview(content = {}) {
    return {
      platform: this.platform,
      message: composeText(content),
      mediaUrls: content.mediaUrls || [],
      linkUrl: content.linkUrl || null,
      ...this.validate(content),
    };
  }
  async publish(options) {
    const { account, content, idempotencyKey, onCheckpoint, resume } = options;
    if (!this.validate(content).valid) throw new AdapterError("facebook_content_invalid");
    assertTrustedMedia(content, options.mediaAllowedHosts || account.mediaAllowedHosts);
    const { accessToken, userId } = credentials(account, this.platform);
    const base = graphBase(this.platform, account);
    const checkpoint = checkpointOf(this.platform, account, content, idempotencyKey, resume);
    if (checkpoint.externalPostId)
      return readReceipt({
        ...options,
        platform: this.platform,
        base,
        postId: checkpoint.externalPostId,
        accessToken,
        checkpoint,
      });
    if (checkpoint.publicationAttempted)
      throw new AdapterError("publication_outcome_unknown", {
        needsReconciliation: true,
        checkpoint,
      });
    const media = mediaItems(content);
    checkpoint.photoIds ||= [];
    // Unpublished photo uploads are harmless to repeat; each returned id is checkpointed before the feed write.
    for (let index = 0; index < media.length; index++) {
      if (media[index].kind === "video") continue;
      if (checkpoint.photoIds[index]) continue;
      const photo = await requestJson(`${base}/${encodeURIComponent(userId)}/photos`, {
        ...options,
        accessToken,
        method: "POST",
        form: { url: media[index].url, published: "false" },
        checkpoint,
      });
      checkpoint.photoIds[index] = requireId(photo.id, checkpoint);
      await saveCheckpoint(checkpoint, onCheckpoint);
    }
    const video = media[0]?.kind === "video";
    const form = video
      ? { description: composeText(content), file_url: media[0].url }
      : { message: composeText(content) };
    if (checkpoint.photoIds.length)
      form.attached_media = JSON.stringify(
        checkpoint.photoIds.map((media_fbid) => ({ media_fbid })),
      );
    if (!media.length && content.linkUrl) form.link = content.linkUrl;
    checkpoint.publicationAttempted = true;
    await saveCheckpoint(checkpoint, onCheckpoint);
    let published;
    try {
      published = await requestJson(
        `${base}/${encodeURIComponent(userId)}/${video ? "videos" : "feed"}`,
        { ...options, accessToken, method: "POST", form, publicWrite: true, checkpoint },
      );
    } catch (error) {
      if (error instanceof AdapterError && !error.needsReconciliation) {
        checkpoint.publicationAttempted = false;
        await saveCheckpoint(checkpoint, onCheckpoint);
        error.checkpoint = { ...checkpoint };
      }
      throw error;
    }
    checkpoint.externalPostId = requireId(published.id, checkpoint, true);
    await saveCheckpoint(checkpoint, onCheckpoint);
    return readReceipt({
      ...options,
      platform: this.platform,
      base,
      postId: checkpoint.externalPostId,
      accessToken,
      checkpoint,
    });
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
    const receipt = await readReceipt({
      ...options,
      platform: this.platform,
      base: graphBase(this.platform, options.account),
      postId: scoped.externalPostId,
      accessToken,
      checkpoint: scoped,
    });
    return { ...receipt, reconciled: true };
  }
}
