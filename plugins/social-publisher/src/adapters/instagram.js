import { readSocialMetrics } from "./metrics-read.js";
import {
  AdapterError,
  assertTrustedMedia,
  composeText,
  mediaItems,
  validateBase,
} from "./common.js";
import { publishContainer, reconcileContainer } from "./graph-container.js";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const NON_JPEG_EXTENSIONS = new Set([
  "png",
  "webp",
  "gif",
  "avif",
  "svg",
  "bmp",
  "tif",
  "tiff",
  "heic",
  "heif",
]);

function imageFormat(content, item, index) {
  let extension = "";
  try {
    extension = decodeURIComponent(new URL(item.url).pathname).match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() || "";
  } catch {
    // The common validator reports invalid URLs without including their contents.
  }
  const declared = content.mediaMimeTypes?.[index] || content.mediaTypes?.[index];
  const mime = typeof declared === "string" && declared.includes("/")
    ? declared.split(";")[0].trim().toLowerCase()
    : null;
  return {
    incompatible: NON_JPEG_EXTENSIONS.has(extension) || (mime !== null && mime !== "image/jpeg"),
    jpegExpected: extension === "jpg" || extension === "jpeg" || mime === "image/jpeg",
  };
}

async function inspectImages(options) {
  for (const [index, item] of mediaItems(options.content).entries()) {
    if (item.kind !== "image") continue;
    if (typeof options.mediaFetch !== "function") {
      if (!imageFormat(options.content, item, index).jpegExpected)
        throw new AdapterError("instagram_image_mime_unverified");
      continue;
    }
    let response;
    try {
      response = await options.mediaFetch(item.url);
    } catch {
      throw new AdapterError("instagram_image_inspection_failed", { retryable: true });
    }
    if (!response.ok) throw new AdapterError("instagram_image_inspection_failed");
    const mime = response.headers?.get?.("content-type")?.split(";")[0].trim().toLowerCase();
    if (mime !== "image/jpeg") throw new AdapterError("instagram_image_requires_jpeg");
    const declaredBytes = Number(response.headers?.get?.("content-length"));
    if (declaredBytes > MAX_IMAGE_BYTES) throw new AdapterError("instagram_image_too_large");
    if (typeof response.arrayBuffer !== "function")
      throw new AdapterError("instagram_image_size_unverified");
    let bytes;
    try {
      bytes = await response.arrayBuffer();
    } catch {
      throw new AdapterError("instagram_image_inspection_failed", { retryable: true });
    }
    if (!bytes.byteLength) throw new AdapterError("instagram_image_empty");
    if (bytes.byteLength > MAX_IMAGE_BYTES) throw new AdapterError("instagram_image_too_large");
  }
}

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
    result.warnings = [];
    for (const [index, item] of mediaItems(content).entries()) {
      if (item.kind !== "image") continue;
      const format = imageFormat(content, item, index);
      if (format.incompatible)
        result.errors.push(`Instagram image item ${index + 1} requires JPEG; convert incompatible image formats before publishing`);
      else if (!format.jpegExpected)
        result.warnings.push(`Instagram image item ${index + 1} has an unverified MIME type; publishing requires media inspection or a declared JPEG type`);
    }
    if (mediaItems(content).some((item) => item.kind === "image")) {
      result.mediaRequirements = {
        imageMimeType: "image/jpeg",
        maxImageBytes: MAX_IMAGE_BYTES,
        minAspectRatio: 0.8,
        maxAspectRatio: 1.91,
        dimensionsVerified: false,
      };
      result.warnings.push("Instagram image size and aspect ratio are not verified by URL validation; media inspection checks MIME/size and the provider validates dimensions");
    }
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
    await inspectImages(options);
    return publishContainer(this.platform, options);
  }
  async reconcile(options) {
    return reconcileContainer(this.platform, options);
  }
}
