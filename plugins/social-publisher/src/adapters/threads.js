import { readSocialMetrics } from "./metrics-read.js";
import {
  AdapterError,
  assertTrustedMedia,
  composeText,
  mediaItems,
  validateBase,
} from "./common.js";
import { publishContainer, reconcileContainer } from "./graph-container.js";

export class ThreadsAdapter {
  constructor() {
    this.platform = "threads";
  }
  async readMetrics(options) {
    return readSocialMetrics(this.platform, options);
  }
  validate(content = {}) {
    const result = validateBase(content, { maxChars: 500, maxMedia: 10 });
    if (mediaItems(content).some((item) => item.kind === "gif"))
      result.errors.push("Threads publishing requires an image or video attachment, not GIF");
    result.valid = result.errors.length === 0;
    return result;
  }
  preview(content = {}) {
    return {
      platform: this.platform,
      text: composeText(content),
      mediaUrls: content.mediaUrls || [],
      ...this.validate(content),
    };
  }
  async publish(options) {
    if (!this.validate(options.content).valid) throw new AdapterError("threads_content_invalid");
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
