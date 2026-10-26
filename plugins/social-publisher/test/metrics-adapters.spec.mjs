import test from "node:test";
import assert from "node:assert/strict";
import { XAdapter } from "../src/adapters/x.js";
import { FacebookPageAdapter } from "../src/adapters/facebook.js";
import { InstagramAdapter } from "../src/adapters/instagram.js";
import { ThreadsAdapter } from "../src/adapters/threads.js";

const secret = "metrics-oauth-secret-must-not-leak";
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const SCOPES = {
  x: ["tweet.read"],
  facebook_page: ["pages_read_engagement"],
  instagram: ["instagram_business_basic", "instagram_business_manage_insights"],
  threads: ["threads_basic", "threads_manage_insights"],
};
const options = (platform) => ({
  account: {
    accountIdExternal: "1234",
    scopes: SCOPES[platform],
    credentials: { accessToken: secret },
  },
  platformPostId: "5001",
});
const insight = (name, value, postId = "5001") => ({
  name,
  period: "lifetime",
  values: [{ value }],
  id: `${postId}/insights/${name}/lifetime`,
});

for (const [platform, Adapter] of [
  ["x", XAdapter],
  ["facebook_page", FacebookPageAdapter],
  ["instagram", InstagramAdapter],
  ["threads", ThreadsAdapter],
]) {
  test(`${platform} metrics require their own read scopes without issuing a request`, async () => {
    let requests = 0;
    const input = options(platform);
    input.account.scopes = ["some_publish_scope"];
    const result = await new Adapter().readMetrics({
      ...input,
      fetchImpl: async () => {
        requests++;
      },
    });
    assert.equal(result.status, "REQUIRES_PERMISSION");
    assert.ok(
      Object.values(result.metrics).every(
        (item) => item.status === "UNKNOWN" && item.value === null,
      ),
    );
    assert.equal(requests, 0);
  });
}

test("X public metrics preserves an explicit zero and marks absent counts UNKNOWN", async () => {
  const result = await new XAdapter().readMetrics({
    ...options("x"),
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://api.x.com/2/tweets/5001?tweet.fields=public_metrics");
      assert.equal(init.method, "GET");
      assert.equal(init.headers.Authorization, `Bearer ${secret}`);
      assert.doesNotMatch(url, /token/);
      return json({
        data: {
          id: "5001",
          public_metrics: { like_count: 0, retweet_count: 2, impression_count: 10 },
        },
      });
    },
  });
  assert.deepEqual(result.metrics.likes, { status: "KNOWN", value: 0 });
  assert.deepEqual(result.metrics.reposts, { status: "KNOWN", value: 2 });
  assert.equal(result.metrics.replies.status, "UNKNOWN");
  assert.equal(result.metrics.replies.value, null);
  assert.equal(result.metrics.clicks.status, "UNSUPPORTED");
  assert.equal(result.status, "PARTIAL");
  assert.equal(result.metrics.revenue, undefined);
  assert.doesNotMatch(JSON.stringify(result), /metrics-oauth-secret/);
});

test("X rejects numeric strings, negative counters and a response for another post", async () => {
  const invalid = await new XAdapter().readMetrics({
    ...options("x"),
    fetchImpl: async () =>
      json({
        data: {
          id: "5001",
          public_metrics: { like_count: "1", retweet_count: -2, impression_count: 2.5 },
        },
      }),
  });
  for (const name of ["likes", "reposts", "impressions"])
    assert.equal(invalid.metrics[name].status, "UNKNOWN");
  const other = await new XAdapter().readMetrics({
    ...options("x"),
    fetchImpl: async () =>
      json({ data: { id: "other-post", public_metrics: { like_count: 100 } } }),
  });
  assert.equal(other.status, "UNAVAILABLE");
  assert.equal(other.metrics.likes.value, null);
});

test("Facebook reports reactions as reactions, omits user data and does not turn missing shares into zero", async () => {
  const result = await new FacebookPageAdapter().readMetrics({
    ...options("facebook_page"),
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      assert.equal(parsed.hostname, "graph.facebook.com");
      assert.equal(
        parsed.searchParams.get("fields"),
        "id,comments.limit(0).summary(true),reactions.limit(0).summary(true),shares",
      );
      return json({
        id: "5001",
        reactions: { data: [], summary: { total_count: 4 } },
        comments: { data: [], summary: { total_count: 0 } },
      });
    },
  });
  assert.equal(result.metrics.reactions.value, 4);
  assert.equal(result.metrics.likes, undefined);
  assert.deepEqual(result.metrics.comments, { status: "KNOWN", value: 0 });
  assert.equal(result.metrics.shares.value, null);
  assert.equal(result.metrics.impressions.status, "UNSUPPORTED");
});

test("Instagram FEED reads the supported current metrics and avoids deprecated impressions", async () => {
  let calls = 0;
  const result = await new InstagramAdapter().readMetrics({
    ...options("instagram"),
    fetchImpl: async (url) => {
      calls++;
      const parsed = new URL(url);
      assert.equal(parsed.hostname, "graph.instagram.com");
      if (parsed.searchParams.has("fields"))
        return json({ id: "5001", media_product_type: "FEED", media_type: "IMAGE" });
      assert.equal(parsed.pathname.endsWith("/5001/insights"), true);
      assert.equal(parsed.searchParams.get("metric"), "views,reach,shares,likes,comments,saved");
      assert.doesNotMatch(url, /impressions|access_token/);
      return json({
        data: [
          insight("views", 14),
          insight("reach", 10),
          insight("shares", 0),
          insight("likes", 2),
          insight("comments", 1),
          insight("saved", 3),
        ],
      });
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.mediaProductType, "FEED");
  assert.equal(result.metrics.saves.value, 3);
  assert.equal(result.metrics.shares.value, 0);
  assert.equal(result.metrics.impressions, undefined);
});

test("Instagram STORY excludes FEED-only metrics instead of requesting unsupported values", async () => {
  const result = await new InstagramAdapter().readMetrics({
    ...options("instagram"),
    mediaProductType: "STORY",
    fetchImpl: async (url) => {
      assert.equal(new URL(url).searchParams.get("metric"), "views,reach,shares");
      return json({ data: [insight("views", 14), insight("reach", 10), insight("shares", 1)] });
    },
  });
  for (const name of ["likes", "comments", "saves"])
    assert.equal(result.metrics[name].status, "UNSUPPORTED");
  assert.equal(result.metrics.views.value, 14);
});

test("Threads media insights retain missing data as UNKNOWN and include no fabricated totals", async () => {
  const result = await new ThreadsAdapter().readMetrics({
    ...options("threads"),
    fetchImpl: async (url) => {
      assert.equal(
        url,
        "https://graph.threads.net/v1.0/5001/insights?metric=views,likes,replies,reposts,quotes,shares",
      );
      return json({ data: [insight("likes", 4), insight("replies", 0)] });
    },
  });
  assert.equal(result.metrics.likes.value, 4);
  assert.equal(result.metrics.replies.value, 0);
  assert.equal(result.metrics.views.value, null);
  assert.equal(result.status, "PARTIAL");
});

test("insight rows for another post and multiple interval values cannot supply a lifetime total", async () => {
  const result = await new ThreadsAdapter().readMetrics({
    ...options("threads"),
    fetchImpl: async () =>
      json({
        data: [
          insight("likes", 500, "wrong-post"),
          { name: "views", values: [{ value: 2 }, { value: 3 }] },
        ],
      }),
  });
  assert.equal(result.metrics.likes.value, null);
  assert.equal(result.metrics.views.value, null);
});

test("permission denial returns actionable UNKNOWN metrics without provider error text", async () => {
  const result = await new FacebookPageAdapter().readMetrics({
    ...options("facebook_page"),
    fetchImpl: async () =>
      json({ error: { code: 200, message: `${secret}: permissions missing` } }, 400),
  });
  assert.equal(result.status, "REQUIRES_PERMISSION");
  assert.ok(
    Object.values(result.metrics).every(
      (item) => item.value === null && item.reason === "requires_permission",
    ),
  );
  assert.doesNotMatch(JSON.stringify(result), /metrics-oauth-secret/);
});

test("read rate limiting exposes retry timing without inventing any counts", async () => {
  const result = await new XAdapter().readMetrics({
    ...options("x"),
    fetchImpl: async () => json({ detail: secret }, 429, { "retry-after": "60" }),
  });
  assert.equal(result.status, "UNAVAILABLE");
  assert.equal(result.retryAfterMs, 60_000);
  assert.ok(
    Object.values(result.metrics).every((item) => item.status === "UNKNOWN" && item.value === null),
  );
  assert.doesNotMatch(JSON.stringify(result), /metrics-oauth-secret/);
});

test("a real published post identifier is required and query injection never reaches the provider", async () => {
  let requests = 0;
  const result = await new XAdapter().readMetrics({
    ...options("x"),
    platformPostId: "5001?access_token=invalid",
    fetchImpl: async () => {
      requests++;
    },
  });
  assert.equal(result.status, "UNAVAILABLE");
  assert.equal(requests, 0);
  assert.equal(result.metrics.likes.reason, "published_post_id_required");
});
