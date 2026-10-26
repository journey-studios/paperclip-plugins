import { AdapterError, credentials, graphBase, requestJson } from "./common.js";

const DEFINITIONS = {
  x: {
    metrics: ["impressions", "likes", "reposts", "replies", "quotes", "bookmarks", "clicks"],
    scopes: ["tweet.read"],
    source: "https://docs.x.com/x-api/fundamentals/metrics",
  },
  facebook_page: {
    metrics: ["reactions", "comments", "shares", "impressions", "clicks"],
    scopes: ["pages_read_engagement"],
    source: "https://developers.facebook.com/docs/graph-api/reference/page-post/",
  },
  instagram: {
    metrics: ["views", "reach", "likes", "comments", "saves", "shares", "clicks"],
    scopes: ["instagram_business_basic", "instagram_business_manage_insights"],
    source:
      "https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media/insights",
  },
  threads: {
    metrics: ["views", "likes", "replies", "reposts", "quotes", "shares", "clicks"],
    scopes: ["threads_basic", "threads_manage_insights"],
    source: "https://developers.facebook.com/documentation/threads/insights",
  },
};

function metric(value, reason = "not_returned") {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return { status: "KNOWN", value };
  return { status: "UNKNOWN", value: null, reason };
}

function unavailable(result, reason, status = "UNAVAILABLE") {
  result.status = status;
  for (const key of Object.keys(result.metrics)) result.metrics[key] = metric(null, reason);
  return result;
}

function unsupported(reason) {
  return { status: "UNSUPPORTED", value: null, reason };
}

function complete(result) {
  const values = Object.values(result.metrics);
  if (values.every((item) => item.status === "KNOWN" || item.status === "UNSUPPORTED"))
    result.status = "VERIFIED";
  else result.status = "PARTIAL";
  return result;
}

function scopesFor(account) {
  const value = account?.credentials?.scopes || account?.scopes;
  if (Array.isArray(value)) return value.filter((scope) => typeof scope === "string");
  if (typeof value === "string") return value.split(/[ ,]+/).filter(Boolean);
  return [];
}

function insightValues(data, platformPostId) {
  const values = new Map();
  for (const row of Array.isArray(data?.data) ? data.data : []) {
    if (typeof row?.name !== "string") continue;
    if (typeof row.id === "string" && !row.id.startsWith(`${platformPostId}/insights/`)) continue;
    if (typeof row.total_value?.value === "number") {
      values.set(row.name, row.total_value.value);
      continue;
    }
    if (Array.isArray(row.values) && row.values.length === 1)
      values.set(row.name, row.values[0]?.value);
  }
  return values;
}

async function xMetrics(options, result, accessToken) {
  const data = await requestJson(
    `https://api.x.com/2/tweets/${encodeURIComponent(result.platformPostId)}?tweet.fields=public_metrics`,
    { ...options, accessToken },
  );
  if (data.data?.id !== result.platformPostId)
    return unavailable(result, "post_identity_unverified");
  const fields = {
    impressions: "impression_count",
    likes: "like_count",
    reposts: "retweet_count",
    replies: "reply_count",
    quotes: "quote_count",
    bookmarks: "bookmark_count",
  };
  for (const [name, field] of Object.entries(fields))
    result.metrics[name] = metric(data.data.public_metrics?.[field]);
  result.metrics.clicks = unsupported("requires_non_public_metrics");
  return complete(result);
}

async function facebookMetrics(options, result, accessToken) {
  const fields = "id,comments.limit(0).summary(true),reactions.limit(0).summary(true),shares";
  const url = `${graphBase("facebook_page", options.account)}/${encodeURIComponent(result.platformPostId)}?fields=${encodeURIComponent(fields)}`;
  const data = await requestJson(url, { ...options, accessToken });
  if (data.id !== result.platformPostId) return unavailable(result, "post_identity_unverified");
  result.metrics.reactions = metric(data.reactions?.summary?.total_count);
  result.metrics.comments = metric(data.comments?.summary?.total_count);
  result.metrics.shares = metric(data.shares?.count);
  result.metrics.impressions = unsupported("requires_page_insights");
  result.metrics.clicks = unsupported("requires_page_insights");
  return complete(result);
}

async function instagramMetrics(options, result, accessToken) {
  const base = graphBase("instagram", options.account);
  let product = options.mediaProductType || options.mediaType;
  if (product === "IMAGE" || product === "CAROUSEL_ALBUM") product = "FEED";
  if (!["FEED", "REELS", "STORY"].includes(product)) {
    const media = await requestJson(
      `${base}/${encodeURIComponent(result.platformPostId)}?fields=id,media_product_type,media_type`,
      { ...options, accessToken },
    );
    if (media.id !== result.platformPostId) return unavailable(result, "post_identity_unverified");
    product = media.media_product_type;
  }
  if (!["FEED", "REELS", "STORY"].includes(product))
    return unavailable(result, "media_type_unknown");
  const names = ["views", "reach", "shares"];
  if (product !== "STORY") names.push("likes", "comments", "saved");
  const data = await requestJson(
    `${base}/${encodeURIComponent(result.platformPostId)}/insights?metric=${names.join(",")}`,
    { ...options, accessToken },
  );
  const fields = insightValues(data, result.platformPostId);
  for (const name of names)
    result.metrics[name === "saved" ? "saves" : name] = metric(fields.get(name));
  if (product === "STORY") {
    for (const name of ["likes", "comments", "saves"])
      result.metrics[name] = unsupported("media_type_unsupported");
  }
  result.metrics.clicks = unsupported("not_available_for_published_feed_posts");
  result.mediaProductType = product;
  return complete(result);
}

async function threadsMetrics(options, result, accessToken) {
  const names = ["views", "likes", "replies", "reposts", "quotes", "shares"];
  const url = `${graphBase("threads", options.account)}/${encodeURIComponent(result.platformPostId)}/insights?metric=${names.join(",")}`;
  const data = await requestJson(url, { ...options, accessToken });
  const fields = insightValues(data, result.platformPostId);
  for (const name of names) result.metrics[name] = metric(fields.get(name));
  result.metrics.clicks = unsupported("post_click_metric_not_available");
  return complete(result);
}

export async function readSocialMetrics(platform, options = {}) {
  const definition = DEFINITIONS[platform];
  if (!definition) throw new AdapterError("metrics_platform_unsupported");
  const platformPostId = options.platformPostId;
  const result = {
    platform,
    platformPostId: typeof platformPostId === "string" ? platformPostId : null,
    collectedAt: new Date().toISOString(),
    status: "UNAVAILABLE",
    source: definition.source,
    requiredScopes: [...definition.scopes],
    metrics: Object.fromEntries(definition.metrics.map((name) => [name, metric(null)])),
  };
  if (
    typeof platformPostId !== "string" ||
    !platformPostId ||
    platformPostId.length > 100 ||
    /[\s/?#]/.test(platformPostId)
  )
    return unavailable(result, "published_post_id_required");
  const scopes = scopesFor(options.account);
  if (!definition.scopes.every((scope) => scopes.includes(scope)))
    return unavailable(result, "requires_permission", "REQUIRES_PERMISSION");
  let accessToken;
  try {
    ({ accessToken } = credentials(options.account, platform));
  } catch {
    return unavailable(result, "credentials_unavailable");
  }
  try {
    if (platform === "x") return await xMetrics(options, result, accessToken);
    if (platform === "facebook_page") return await facebookMetrics(options, result, accessToken);
    if (platform === "instagram") return await instagramMetrics(options, result, accessToken);
    return await threadsMetrics(options, result, accessToken);
  } catch (error) {
    if (error?.status === 403 || [10, 200, 294].includes(error?.providerCode))
      return unavailable(result, "requires_permission", "REQUIRES_PERMISSION");
    if (error?.status === 401 || error?.providerCode === 190)
      return unavailable(result, "requires_reauthentication");
    if (error?.code === "provider_rate_limited") {
      result.retryAfterMs = error.retryAfterMs;
      return unavailable(result, "rate_limited");
    }
    return unavailable(
      result,
      error?.status === 400 ? "metric_unavailable" : "provider_unavailable",
    );
  }
}
