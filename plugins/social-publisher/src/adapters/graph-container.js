import {
  AdapterError,
  checkpointOf,
  credentials,
  graphBase,
  mediaItems,
  requestJson,
  requireId,
  saveCheckpoint,
  readReceipt,
  composeText,
  delay,
} from "./common.js";

async function waitForContainer({ platform, base, containerId, accessToken, checkpoint, options }) {
  const field = platform === "instagram" ? "status_code" : "status";
  const attempts = Math.max(1, Math.min(options.maxPollAttempts || 1, 5));
  for (let attempt = 0; attempt < attempts; attempt++) {
    const data = await requestJson(`${base}/${encodeURIComponent(containerId)}?fields=${field}`, {
      ...options,
      accessToken,
      checkpoint,
    });
    const status = data[field];
    if (status === "FINISHED") return;
    if (status === "PUBLISHED")
      throw new AdapterError("publication_outcome_unknown", {
        needsReconciliation: true,
        checkpoint,
      });
    if (status === "ERROR" || status === "EXPIRED")
      throw new AdapterError("media_processing_failed", { checkpoint });
    if (status !== "IN_PROGRESS")
      throw new AdapterError("media_processing_status_unknown", { checkpoint });
    if (attempt + 1 < attempts)
      await (options.waitImpl || delay)(Math.max(0, options.pollIntervalMs ?? 60_000));
  }
  throw new AdapterError("media_processing", { retryable: true, retryAfterMs: 60_000, checkpoint });
}

function containerParams(platform, content, item, carouselChild) {
  const form = {};
  if (!carouselChild) form[platform === "instagram" ? "caption" : "text"] = composeText(content);
  if (item) {
    if (item.kind === "video") {
      form.media_type = platform === "instagram" && !carouselChild ? "REELS" : "VIDEO";
      form.video_url = item.url;
    } else {
      if (platform === "threads") form.media_type = "IMAGE";
      form.image_url = item.url;
    }
    if (item.altText && item.kind === "image") form.alt_text = item.altText;
  } else form.media_type = "TEXT";
  if (carouselChild) form.is_carousel_item = "true";
  return form;
}

export async function publishContainer(platform, options) {
  const { account, content, idempotencyKey, onCheckpoint, resume } = options;
  const { accessToken, userId } = credentials(account, platform);
  const base = graphBase(platform, account);
  const checkpoint = checkpointOf(platform, account, content, idempotencyKey, resume);
  if (checkpoint.externalPostId)
    return readReceipt({
      ...options,
      platform,
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
  const createPath = platform === "instagram" ? "media" : "threads";
  if (!checkpoint.containerId) {
    if (media.length > 1) {
      checkpoint.children ||= [];
      for (let index = 0; index < media.length; index++) {
        let id = checkpoint.children[index];
        if (!id) {
          const created = await requestJson(`${base}/${encodeURIComponent(userId)}/${createPath}`, {
            ...options,
            accessToken,
            method: "POST",
            form: containerParams(platform, content, media[index], true),
            checkpoint,
          });
          id = requireId(created.id, checkpoint);
          checkpoint.children[index] = id;
          await saveCheckpoint(checkpoint, onCheckpoint);
        }
        await waitForContainer({
          platform,
          base,
          containerId: id,
          accessToken,
          checkpoint,
          options,
        });
      }
      const created = await requestJson(`${base}/${encodeURIComponent(userId)}/${createPath}`, {
        ...options,
        accessToken,
        method: "POST",
        form: {
          media_type: "CAROUSEL",
          children: checkpoint.children.join(","),
          [platform === "instagram" ? "caption" : "text"]: composeText(content),
        },
        checkpoint,
      });
      checkpoint.containerId = requireId(created.id, checkpoint);
    } else {
      const created = await requestJson(`${base}/${encodeURIComponent(userId)}/${createPath}`, {
        ...options,
        accessToken,
        method: "POST",
        form: containerParams(platform, content, media[0], false),
        checkpoint,
      });
      checkpoint.containerId = requireId(created.id, checkpoint);
    }
    await saveCheckpoint(checkpoint, onCheckpoint);
  }
  await waitForContainer({
    platform,
    base,
    containerId: checkpoint.containerId,
    accessToken,
    checkpoint,
    options,
  });
  checkpoint.publicationAttempted = true;
  await saveCheckpoint(checkpoint, onCheckpoint);
  let published;
  try {
    published = await requestJson(
      `${base}/${encodeURIComponent(userId)}/${platform === "instagram" ? "media_publish" : "threads_publish"}`,
      {
        ...options,
        accessToken,
        method: "POST",
        form: { creation_id: checkpoint.containerId },
        publicWrite: true,
        checkpoint,
      },
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
    platform,
    base,
    postId: checkpoint.externalPostId,
    accessToken,
    checkpoint,
  });
}

export async function reconcileContainer(platform, options) {
  const { account, content, resume, checkpoint: storedCheckpoint } = options;
  const checkpoint = resume || storedCheckpoint;
  if (!checkpoint?.externalPostId) return null;
  const scoped = checkpointOf(platform, account, content, options.idempotencyKey, checkpoint);
  const { accessToken } = credentials(account, platform);
  const receipt = await readReceipt({
    ...options,
    platform,
    base: graphBase(platform, account),
    postId: scoped.externalPostId,
    accessToken,
    checkpoint: scoped,
  });
  return { ...receipt, reconciled: true };
}
