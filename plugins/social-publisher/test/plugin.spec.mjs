import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import plugin from "../src/plugin.js";
import manifest from "../src/manifest.js";
import { getOAuthCallbacks } from "../src/oauth.js";
import { pluginManifestV1Schema } from "../../../.paperclip/packages/shared/dist/index.js";
import { databaseContext, draftInput, SCHEMA } from "./helpers.mjs";
import { reconcileTelegramApprovals, approvalPreview } from "../src/telegram-sync.js";
import { runEditorial, editorialSlot } from "../src/editorial.js";
import { isPublicAddress, makeMediaFetch } from "../src/transport.js";

async function setup() {
  const f = await databaseContext();
  f.tools = new Map();
  f.jobs = new Map();
  f.interactions = [];
  f.network = 0;
  f.ctx.tools = { register: (name, schema, handler) => f.tools.set(name, { schema, handler }) };
  f.ctx.jobs = { register: (name, handler) => f.jobs.set(name, handler) };
  f.ctx.companies = { list: async () => [{ id: f.companyId }] };
  f.ctx.http = {
    fetch: async () => {
      f.network++;
      throw new Error("NO_SOCIAL_NETWORK_CALL_ALLOWED");
    },
  };
  f.ctx.issues.askUserQuestions = async (issueId, input, companyId, actor) => {
    const existing = f.interactions.find((item) => item.idempotencyKey === input.idempotencyKey);
    if (existing) return existing;
    const item = {
      ...input,
      id: randomUUID(),
      companyId,
      issueId,
      createdByAgentId: actor.authorAgentId,
      kind: "ask_user_questions",
      status: "pending",
    };
    f.interactions.push(item);
    return item;
  };
  f.ctx.issues.listInteractions = async () => f.interactions;
  await plugin.setup(f.ctx);
  f.call = async (name, params, actorId = f.agentId) =>
    f.tools
      .get(name)
      .handler(params, { companyId: f.companyId, agentId: actorId, runId: randomUUID() });
  return f;
}

test("manifest matches the pinned SDK and every advertised OAuth callback is routed", () => {
  assert.equal(pluginManifestV1Schema.safeParse(manifest).success, true);
  const callbacks = getOAuthCallbacks({ publicBaseUrl: "https://paper.example.com" }, randomUUID());
  for (const [provider, callback] of Object.entries(callbacks)) {
    const url = new URL(callback);
    const path = url.pathname.split("/api/plugins/journey-studios.social-publisher/api")[1];
    assert.ok(
      manifest.apiRoutes.some(
        (route) => route.path === path && route.routeKey === `oauth-${provider}-callback`,
      ),
    );
    assert.ok(url.searchParams.get("companyId"));
  }
  const revision = manifest.tools.find(
    (tool) => tool.name === "social.posts.revise",
  ).parametersSchema;
  assert.ok(revision.required.includes("version"));
});

test("native agent tools -> exact Telegram -> authenticated decision -> scheduled dry run, without a provider write", async () => {
  const f = await setup();
  try {
    assert.equal(f.tools.size, manifest.tools.length);
    assert.equal(
      (await f.call("social.posts.createDraft", draftInput(), randomUUID())).error,
      "SOCIAL_ACCESS_DENIED",
    );
    const created = await f.call(
      "social.posts.createDraft",
      draftInput({
        platforms: ["instagram", "facebook_page", "threads", "x"],
        mediaUrls: ["https://media.example.com/test.jpg"],
      }),
    );
    assert.ok(created.data?.post.id, created.error);
    const id = created.data.post.id;
    const when = new Date(Date.now() + 60_000).toISOString();
    const scheduled = await f.call("social.posts.schedule", { postId: id, scheduledAt: when });
    assert.equal(scheduled.data.status, "pending_approval");
    const interaction = f.interactions[0];
    assert.equal(interaction.createdByAgentId, f.config.telegramAgentId);
    assert.equal(interaction.addresseeUserId, f.founderId);
    assert.equal(interaction.resolverPolicy, "human_only");
    const question = interaction.payload.questions[0];
    assert.deepEqual(
      question.options.map((option) => option.id),
      ["approved", "revision_requested", "rejected"],
    );
    assert.ok(question.helpText.includes(scheduled.data.post.contentHash));
    assert.ok(question.helpText.includes(when));
    interaction.status = "answered";
    interaction.result = {
      version: 1,
      answers: [{ questionId: "social_decision", optionIds: ["approved"] }],
    };
    interaction.resolvedByUserId = "some-other-human";
    assert.equal((await reconcileTelegramApprovals(f.ctx, f.companyId, f.config)).applied, 0);
    interaction.resolvedByUserId = f.founderId;
    assert.equal((await reconcileTelegramApprovals(f.ctx, f.companyId, f.config)).applied, 1);
    assert.equal((await reconcileTelegramApprovals(f.ctx, f.companyId, f.config)).applied, 0);
    await f.ctx.db.execute(
      `UPDATE ${SCHEMA}.social_posts SET scheduled_at=now()-interval '1 minute' WHERE id=$1`,
      [id],
    );
    await f.jobs.get("publish-scheduled")();
    const result = await f.call("social.posts.status", { postId: id });
    assert.equal(result.data.post.status, "dry_run_completed");
    assert.equal(result.data.receipts.length, 4);
    assert.ok(
      result.data.receipts.every(
        (receipt) => receipt.status === "dry_run" && !receipt.platformPostId,
      ),
    );
    assert.equal(f.network, 0);
    const replay = await f.call("social.posts.publish", { postId: id });
    assert.equal(replay.data.replayed, true);
    const metrics = await f.call("social.posts.metrics", { postId: id });
    assert.ok(metrics.data.performance.every((row) => row.status === "UNKNOWN"));
    assert.equal(metrics.data.attribution.roi, null);
    assert.equal(f.network, 0);
  } finally {
    await f.close();
  }
});

test("Telegram revision/rejection apply only to the linked pending immutable version", async () => {
  const f = await setup();
  try {
    for (const decision of ["revision_requested", "rejected"]) {
      const created = await f.call("social.posts.createDraft", draftInput());
      const postId = created.data.post.id;
      await f.call("social.posts.requestApproval", { postId });
      const native = f.interactions.at(-1);
      Object.assign(native, {
        status: "answered",
        resolvedByUserId: f.founderId,
        result: { answers: [{ questionId: "social_decision", optionIds: [decision] }] },
      });
      assert.equal((await reconcileTelegramApprovals(f.ctx, f.companyId, f.config)).applied, 1);
      const denied = await f.call("social.posts.publish", { postId });
      assert.match(denied.error, /prevents publication/);
    }
    const preview = {
      id: randomUUID(),
      version: 1,
      contentHash: "a".repeat(64),
      targets: [{ platform: "threads", accountId: null }],
      dryRun: true,
      approvalExpiresAt: new Date(Date.now() + 1000),
      text: "a".repeat(4000),
    };
    await assert.rejects(approvalPreview(preview), /PREVIEW_TOO_LONG/);
  } finally {
    await f.close();
  }
});

test("API actor is host supplied; connection status remains truthful and errors never echo OAuth inputs", async () => {
  const f = await setup();
  try {
    const input = {
      companyId: f.companyId,
      routeKey: "status",
      params: {},
      query: {},
      body: {},
      actor: { actorType: "user", actorId: f.founderId },
    };
    const denied = await plugin.onApiRequest({
      ...input,
      actor: { actorType: "user", actorId: "forged" },
    });
    assert.equal(denied.status, 403);
    const status = await plugin.onApiRequest(input);
    assert.equal(status.status, 200);
    assert.ok(status.body.data.connectivity.every((row) => row.status === "NOT_CONNECTED"));
    for (const provider of ["instagram", "facebook_page", "threads", "x"]) {
      const response = await plugin.onApiRequest({
        ...input,
        routeKey: `oauth-${provider}-callback`,
        query: { code: "never-echo-authorization-code", state: "forged" },
      });
      assert.ok(response.status >= 400);
      assert.doesNotMatch(JSON.stringify(response), /never-echo-authorization-code/);
    }
    assert.equal(f.network, 0);
  } finally {
    await f.close();
  }
});

test("editorial routine wakes the existing owner once per local day and waits for pending posts", async () => {
  const f = await setup();
  try {
    const issueId = randomUUID();
    let wakes = 0;
    f.config.editorialEnabled = true;
    f.config.editorialIssueId = issueId;
    f.config.editorialAgentId = f.agentId;
    f.ctx.issues.get = async () => ({ id: issueId, assigneeAgentId: f.agentId });
    f.ctx.issues.requestWakeup = async () => {
      wakes++;
      return { requested: true };
    };
    const now = new Date("2026-10-26T15:00:00Z");
    assert.equal(editorialSlot(now, "America/Sao_Paulo").time, "12:00");
    assert.equal((await runEditorial(f.ctx, f.companyId, f.config, now)).status, "requested");
    assert.equal(
      (await runEditorial(f.ctx, f.companyId, f.config, now)).status,
      "already_requested",
    );
    assert.equal(wakes, 1);
  } finally {
    await f.close();
  }
});

test("media transport rejects IP, private DNS and redirects before exposing binary fetch to adapters", async () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "::1",
    "::ffff:127.0.0.1",
    "2001:db8::1",
  ])
    assert.equal(isPublicAddress(address), false);
  let sent = 0;
  const fetchMedia = makeMediaFetch(["media.example.com"], {
    lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    request: () => {
      sent++;
    },
  });
  await assert.rejects(fetchMedia("https://media.example.com/image.png"), /ADDRESS_NOT_PUBLIC/);
  await assert.rejects(fetchMedia("https://127.0.0.1/image.png"), /HOST_NOT_ALLOWED/);
  assert.equal(sent, 0);
});
