import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { factualEvidenceStatus } from "../src/governance.js";
import { beginOAuth, completeOAuth, OAUTH_SCOPES } from "../src/oauth.js";
import { databaseContext, draftInput, SCHEMA } from "./helpers.mjs";
import {
  serviceCreateDraft,
  servicePublishPost,
  serviceRequestApproval,
  serviceDecideApproval,
  serviceReviseDraft,
  serviceGetPostStatus,
  serviceSchedulePost,
  serviceCancelPost,
  serviceTriggerScheduledJob,
  serviceListAccounts,
  serviceReconcilePost,
  serviceRetryAuthorization,
} from "../src/service.js";
import {
  getPost,
  updatePostStatus,
  listReceiptsForPost,
  claimPost,
  upsertAccount,
  recordReceipt,
  updateAccount,
} from "../src/catalog.js";

async function pending(fixture, input = draftInput()) {
  const { post } = await serviceCreateDraft(
    fixture.ctx,
    fixture.companyId,
    input,
    fixture.actor,
    fixture.config,
  );
  const result = await serviceRequestApproval(
    fixture.ctx,
    fixture.companyId,
    { postId: post.id },
    fixture.actor,
    fixture.config,
  );
  await updatePostStatus(fixture.ctx, fixture.companyId, post.id, "pending_approval", {
    approvalRequestId: "native-test",
    expectedStatuses: ["pending_approval"],
  });
  return { ...result.post, approvalRequestId: "native-test" };
}
async function approve(fixture, post, extra = {}) {
  return serviceDecideApproval(
    fixture.ctx,
    fixture.companyId,
    {
      postId: post.id,
      version: post.version,
      contentHash: post.contentHash,
      targets: post.targets,
      interactionId: post.approvalRequestId,
      decision: "approved",
      ...extra,
    },
    fixture.human,
    fixture.config,
  );
}

test("migrations and catalog use the real Postgres contract; identities are scoped", async () => {
  const f = await databaseContext();
  try {
    const first = await serviceCreateDraft(
      f.ctx,
      f.companyId,
      draftInput({ idempotencyKey: "editorial:2026-10-26" }),
      f.actor,
      f.config,
    );
    const replay = await serviceCreateDraft(
      f.ctx,
      f.companyId,
      draftInput({ idempotencyKey: "editorial:2026-10-26" }),
      f.actor,
      f.config,
    );
    assert.equal(first.post.id, replay.post.id);
    await assert.rejects(
      serviceCreateDraft(
        f.ctx,
        f.companyId,
        draftInput({ idempotencyKey: "editorial:2026-10-26", text: "Different content" }),
        f.actor,
        f.config,
      ),
      /IDEMPOTENCY_CONTENT_CONFLICT/,
    );
    assert.equal(await getPost(f.ctx, randomUUID(), first.post.id), null);
    await assert.rejects(
      serviceCreateDraft(
        f.ctx,
        f.companyId,
        draftInput(),
        { actorType: "agent", actorId: randomUUID() },
        f.config,
      ),
      /not been granted/,
    );
    assert.equal(first.post.status, "draft");
    assert.equal(first.post.approvedAt, null);
  } finally {
    await f.close();
  }
});

test("dry run approval binds human, version, hash, channels, expiry and one-time decision", async () => {
  const f = await databaseContext();
  try {
    const post = await pending(f);
    const args = {
      postId: post.id,
      version: post.version,
      contentHash: post.contentHash,
      targets: post.targets,
      interactionId: "native-test",
      decision: "approved",
    };
    await assert.rejects(
      serviceDecideApproval(f.ctx, f.companyId, args, f.actor, f.config),
      /Human approval/,
    );
    await assert.rejects(approve(f, post, { version: 2 }), /APPROVAL_VERSION_OR_TARGET_MISMATCH/);
    await assert.rejects(
      approve(f, post, { targets: [{ platform: "x", accountId: null }] }),
      /APPROVAL_VERSION_OR_TARGET_MISMATCH/,
    );
    await assert.rejects(
      approve(f, post, { contentHash: "wrong" }),
      /APPROVAL_VERSION_OR_TARGET_MISMATCH/,
    );
    await approve(f, post);
    await assert.rejects(approve(f, post), /APPROVAL_VERSION_OR_TARGET_MISMATCH/);
    let networkWrites = 0;
    const fetchImpl = async () => {
      networkWrites++;
      throw new Error("No external call allowed");
    };
    const result = await servicePublishPost(
      f.ctx,
      f.companyId,
      { postId: post.id },
      f.actor,
      f.config,
      fetchImpl,
    );
    assert.equal(result.status, "dry_run_completed");
    assert.equal(networkWrites, 0);
    assert.equal(result.receipts.length, 2);
    assert.ok(
      result.receipts.every(
        (receipt) =>
          receipt.status === "dry_run" && !receipt.platformPostId && !receipt.platformPostUrl,
      ),
    );
    const replay = await servicePublishPost(
      f.ctx,
      f.companyId,
      { postId: post.id },
      f.actor,
      f.config,
      fetchImpl,
    );
    assert.equal(replay.replayed, true);
    assert.equal(networkWrites, 0);
  } finally {
    await f.close();
  }
});

test("expired approvals and missing factual evidence cannot publish", async () => {
  const f = await databaseContext();
  try {
    const { post } = await serviceCreateDraft(
      f.ctx,
      f.companyId,
      draftInput({ metadata: {} }),
      f.actor,
      f.config,
    );
    await assert.rejects(
      serviceRequestApproval(f.ctx, f.companyId, { postId: post.id }, f.actor, f.config),
      /FACTUAL_EVIDENCE_NOT_READY/,
    );
    const p = await pending(f);
    await f.ctx.db.execute(
      `UPDATE ${SCHEMA}.social_posts SET approval_expires_at=now()-interval '1 second' WHERE id=$1`,
      [p.id],
    );
    await assert.rejects(approve(f, p), /APPROVAL_EXPIRED/);
  } finally {
    await f.close();
  }
});

test("revision creates a new immutable version and invalidates prior approval", async () => {
  const f = await databaseContext();
  try {
    const post = await pending(f);
    await approve(f, post);
    const revised = await serviceReviseDraft(
      f.ctx,
      f.companyId,
      { postId: post.id, version: 1, text: "Sua campanha de RPG organizada no Tessel." },
      f.actor,
      f.config,
    );
    assert.notEqual(revised.post.id, post.id);
    assert.equal(revised.post.rootPostId, post.rootPostId);
    assert.equal(revised.post.version, 2);
    assert.equal(revised.post.status, "draft");
    assert.equal(revised.post.approvedAt, null);
    assert.notEqual(revised.post.contentHash, post.contentHash);
    assert.equal((await getPost(f.ctx, f.companyId, post.id)).status, "superseded");
    await assert.rejects(
      servicePublishPost(f.ctx, f.companyId, { postId: post.id }, f.actor, f.config),
      /prevents publication/,
    );
    assert.equal(
      (await servicePublishPost(f.ctx, f.companyId, { postId: revised.post.id }, f.actor, f.config))
        .status,
      "pending_approval",
    );
  } finally {
    await f.close();
  }
});

test("atomic publication claim prevents concurrent workers from publishing twice", async () => {
  const f = await databaseContext();
  try {
    const p = await pending(f);
    await approve(f, p);
    const claims = await Promise.all([
      claimPost(f.ctx, f.companyId, p.id),
      claimPost(f.ctx, f.companyId, p.id),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    await f.ctx.db.execute(
      `UPDATE ${SCHEMA}.social_posts SET updated_at=now()-interval '11 minutes' WHERE id=$1`,
      [p.id],
    );
    await recordReceipt(f.ctx, f.companyId, {
      postId: p.id,
      platform: "x",
      destinationKey: "x:unconnected",
      status: "processing",
    });
    await f.ctx.db.execute(
      `UPDATE ${SCHEMA}.social_receipts SET attempted_at=now()-interval '11 minutes' WHERE post_id=$1`,
      [p.id],
    );
    let network = 0;
    await serviceTriggerScheduledJob(f.ctx, f.companyId, f.config, async () => {
      network++;
    });
    assert.equal(network, 0);
    assert.equal((await getPost(f.ctx, f.companyId, p.id)).status, "unknown");
    assert.equal((await listReceiptsForPost(f.ctx, f.companyId, p.id))[0].status, "unknown");
    await assert.rejects(
      servicePublishPost(f.ctx, f.companyId, { postId: p.id }, f.actor, f.config),
      /prevents publication/,
    );
  } finally {
    await f.close();
  }
});

test("scheduler honors cancellation, approvals and true receipts", async () => {
  const f = await databaseContext();
  try {
    const p = await pending(f);
    await approve(f, p);
    const scheduled = await serviceSchedulePost(
      f.ctx,
      f.companyId,
      { postId: p.id, scheduledAt: new Date(Date.now() + 60000).toISOString() },
      f.actor,
      f.config,
    );
    assert.equal(scheduled.status, "scheduled");
    await serviceCancelPost(f.ctx, f.companyId, { postId: p.id }, f.actor, f.config);
    await f.ctx.db.execute(
      `UPDATE ${SCHEMA}.social_posts SET scheduled_at=now()-interval '1 minute' WHERE id=$1`,
      [p.id],
    );
    const result = await serviceTriggerScheduledJob(f.ctx, f.companyId, f.config, async () => {
      throw new Error("Must not publish");
    });
    assert.equal(result.processedCount, 0);
    assert.equal(
      (await serviceGetPostStatus(f.ctx, f.companyId, { postId: p.id })).post.status,
      "cancelled",
    );
    const status = await serviceListAccounts(f.ctx, f.companyId);
    assert.equal(status.connectivity.length, 4);
    assert.ok(status.connectivity.every((item) => item.status === "NOT_CONNECTED"));
  } finally {
    await f.close();
  }
});

test("account credentials accept references only and defaults cannot enable autonomous publication", async () => {
  const f = await databaseContext();
  try {
    await assert.rejects(
      upsertAccount(f.ctx, f.companyId, {
        platform: "x",
        accountName: "Tessel",
        accountIdExternal: "123",
        credentialsRef: { accessToken: "should-never-store" },
      }),
      /CREDENTIAL_REFERENCE_REQUIRED/,
    );
    const account = await upsertAccount(f.ctx, f.companyId, {
      platform: "x",
      accountName: "Tessel",
      accountIdExternal: "123",
      credentialsRef: { type: "secret_ref", secretId: randomUUID() },
    });
    assert.equal(account.policy, "disabled");
    assert.equal(account.killSwitch, true);
    assert.equal(account.autonomousOptIn, false);
    assert.equal(account.verificationStatus, "CONNECTED_UNVERIFIED");
    const output = await serviceListAccounts(f.ctx, f.companyId);
    assert.equal(output.accounts[0].credentialsRef, undefined);
    await assert.rejects(
      serviceCreateDraft(
        f.ctx,
        f.companyId,
        draftInput({ platforms: ["x"], dryRun: false }),
        f.actor,
        f.config,
      ),
      /restricted to dry runs/,
    );
  } finally {
    await f.close();
  }
});

test("scheduling before approval persists exact time and resumes only after the native human decision", async () => {
  const f = await databaseContext();
  try {
    const { post } = await serviceCreateDraft(f.ctx, f.companyId, draftInput(), f.actor, f.config);
    const time = new Date(Date.now() + 60000).toISOString();
    const pendingResult = await serviceSchedulePost(
      f.ctx,
      f.companyId,
      { postId: post.id, scheduledAt: time },
      f.actor,
      f.config,
    );
    assert.equal(pendingResult.status, "pending_approval");
    assert.equal(new Date(pendingResult.post.scheduledAt).toISOString(), time);
    await updatePostStatus(f.ctx, f.companyId, post.id, "pending_approval", {
      approvalRequestId: "native-test",
      expectedStatuses: ["pending_approval"],
    });
    const decision = await approve(f, { ...pendingResult.post, approvalRequestId: "native-test" });
    assert.equal(decision.status, "scheduled");
    await f.ctx.db.execute(
      `UPDATE ${SCHEMA}.social_posts SET scheduled_at=now()-interval '1 second' WHERE id=$1`,
      [post.id],
    );
    const result = await serviceTriggerScheduledJob(f.ctx, f.companyId, f.config, async () => {
      throw new Error("Must never call public API in dry run");
    });
    assert.equal(result.processedCount, 1);
    assert.equal(result.results[0].result.status, "dry_run_completed");
  } finally {
    await f.close();
  }
});

async function liveFixture(expiresIn = 7200) {
  const keyRef = { type: "secret_ref", secretId: randomUUID() };
  const appRef = { type: "secret_ref", secretId: randomUUID() };
  const f = await databaseContext({
    dryRunOnly: false,
    killSwitch: false,
    xClientId: "test-client",
    xClientSecretRef: appRef,
    tokenEncryptionKeyRef: keyRef,
  });
  f.ctx.secrets = {
    resolve: async (ref) =>
      ref.secretId === keyRef.secretId
        ? Buffer.alloc(32, 2).toString("base64")
        : "test-client-secret",
  };
  f.ctx.http = {
    fetch: async (raw) => {
      const url = new URL(raw);
      if (url.pathname === "/2/oauth2/token")
        return new Response(
          JSON.stringify({
            access_token: "private-token",
            refresh_token: "private-refresh",
            scope: OAUTH_SCOPES.x.join(" "),
            expires_in: expiresIn,
          }),
        );
      if (url.pathname === "/2/users/me")
        return new Response(JSON.stringify({ data: { id: "12345", username: "tessel-test" } }));
      throw new Error("Unexpected OAuth URL");
    },
  };
  const started = await beginOAuth(f.ctx, f.companyId, "x", { actorId: f.founderId }, f.config);
  const connected = await completeOAuth(
    f.ctx,
    f.companyId,
    "x",
    {
      actorId: f.founderId,
      state: new URL(started.authorizeUrl).searchParams.get("state"),
      code: "test-code",
    },
    f.config,
  );
  await updateAccount(f.ctx, f.companyId, connected.account.id, {
    policy: "approval_required",
    killSwitch: false,
    dailyLimit: 1,
    allowedAgentIds: [f.agentId],
    apiCostApproved: true,
    estimatedPostCostCents: 0,
    dailyCostLimitCents: 0,
  });
  f.accountId = connected.account.id;
  return f;
}

test("safe 429 retries reuse durable checkpoints, quotas and exact immutable destination", async () => {
  const f = await liveFixture();
  try {
    const p = await pending(
      f,
      draftInput({
        platforms: ["x"],
        dryRun: false,
        targets: [{ platform: "x", accountId: f.accountId }],
      }),
    );
    await approve(f, p);
    let calls = 0;
    const fetchImpl = async (_url, init) => {
      calls++;
      assert.equal(init.method, "POST");
      if (calls === 1)
        return new Response(JSON.stringify({ title: "Rate limit" }), {
          status: 429,
          headers: { "retry-after": "1" },
        });
      return new Response(JSON.stringify({ data: { id: "98765" } }));
    };
    const first = await servicePublishPost(
      f.ctx,
      f.companyId,
      { postId: p.id },
      f.actor,
      f.config,
      fetchImpl,
    );
    assert.equal(first.status, "retry");
    assert.equal(first.receipts[0].attemptCount, 1);
    assert.equal(first.receipts[0].checkpoint.publicationAttempted, false);
    assert.equal(calls, 1);
    await servicePublishPost(f.ctx, f.companyId, { postId: p.id }, f.actor, f.config, fetchImpl);
    assert.equal(calls, 1);
    await f.ctx.db.execute(
      `UPDATE ${SCHEMA}.social_posts SET next_attempt_at=now()-interval '1 second' WHERE id=$1`,
      [p.id],
    );
    await f.ctx.db.execute(
      `UPDATE ${SCHEMA}.social_receipts SET next_attempt_at=now()-interval '1 second' WHERE post_id=$1`,
      [p.id],
    );
    const retry = await serviceTriggerScheduledJob(f.ctx, f.companyId, f.config, fetchImpl);
    assert.equal(retry.results[0].result.status, "published");
    assert.equal(calls, 2);
    const receipt = retry.results[0].result.receipts[0];
    assert.equal(receipt.platformPostId, "98765");
    assert.equal(receipt.platformPostUrl, "https://x.com/i/web/status/98765");
    assert.equal(receipt.attemptCount, 2);
    assert.equal(JSON.stringify(receipt).includes("private-token"), false);
    const counts = await f.ctx.db.query(
      `SELECT posts_today FROM ${SCHEMA}.social_accounts WHERE id=$1`,
      [f.accountId],
    );
    assert.equal(counts[0].posts_today, 1);
  } finally {
    await f.close();
  }
});

test("ambiguous network failure remains unknown without any retry and exact remote reconciliation is read-only", async () => {
  const f = await liveFixture();
  try {
    const p = await pending(
      f,
      draftInput({
        platforms: ["x"],
        dryRun: false,
        targets: [{ platform: "x", accountId: f.accountId }],
      }),
    );
    await approve(f, p);
    let calls = 0;
    const result = await servicePublishPost(
      f.ctx,
      f.companyId,
      { postId: p.id },
      f.actor,
      f.config,
      async () => {
        calls++;
        throw new Error("connection lost after write");
      },
    );
    assert.equal(result.status, "unknown");
    assert.equal(calls, 1);
    assert.equal(result.receipts[0].checkpoint.publicationAttempted, true);
    await assert.rejects(
      servicePublishPost(f.ctx, f.companyId, { postId: p.id }, f.actor, f.config, async () => {
        calls++;
      }),
      /prevents publication/,
    );
    const unresolved = await serviceReconcilePost(
      f.ctx,
      f.companyId,
      { postId: p.id },
      f.human,
      f.config,
      async () => {
        calls++;
      },
    );
    assert.equal(unresolved.status, "unknown");
    assert.equal(calls, 1, "No remote ID means no invented receipt or text matching");
    const receipt = (await listReceiptsForPost(f.ctx, f.companyId, p.id))[0];
    await recordReceipt(f.ctx, f.companyId, {
      ...receipt,
      checkpoint: { ...receipt.checkpoint, externalPostId: "98765" },
    });
    const verified = await serviceReconcilePost(
      f.ctx,
      f.companyId,
      { postId: p.id },
      f.human,
      f.config,
      async (url, init) => {
        assert.notEqual(init.method, "POST");
        assert.ok(url.includes("/tweets/98765"));
        return new Response(JSON.stringify({ data: { id: "98765", author_id: "12345" } }));
      },
    );
    assert.equal(verified.status, "published");
    assert.equal(verified.receipts[0].platformPostId, "98765");
  } finally {
    await f.close();
  }
});

test("autonomous scheduling is possible only with separate destination opt-in and verified factual evidence", async () => {
  const f = await liveFixture();
  try {
    f.config.verifiedEvidenceHashes = factualEvidenceStatus(draftInput()).evidenceHashes;
    await updateAccount(f.ctx, f.companyId, f.accountId, {
      policy: "autonomous",
      autonomousOptIn: true,
    });
    const { post } = await serviceCreateDraft(
      f.ctx,
      f.companyId,
      draftInput({
        platforms: ["x"],
        campaign: "independent-opted-in-campaign",
        dryRun: false,
        targets: [{ platform: "x", accountId: f.accountId }],
      }),
      f.actor,
      f.config,
    );
    const scheduled = await serviceSchedulePost(
      f.ctx,
      f.companyId,
      { postId: post.id, scheduledAt: new Date(Date.now() + 60000).toISOString() },
      f.actor,
      f.config,
    );
    assert.equal(scheduled.status, "scheduled");
    assert.equal(scheduled.post.approvedAt, null);
    await f.ctx.db.execute(
      `UPDATE ${SCHEMA}.social_posts SET scheduled_at=now()-interval '1 second' WHERE id=$1`,
      [post.id],
    );
    let writes = 0;
    const result = await serviceTriggerScheduledJob(f.ctx, f.companyId, f.config, async () => {
      writes++;
      return new Response(JSON.stringify({ data: { id: "123123" } }));
    });
    assert.equal(result.results[0].result.status, "published");
    assert.equal(writes, 1);
  } finally {
    await f.close();
  }
});

test("destination deduplication ignores new post identifiers and changed tracking parameters", async () => {
  const f = await liveFixture();
  try {
    await updateAccount(f.ctx, f.companyId, f.accountId, { dailyLimit: 10 });
    const common = {
      platforms: ["x"],
      dryRun: false,
      targets: [{ platform: "x", accountId: f.accountId }],
      platformCustomizations: { x: { text: "O mesmo conteúdo personalizado do Tessel." } },
      linkUrl: "https://tessel.app/",
    };
    const first = await pending(f, draftInput({ ...common, text: "Primeiro rascunho base" }));
    await approve(f, first);
    const second = await pending(f, draftInput({ ...common, text: "Segundo rascunho base" }));
    await approve(f, second);
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return new Response(JSON.stringify({ data: { id: "one-only" } }));
    };
    assert.equal(
      (
        await servicePublishPost(
          f.ctx,
          f.companyId,
          { postId: first.id },
          f.actor,
          f.config,
          fetchImpl,
        )
      ).status,
      "published",
    );
    const duplicate = await servicePublishPost(
      f.ctx,
      f.companyId,
      { postId: second.id },
      f.actor,
      f.config,
      fetchImpl,
    );
    assert.equal(duplicate.status, "failed");
    assert.equal(duplicate.receipts[0].errorCode, "DUPLICATE_DESTINATION_CONTENT");
    assert.equal(calls, 1);
  } finally {
    await f.close();
  }
});

test("validation uses the exact final text and tracked link that the adapter publishes", async () => {
  const f = await databaseContext();
  try {
    const { post } = await serviceCreateDraft(
      f.ctx,
      f.companyId,
      draftInput({ platforms: ["threads"], text: "A".repeat(450), linkUrl: "https://tessel.app/" }),
      f.actor,
      f.config,
    );
    const { serviceValidatePost } = await import("../src/service.js");
    const result = await serviceValidatePost(f.ctx, f.companyId, { postId: post.id }, f.config);
    assert.equal(result.valid, false);
    assert.equal(result.publicationReady, false);
    assert.ok(result.errors.some((error) => error.includes("500")));
    await assert.rejects(
      serviceRequestApproval(f.ctx, f.companyId, { postId: post.id }, f.actor, f.config),
      /CONTENT_OR_FACTUAL_EVIDENCE_NOT_READY/,
    );
    await assert.rejects(
      serviceCreateDraft(
        f.ctx,
        f.companyId,
        draftInput({ version: 2, rootPostId: randomUUID() }),
        f.actor,
        f.config,
      ),
      /REVISION_API_REQUIRED/,
    );
  } finally {
    await f.close();
  }
});

test("retry after UTC day rollover reserves the new day's quota and cost budget", async () => {
  const f = await liveFixture();
  try {
    const p = await pending(
      f,
      draftInput({
        platforms: ["x"],
        dryRun: false,
        targets: [{ platform: "x", accountId: f.accountId }],
      }),
    );
    await approve(f, p);
    const first = await servicePublishPost(
      f.ctx,
      f.companyId,
      { postId: p.id },
      f.actor,
      f.config,
      async () =>
        new Response(JSON.stringify({ title: "Limit" }), {
          status: 429,
          headers: { "retry-after": "1" },
        }),
    );
    assert.equal(first.status, "retry");
    const receipt = first.receipts[0];
    await recordReceipt(f.ctx, f.companyId, {
      ...receipt,
      checkpoint: { ...receipt.checkpoint, budgetReservedDate: "2000-01-01" },
      nextAttemptAt: new Date(Date.now() - 1000).toISOString(),
    });
    await f.ctx.db.execute(
      `UPDATE ${SCHEMA}.social_accounts SET last_reset_date='2000-01-01',posts_today=1,cost_today_cents=0 WHERE id=$1`,
      [f.accountId],
    );
    await f.ctx.db.execute(
      `UPDATE ${SCHEMA}.social_posts SET next_attempt_at=now()-interval '1 second' WHERE id=$1`,
      [p.id],
    );
    const result = await serviceTriggerScheduledJob(
      f.ctx,
      f.companyId,
      f.config,
      async () => new Response(JSON.stringify({ data: { id: "after-rollover" } })),
    );
    assert.equal(result.results[0].result.status, "published");
    const rows = await f.ctx.db.query(
      `SELECT last_reset_date,posts_today FROM ${SCHEMA}.social_accounts WHERE id=$1`,
      [f.accountId],
    );
    assert.equal(rows[0].last_reset_date, new Date().toISOString().slice(0, 10));
    assert.equal(rows[0].posts_today, 1);
    assert.equal(
      result.results[0].result.receipts[0].checkpoint.budgetReservedDate,
      new Date().toISOString().slice(0, 10),
    );
  } finally {
    await f.close();
  }
});

test("revision validates destinations before superseding and recovers an interrupted next-version insert idempotently", async () => {
  const f = await databaseContext();
  try {
    const { post } = await serviceCreateDraft(f.ctx, f.companyId, draftInput(), f.actor, f.config);
    await assert.rejects(
      serviceReviseDraft(
        f.ctx,
        f.companyId,
        { postId: post.id, version: 1, targets: [{ platform: "x", accountId: randomUUID() }] },
        f.actor,
        f.config,
      ),
      /ACCOUNT_NOT_FOUND/,
    );
    assert.equal((await getPost(f.ctx, f.companyId, post.id)).status, "draft");
    const execute = f.ctx.db.execute;
    let fail = true;
    f.ctx.db.execute = async (sql, values) => {
      if (fail && sql.includes("INSERT INTO") && sql.includes(".social_posts")) {
        fail = false;
        throw new Error("simulated database interruption");
      }
      return execute(sql, values);
    };
    const input = {
      postId: post.id,
      version: 1,
      text: "Versão corrigida com evidência do Tessel.",
    };
    await assert.rejects(
      serviceReviseDraft(f.ctx, f.companyId, input, f.actor, f.config),
      /simulated database interruption/,
    );
    assert.equal((await getPost(f.ctx, f.companyId, post.id)).status, "superseded");
    const resumed = await serviceReviseDraft(f.ctx, f.companyId, input, f.actor, f.config);
    assert.equal(resumed.post.version, 2);
    assert.equal(resumed.post.status, "draft");
    const replay = await serviceReviseDraft(f.ctx, f.companyId, input, f.actor, f.config);
    assert.equal(replay.post.id, resumed.post.id);
  } finally {
    await f.close();
  }
});

for (const mode of ["expired", "near-expiry"])
  test(`publication automatically refreshes ${mode} OAuth credentials before provider writes`, async () => {
    const f = await liveFixture(mode === "near-expiry" ? 60 : 7200);
    try {
      const p = await pending(
        f,
        draftInput({
          platforms: ["x"],
          dryRun: false,
          targets: [{ platform: "x", accountId: f.accountId }],
        }),
      );
      await approve(f, p);
      if (mode === "expired")
        await f.ctx.db.execute(
          `UPDATE ${SCHEMA}.social_oauth_tokens SET expires_at=now()-interval '1 minute' WHERE account_id=$1`,
          [f.accountId],
        );
      const original = f.ctx.http.fetch;
      let refreshes = 0;
      f.ctx.http.fetch = async (url, init) => {
        if (new URL(url).pathname === "/2/oauth2/token") {
          assert.equal(new URLSearchParams(init.body).get("grant_type"), "refresh_token");
          refreshes++;
          return new Response(
            JSON.stringify({
              access_token: "refreshed-token",
              refresh_token: "rotated-refresh",
              scope: OAUTH_SCOPES.x.join(" "),
              expires_in: 7200,
            }),
          );
        }
        return original(url, init);
      };
      let writes = 0;
      const result = await servicePublishPost(
        f.ctx,
        f.companyId,
        { postId: p.id },
        f.actor,
        f.config,
        async (_url, init) => {
          writes++;
          assert.equal(init.headers.Authorization, "Bearer refreshed-token");
          return new Response(JSON.stringify({ data: { id: "refreshed-post" } }));
        },
      );
      assert.equal(result.status, "published");
      assert.equal(refreshes, 1);
      assert.equal(writes, 1);
    } finally {
      await f.close();
    }
  });

test("failed pre-write refresh is an authorization block and founder can resume only after reconnect", async () => {
  const f = await liveFixture();
  try {
    const p = await pending(
      f,
      draftInput({
        platforms: ["x"],
        dryRun: false,
        targets: [{ platform: "x", accountId: f.accountId }],
      }),
    );
    await approve(f, p);
    await f.ctx.db.execute(
      `UPDATE ${SCHEMA}.social_oauth_tokens SET expires_at=now()-interval '1 minute' WHERE account_id=$1`,
      [f.accountId],
    );
    const original = f.ctx.http.fetch;
    f.ctx.http.fetch = async (url, init) =>
      new URL(url).pathname === "/2/oauth2/token"
        ? new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
        : original(url, init);
    let writes = 0;
    const result = await servicePublishPost(
      f.ctx,
      f.companyId,
      { postId: p.id },
      f.actor,
      f.config,
      async () => {
        writes++;
      },
    );
    assert.equal(result.status, "failed");
    assert.equal(result.receipts[0].status, "blocked");
    assert.equal(result.receipts[0].errorCode, "AUTH_REAUTH_REQUIRED");
    assert.equal(writes, 0);
    assert.equal(result.receipts[0].platformPostId, null);
    await assert.rejects(
      serviceRetryAuthorization(f.ctx, f.companyId, { postId: p.id }, f.actor, f.config),
      /Founder/,
    );
    f.ctx.http.fetch = original;
    const retry = await serviceRetryAuthorization(
      f.ctx,
      f.companyId,
      { postId: p.id },
      f.human,
      f.config,
    );
    assert.equal(retry.status, "retry");
    const resumed = await serviceTriggerScheduledJob(f.ctx, f.companyId, f.config, async () => {
      writes++;
      return new Response(JSON.stringify({ data: { id: "authorized-again" } }));
    });
    assert.equal(resumed.results[0].result.status, "published");
    assert.equal(writes, 1);
  } finally {
    await f.close();
  }
});

test("status compare-and-swap parameters comply with the host SDK scalar binding contract", async () => {
  const f = await databaseContext();
  try {
    const execute = f.ctx.db.execute;
    f.ctx.db.execute = (query, parameters) => {
      assert.ok(
        parameters.every((value) => !Array.isArray(value)),
        "SDK arrays are SQL lists, not PostgreSQL array parameters",
      );
      return execute(query, parameters);
    };
    const post = await pending(f);
    await approve(f, post);
    await serviceSchedulePost(
      f.ctx,
      f.companyId,
      { postId: post.id, scheduledAt: new Date(Date.now() + 60000).toISOString() },
      f.actor,
      f.config,
    );
    const result = await serviceCancelPost(
      f.ctx,
      f.companyId,
      { postId: post.id },
      f.actor,
      f.config,
    );
    assert.equal(result.status, "cancelled");
  } finally {
    await f.close();
  }
});
