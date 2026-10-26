import test from "node:test";
import assert from "node:assert/strict";
import { InstagramAdapter } from "../src/adapters/instagram.js";
import { FacebookPageAdapter } from "../src/adapters/facebook.js";
import { ThreadsAdapter } from "../src/adapters/threads.js";
import { XAdapter, weightedTextLength } from "../src/adapters/x.js";
import { AdapterError, publicHttpsUrl } from "../src/adapters/common.js";

const TOKEN = "oauth-token-must-not-leak";
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const account = (platform) => ({
  platform,
  accountIdExternal: "1234",
  apiCostApproved: true,
  credentials: { accessToken: TOKEN },
});
function context(platform, content = { text: "Tessel verified feature" }) {
  const checkpoints = [];
  return {
    account: account(platform),
    content,
    idempotencyKey: "post-version-destination-1",
    mediaAllowedHosts: ["cdn.tessel.app"],
    onCheckpoint: async (value) => {
      checkpoints.push(structuredClone(value));
    },
    checkpoints,
  };
}
const image = "https://cdn.tessel.app/image.jpg";

for (const url of [
  "http://cdn.tessel.app/a.jpg",
  "https://localhost/a.jpg",
  "https://127.0.0.1/a.jpg",
  "https://[::1]/a.jpg",
  "https://10.0.0.1/a.jpg",
  "https://cdn.tessel.app@127.0.0.1/a.jpg",
  "https://app.internal/a.jpg",
  "https://cdn.tessel.app:8443/a.jpg",
  "https://cdn.tessel.app/a.jpg#secret",
]) {
  test(`media URL rejects a non-public endpoint: ${url}`, () =>
    assert.equal(publicHttpsUrl(url), null));
}

test("all adapters validate media URLs without exposing the URL in errors", () => {
  for (const adapter of [
    new InstagramAdapter(),
    new FacebookPageAdapter(),
    new ThreadsAdapter(),
    new XAdapter(),
  ]) {
    const result = adapter.validate({
      text: "Hello",
      mediaUrls: ["https://127.0.0.1/private?secret=hidden"],
    });
    assert.equal(result.valid, false);
    assert.doesNotMatch(JSON.stringify(result.errors), /hidden|127\.0\.0\.1/);
  }
});

test("Instagram rejects text-only, excessive hashtags, and a caption over its limit", () => {
  const adapter = new InstagramAdapter();
  assert.equal(adapter.validate({ text: "Hello" }).valid, false);
  assert.equal(adapter.validate({ text: "a".repeat(2201), mediaUrls: [image] }).valid, false);
  assert.equal(
    adapter.validate({ text: Array(31).fill("#tessel").join(" "), mediaUrls: [image] }).valid,
    false,
  );
  assert.equal(adapter.validate({ text: "Hello #tessel", mediaUrls: [image] }).valid, true);
});

test("Instagram rejects known incompatible image formats and preserves JPEG support", () => {
  const adapter = new InstagramAdapter();
  for (const url of [
    "https://cdn.tessel.app/logo-light.png",
    "https://cdn.tessel.app/logo.PNG?version=2",
    "https://cdn.tessel.app/logo.webp",
    "https://cdn.tessel.app/logo.avif",
  ]) {
    const validation = adapter.validate({ text: "Image preview", mediaUrls: [url] });
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some((error) => error.includes("requires JPEG")));
  }
  for (const url of [image, "https://cdn.tessel.app/photo.JPEG?version=2"]) {
    assert.equal(adapter.validate({ text: "Image preview", mediaUrls: [url] }).valid, true);
  }
  assert.equal(
    adapter.validate({ text: "Image preview", mediaUrls: [image], mediaMimeTypes: ["image/png"] }).valid,
    false,
  );
});

test("Instagram rejects a PNG before media or provider requests", async () => {
  let calls = 0;
  await assert.rejects(
    () => new InstagramAdapter().publish({
      ...context("instagram", { text: "Preview", mediaUrls: ["https://cdn.tessel.app/logo-light.png"] }),
      mediaFetch: async () => { calls++; },
      fetchImpl: async () => { calls++; },
    }),
    (error) => error.code === "instagram_content_invalid",
  );
  assert.equal(calls, 0);
});

test("Instagram requires MIME inspection for extensionless media and reports unverified dimensions", async () => {
  const options = context("instagram", { text: "Preview", mediaUrls: ["https://cdn.tessel.app/media/123"] });
  const adapter = new InstagramAdapter();
  const validation = adapter.validate(options.content);
  assert.equal(validation.valid, true);
  assert.ok(validation.warnings.some((warning) => warning.includes("unverified MIME")));
  assert.deepEqual(validation.mediaRequirements, {
    imageMimeType: "image/jpeg", maxImageBytes: 8 * 1024 * 1024,
    minAspectRatio: 0.8, maxAspectRatio: 1.91, dimensionsVerified: false,
  });
  let providerCalls = 0;
  await assert.rejects(
    () => adapter.publish({ ...options, fetchImpl: async () => { providerCalls++; } }),
    (error) => error.code === "instagram_image_mime_unverified",
  );
  await assert.rejects(
    () => adapter.publish({ ...options, mediaFetch: async () => new Response("png", { headers: { "content-type": "image/png" } }), fetchImpl: async () => { providerCalls++; } }),
    (error) => error.code === "instagram_image_requires_jpeg",
  );
  assert.equal(providerCalls, 0);
});

test("Instagram confirms JPEG MIME and the actual size through the existing media transport", async () => {
  const options = context("instagram", { text: "JPEG", mediaUrls: ["https://cdn.tessel.app/media/123"] });
  let mediaReads = 0;
  const receipt = await new InstagramAdapter().publish({
    ...options,
    mediaFetch: async () => {
      mediaReads++;
      return new Response(new Uint8Array([255, 216, 255, 217]), { headers: { "content-type": "image/jpeg" } });
    },
    fetchImpl: async (url) => {
      if (url.endsWith("/media")) return json({ id: "container-1" });
      if (url.includes("status_code")) return json({ status_code: "FINISHED" });
      if (url.endsWith("/media_publish")) return json({ id: "post-1" });
      return json({ permalink: "https://www.instagram.com/p/actual-code/" });
    },
  });
  assert.equal(mediaReads, 1);
  assert.equal(receipt.platformPostId, "post-1");
  let providerCalls = 0;
  await assert.rejects(
    () => new InstagramAdapter().publish({
      ...options,
      mediaFetch: async () => new Response(new Uint8Array(8 * 1024 * 1024 + 1), { headers: { "content-type": "image/jpeg" } }),
      fetchImpl: async () => { providerCalls++; },
    }),
    (error) => error.code === "instagram_image_too_large",
  );
  assert.equal(providerCalls, 0);
});

test("media publishing refuses missing or wildcard host allowlists before any request", async () => {
  const adapter = new InstagramAdapter();
  for (const allowed of [[], ["*.tessel.app"], ["other.tessel.app"]]) {
    let calls = 0;
    await assert.rejects(
      () =>
        adapter.publish({
          ...context("instagram", { text: "Hello", mediaUrls: [image] }),
          mediaAllowedHosts: allowed,
          fetchImpl: async () => {
            calls++;
          },
        }),
      (error) => error.code.startsWith("media_host_"),
    );
    assert.equal(calls, 0);
  }
});

test("Instagram Login uses the Instagram host, polls before publishing, and returns only the actual permalink", async () => {
  const adapter = new InstagramAdapter();
  const options = context("instagram", { text: "Hello", mediaUrls: [image] });
  const calls = [];
  const result = await adapter.publish({
    ...options,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      assert.equal(new URL(url).hostname, "graph.instagram.com");
      assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
      assert.equal(init.redirect, "manual");
      assert.ok(init.signal);
      assert.doesNotMatch(url, /access_token|oauth-token/);
      if (url.endsWith("/media")) return json({ id: "container-1" });
      if (url.includes("status_code")) return json({ status_code: "FINISHED" });
      if (url.endsWith("/media_publish")) {
        assert.ok(options.checkpoints.at(-1).publicationAttempted);
        return json({ id: "post-1" });
      }
      return json({ id: "post-1", permalink: "https://www.instagram.com/p/actual-code/" });
    },
  });
  assert.equal(result.platformPostId, "post-1");
  assert.equal(result.platformPostUrl, "https://www.instagram.com/p/actual-code/");
  assert.equal(calls.length, 4);
  assert.match(calls[1].url, /status_code/);
  assert.doesNotMatch(JSON.stringify(result), /oauth-token/);
});

test("Instagram carousel retains all media and checkpoints children before the parent", async () => {
  const options = context("instagram", {
    text: "Album",
    mediaUrls: [image, "https://cdn.tessel.app/second.jpg"],
  });
  const forms = [];
  let index = 0;
  const result = await new InstagramAdapter().publish({
    ...options,
    fetchImpl: async (url, init) => {
      if (url.endsWith("/media")) {
        const form = new URLSearchParams(init.body);
        forms.push(form);
        return json({ id: `container-${++index}` });
      }
      if (url.includes("status_code")) return json({ status_code: "FINISHED" });
      if (url.endsWith("/media_publish")) return json({ id: "album-1" });
      return json({ permalink: "https://instagram.com/p/album/" });
    },
  });
  assert.equal(forms.length, 3);
  assert.equal(forms[0].get("image_url"), image);
  assert.equal(forms[1].get("image_url"), "https://cdn.tessel.app/second.jpg");
  assert.equal(forms[2].get("children"), "container-1,container-2");
  assert.equal(result.platformPostId, "album-1");
});

test("processing container is retried from its persisted checkpoint without creating another container", async () => {
  const options = context("instagram", {
    text: "Video",
    mediaUrls: ["https://cdn.tessel.app/movie.mp4"],
  });
  let created = 0;
  let published = 0;
  const pendingFetch = async (url) => {
    if (url.endsWith("/media")) {
      created++;
      return json({ id: "container-1" });
    }
    if (url.includes("status_code")) return json({ status_code: "IN_PROGRESS" });
    published++;
    throw new Error("Unexpected write");
  };
  let checkpoint;
  await assert.rejects(
    () => new InstagramAdapter().publish({ ...options, fetchImpl: pendingFetch }),
    (error) => {
      assert.equal(error.code, "media_processing");
      assert.equal(error.retryable, true);
      assert.equal(error.retryAfterMs, 60_000);
      checkpoint = error.checkpoint;
      return true;
    },
  );
  assert.equal(created, 1);
  assert.equal(published, 0);
  await new InstagramAdapter().publish({
    ...options,
    resume: checkpoint,
    fetchImpl: async (url) => {
      assert.ok(!url.endsWith("/media"));
      if (url.includes("status_code")) return json({ status_code: "FINISHED" });
      if (url.endsWith("/media_publish")) {
        published++;
        return json({ id: "post-1" });
      }
      return json({ permalink: "https://instagram.com/p/video/" });
    },
  });
  assert.equal(published, 1);
});

test("ambiguous publication is blocked on resume and never inferred from matching text", async () => {
  const options = context("instagram", { text: "Identical text", mediaUrls: [image] });
  let checkpoint;
  await assert.rejects(
    () =>
      new InstagramAdapter().publish({
        ...options,
        fetchImpl: async (url) => {
          if (url.endsWith("/media")) return json({ id: "container-1" });
          if (url.includes("status_code")) return json({ status_code: "FINISHED" });
          throw new Error(`${TOKEN} was in an untrusted transport error`);
        },
      }),
    (error) => {
      assert.equal(error.needsReconciliation, true);
      assert.equal(error.retryable, false);
      assert.doesNotMatch(error.message, /oauth-token/);
      checkpoint = error.checkpoint;
      return true;
    },
  );
  let calls = 0;
  await assert.rejects(
    () =>
      new InstagramAdapter().publish({
        ...options,
        resume: checkpoint,
        fetchImpl: async () => {
          calls++;
        },
      }),
    (error) => error.needsReconciliation,
  );
  assert.equal(calls, 0);
  const result = await new InstagramAdapter().reconcile({
    ...options,
    resume: checkpoint,
    fetchImpl: async () => {
      calls++;
      return json({ data: [{ caption: "Identical text", id: "wrong-post" }] });
    },
  });
  assert.equal(result, null);
  assert.equal(calls, 0);
});

test("permalink lookup failure retains the real post id and blocks a second publish", async () => {
  const options = context("threads", { text: "One real post" });
  let checkpoint;
  await assert.rejects(
    () =>
      new ThreadsAdapter().publish({
        ...options,
        fetchImpl: async (url) => {
          if (url.endsWith("/threads")) return json({ id: "container-1" });
          if (url.includes("fields=status")) return json({ status: "FINISHED" });
          if (url.endsWith("/threads_publish")) return json({ id: "actual-post" });
          return json({ id: "actual-post" });
        },
      }),
    (error) => {
      assert.equal(error.code, "receipt_lookup_required");
      assert.equal(error.needsReconciliation, true);
      assert.equal(error.checkpoint.externalPostId, "actual-post");
      checkpoint = error.checkpoint;
      return true;
    },
  );
  const receipt = await new ThreadsAdapter().reconcile({
    ...options,
    resume: checkpoint,
    fetchImpl: async (url) => {
      assert.match(url, /actual-post\?fields=id,permalink$/);
      return json({
        id: "actual-post",
        permalink: "https://www.threads.com/@tessel/post/real-code",
      });
    },
  });
  assert.equal(receipt.platformPostId, "actual-post");
  assert.equal(receipt.reconciled, true);
});

test("Facebook attaches every uploaded photo to one feed post and returns the API permalink", async () => {
  const options = context("facebook_page", {
    text: "Two images",
    mediaUrls: [image, "https://cdn.tessel.app/second.jpg"],
  });
  let uploaded = 0;
  let feedPosts = 0;
  const receipt = await new FacebookPageAdapter().publish({
    ...options,
    fetchImpl: async (url, init) => {
      if (url.endsWith("/photos")) {
        assert.equal(new URLSearchParams(init.body).get("published"), "false");
        return json({ id: `photo-${++uploaded}` });
      }
      if (url.endsWith("/feed")) {
        feedPosts++;
        assert.deepEqual(JSON.parse(new URLSearchParams(init.body).get("attached_media")), [
          { media_fbid: "photo-1" },
          { media_fbid: "photo-2" },
        ]);
        return json({ id: "page_post-1" });
      }
      return json({ permalink_url: "https://www.facebook.com/tessel/posts/real-post" });
    },
  });
  assert.equal(uploaded, 2);
  assert.equal(feedPosts, 1);
  assert.equal(receipt.platformPostUrl, "https://www.facebook.com/tessel/posts/real-post");
});

test("Threads uses TEXT media type and includes the same CTA in preview and publish", async () => {
  const options = context("threads", {
    text: "Learn about Tessel",
    linkUrl: "https://tessel.app/?utm_content=post-1",
  });
  const adapter = new ThreadsAdapter();
  await adapter.publish({
    ...options,
    fetchImpl: async (url, init) => {
      if (url.endsWith("/threads")) {
        const form = new URLSearchParams(init.body);
        assert.equal(form.get("media_type"), "TEXT");
        assert.equal(form.get("text"), adapter.preview(options.content).text);
        return json({ id: "container-1" });
      }
      if (url.includes("fields=status")) return json({ status: "FINISHED" });
      if (url.endsWith("/threads_publish")) return json({ id: "threads-1" });
      return json({ permalink: "https://threads.net/@tessel/post/verified" });
    },
  });
});

test("X weights Unicode and shortened links and rejects mixed video/photo media", () => {
  assert.equal(weightedTextLength("https://tessel.app/" + "a".repeat(300)), 23);
  assert.equal(weightedTextLength("🧙‍♂️"), 2);
  assert.equal(new XAdapter().validate({ text: "界".repeat(141) }).valid, false);
  assert.equal(
    new XAdapter().validate({
      text: "Short",
      mediaUrls: [image, "https://cdn.tessel.app/clip.mp4"],
    }).valid,
    false,
  );
});

test("X requires explicit approval of API costs before network access", async () => {
  let requests = 0;
  const options = context("x");
  options.account.apiCostApproved = false;
  await assert.rejects(
    () =>
      new XAdapter().publish({
        ...options,
        fetchImpl: async () => {
          requests++;
        },
      }),
    (error) => error.code === "x_api_cost_approval_required",
  );
  assert.equal(requests, 0);
});

test("X downloads bytes through separate media transport, uploads base64 JSON and attaches the returned media id", async () => {
  const options = context("x", { text: "Media test", mediaUrls: [image] });
  let uploads = 0;
  const bytes = new Uint8Array([255, 216, 0, 1, 250, 127]);
  const receipt = await new XAdapter().publish({
    ...options,
    mediaFetch: async (url, init) => {
      assert.equal(url, image);
      assert.equal(init.redirect, "manual");
      assert.equal(init.headers, undefined);
      return new Response(bytes, {
        headers: { "content-type": "image/jpeg", "content-length": String(bytes.length) },
      });
    },
    fetchImpl: async (url, init) => {
      assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
      if (url.endsWith("/media/upload")) {
        uploads++;
        const sent = JSON.parse(init.body);
        assert.deepEqual(Buffer.from(sent.media, "base64"), Buffer.from(bytes));
        assert.equal(sent.media_category, "tweet_image");
        return json({ data: { id: "media-1" } });
      }
      assert.equal(url, "https://api.x.com/2/tweets");
      assert.deepEqual(JSON.parse(init.body).media, { media_ids: ["media-1"] });
      return json({ data: { id: "post-1" } });
    },
  });
  assert.equal(uploads, 1);
  assert.equal(receipt.platformPostUrl, "https://x.com/i/web/status/post-1");
});

test("X chunked video upload completes processing before sending the tweet", async () => {
  const options = context("x", {
    text: "Video test",
    mediaUrls: ["https://cdn.tessel.app/movie.mp4"],
  });
  const stages = [];
  const result = await new XAdapter().publish({
    ...options,
    mediaFetch: async () =>
      new Response(new Uint8Array([0, 0, 1, 0]), { headers: { "content-type": "video/mp4" } }),
    fetchImpl: async (url, init) => {
      if (url.endsWith("/initialize")) {
        stages.push("init");
        assert.equal(JSON.parse(init.body).total_bytes, 4);
        return json({ data: { id: "media-1" } });
      }
      if (url.endsWith("/append")) {
        stages.push("append");
        assert.equal(JSON.parse(init.body).segment_index, 0);
        return new Response(null, { status: 204 });
      }
      if (url.endsWith("/finalize")) {
        stages.push("finalize");
        return json({
          data: { id: "media-1", processing_info: { state: "pending", check_after_secs: 1 } },
        });
      }
      if (url.includes("media_id=")) {
        stages.push("status");
        return json({ data: { id: "media-1", processing_info: { state: "succeeded" } } });
      }
      stages.push("tweet");
      return json({ data: { id: "post-1" } });
    },
  });
  assert.deepEqual(stages, ["init", "append", "finalize", "status", "tweet"]);
  assert.equal(result.platformPostId, "post-1");
});

test("X refuses media redirects, oversized media and unexpected MIME types before uploading", async () => {
  const variants = [
    () => new Response(null, { status: 302, headers: { location: "https://127.0.0.1/secret" } }),
    () =>
      new Response(new Uint8Array(20), {
        headers: { "content-type": "image/jpeg", "content-length": "20" },
      }),
    () => new Response("private-data", { headers: { "content-type": "text/plain" } }),
  ];
  for (const response of variants) {
    let uploads = 0;
    await assert.rejects(
      () =>
        new XAdapter().publish({
          ...context("x", { text: "Media", mediaUrls: [image] }),
          maxMediaBytes: 10,
          mediaFetch: async () => response(),
          fetchImpl: async () => {
            uploads++;
          },
        }),
      (error) => error instanceof AdapterError && error.code.startsWith("media_"),
    );
    assert.equal(uploads, 0);
  }
});

test("429 produces retry metadata and clears the publication checkpoint for a safe bounded retry", async () => {
  const options = context("x");
  await assert.rejects(
    () =>
      new XAdapter().publish({
        ...options,
        fetchImpl: async () => json({ title: TOKEN }, 429, { "retry-after": "120" }),
      }),
    (error) => {
      assert.equal(error.code, "provider_rate_limited");
      assert.equal(error.retryable, true);
      assert.equal(error.needsReconciliation, false);
      assert.equal(error.retryAfterMs, 120_000);
      assert.equal(error.checkpoint.publicationAttempted, false);
      assert.doesNotMatch(error.message, /oauth-token/);
      return true;
    },
  );
});

test("5xx from a public write is ambiguous, never an automatic retry", async () => {
  const options = context("x");
  await assert.rejects(
    () =>
      new XAdapter().publish({ ...options, fetchImpl: async () => json({ detail: TOKEN }, 503) }),
    (error) => {
      assert.equal(error.needsReconciliation, true);
      assert.equal(error.retryable, false);
      assert.doesNotMatch(error.message, /oauth-token/);
      return true;
    },
  );
});

test("a durable checkpoint is mandatory before the final public write", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      new XAdapter().publish({
        ...context("x"),
        onCheckpoint: undefined,
        fetchImpl: async () => {
          calls++;
        },
      }),
    (error) => error.code === "durable_checkpoint_required",
  );
  assert.equal(calls, 0);
});

test("a checkpoint cannot be replayed against another destination or content version", async () => {
  const options = context("x");
  const first = await new XAdapter().publish({
    ...options,
    fetchImpl: async () => json({ data: { id: "post-1" } }),
  });
  let requests = 0;
  for (const changed of [
    { ...options, account: { ...options.account, accountIdExternal: "other-user" } },
    { ...options, content: { text: "changed text" } },
  ]) {
    await assert.rejects(
      () =>
        new XAdapter().publish({
          ...changed,
          resume: first.checkpoint,
          fetchImpl: async () => {
            requests++;
          },
        }),
      (error) => error.code === "checkpoint_scope_mismatch",
    );
  }
  assert.equal(requests, 0);
});

test("a success HTTP response with malformed JSON cannot authorize a repeat public write", async () => {
  await assert.rejects(
    () =>
      new XAdapter().publish({
        ...context("x"),
        fetchImpl: async () => new Response("broken-json", { status: 200 }),
      }),
    (error) => {
      assert.equal(error.needsReconciliation, true);
      assert.equal(error.retryable, false);
      return true;
    },
  );
});

test("a partially successful write with provider errors is blocked for reconciliation", async () => {
  await assert.rejects(
    () =>
      new XAdapter().publish({
        ...context("x"),
        fetchImpl: async () =>
          json({ data: { id: "possibly-created" }, errors: [{ detail: TOKEN }] }),
      }),
    (error) => {
      assert.equal(error.needsReconciliation, true);
      assert.doesNotMatch(error.message, /oauth-token/);
      return true;
    },
  );
});

test("failure persisting a returned post id is ambiguous and retains the id", async () => {
  await assert.rejects(
    () =>
      new XAdapter().publish({
        ...context("x"),
        onCheckpoint: async (value) => {
          if (value.externalPostId) throw new Error(TOKEN);
        },
        fetchImpl: async () => json({ data: { id: "created-post" } }),
      }),
    (error) => {
      assert.equal(error.needsReconciliation, true);
      assert.equal(error.checkpoint.externalPostId, "created-post");
      assert.doesNotMatch(error.message, /oauth-token/);
      return true;
    },
  );
});

test("provider permalink credentials and fragments are excluded from the receipt", async () => {
  const options = context("facebook_page");
  const result = await new FacebookPageAdapter().publish({
    ...options,
    fetchImpl: async (url) =>
      url.endsWith("/feed")
        ? json({ id: "created-post" })
        : json({
            permalink_url:
              "https://www.facebook.com/tessel/posts/123?access_token=must-not-leak#fragment",
          }),
  });
  assert.equal(result.platformPostUrl, "https://www.facebook.com/tessel/posts/123");
  assert.doesNotMatch(JSON.stringify(result), /must-not-leak|fragment/);
});
