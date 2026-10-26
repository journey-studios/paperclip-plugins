import { readSocialMetrics } from "./metrics-read.js";
import {
  AdapterError,
  assertTrustedMedia,
  composeText,
  mediaItems,
  validateBase,
} from "./common.js";
import { publishContainer, reconcileContainer } from "./graph-container.js";

export class InstagramAdapter {
  constructor() {
    this.platform = "instagram";
  }
  async readMetrics(options) {
    return readSocialMetrics(this.platform, options);
  }
  validate(content = {}) {
    const result = validateBase(content, { maxChars: 2200, maxMedia: 10, requireMedia: true });
    const hashtags = composeText(content).match(/#[\p{L}\p{N}_]+/gu) || [];
    if (hashtags.length > 30)
      result.errors.push(
        `Instagram caption exceeds 30 hashtags limit (${hashtags.length} hashtags)`,
      );
    if (mediaItems(content).some((item) => item.kind === "gif"))
      result.errors.push("Instagram publishing does not accept animated GIF attachments");
    result.valid = result.errors.length === 0;
    return result;
  }
  preview(content = {}) {
    const mediaUrls = content.mediaUrls || [];
    return {
      platform: this.platform,
      caption: composeText(content),
      mediaUrls,
      charCount: composeText(content).length,
      maxChars: 2200,
      estimatedPostType: mediaUrls.length > 1 ? "carousel" : "single_media",
    };
  }
  async publish(options) {
    if (!this.validate(options.content).valid) throw new AdapterError("instagram_content_invalid");
    assertTrustedMedia(
      options.content,
      options.mediaAllowedHosts || options.account.mediaAllowedHosts,
    );
    return publishContainer(this.platform, options);
  }
  async reconcile(options) {
    return reconcileContainer(this.platform, options);
  }
}
