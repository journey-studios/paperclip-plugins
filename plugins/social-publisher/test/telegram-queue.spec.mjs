import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { databaseContext, draftInput, SCHEMA } from "./helpers.mjs";
import { getPost, listReceiptsForPost } from "../src/catalog.js";
import { reconcileTelegramApprovals } from "../src/telegram-sync.js";
import { serviceCreateDraft, serviceRequestApproval, serviceDecideApproval, serviceReviseDraft, servicePublishPost, serviceCancelPost } from "../src/service.js";

async function fixture(t) {
  const f = await databaseContext();
  t.after(f.close);
  f.interactions = [];
  f.asks = 0;
  f.writes = 0;
  f.ctx.http = { fetch: async () => { f.writes++; throw new Error("NO_SOCIAL_PROVIDER_WRITE"); } };
  f.ctx.issues.listInteractions = async (issueId, companyId) => f.interactions.filter((item) => item.issueId === issueId && item.companyId === companyId);
  f.ctx.issues.askUserQuestions = async (issueId, input, companyId, actor) => {
    const existing = f.interactions.find((item) => item.idempotencyKey === input.idempotencyKey);
    if (existing) { assert.deepEqual(existing.payload, input.payload); return existing; }
    f.asks++;
    const id = randomUUID();
    // Reproduce the real native host: same-author sibling asks expire on new question creation.
    for (const older of f.interactions) if (older.status === "pending" && older.kind === "ask_user_questions" && older.createdByAgentId === actor.authorAgentId) {
      older.status = "expired";
      older.result = { version: 1, answers: [], expirationReason: "superseded_by_newer_interaction", supersededByInteractionId: id };
    }
    const normalized = structuredClone(input);
    for (const question of normalized.payload.questions) {
      question.id = question.id.trim();
      question.prompt = question.prompt.trim();
      if (question.helpText) question.helpText = question.helpText.trim();
      for (const option of question.options) { option.id = option.id.trim(); option.label = option.label.trim(); }
    }
    const native = { ...normalized, id, companyId, issueId, createdByAgentId: actor.authorAgentId, kind: "ask_user_questions", status: "pending" };
    f.interactions.push(native);
    return native;
  };
  f.create = async (label) => (await serviceCreateDraft(f.ctx, f.companyId, draftInput({ text: `Tessel editorial ${label}`, idempotencyKey: label }), f.actor, f.config)).post;
  f.request = (post) => serviceRequestApproval(f.ctx, f.companyId, { postId: post.id }, f.actor, f.config);
  f.reconcile = (ctx = f.ctx) => reconcileTelegramApprovals(ctx, f.companyId, f.config);
  f.answer = (native, decision = "approved", userId = f.founderId) => Object.assign(native, {
    status: "answered", resolvedByUserId: userId, resolvedByAgentId: null,
    result: { version: 1, answers: [{ questionId: "social_decision", optionIds: [decision] }] },
  });
  return f;
}

test("two posts wait for sequential human answers without the native host superseding either question", async (t) => {
  const f = await fixture(t);
  const first = await f.create("first");
  const second = await f.create("second");
  const requested = await f.request(first);
  const queued = await f.request(second);
  assert.equal(requested.delivery.status, "queued_by_native_host");
  assert.equal(queued.delivery.status, "queued");
  assert.equal(queued.post.approvalRequestId, null);
  assert.equal(f.asks, 1);
  assert.equal(f.interactions[0].status, "pending");
  assert.equal((await f.reconcile()).waiting, 1);
  assert.equal(f.asks, 1);
  f.answer(f.interactions[0]);
  const tick = await f.reconcile({ ...f.ctx }); // New worker context, same durable queue and native records.
  assert.equal(tick.applied, 1);
  assert.equal(tick.submitted, 1);
  assert.equal(f.asks, 2);
  assert.equal(f.interactions[0].status, "answered");
  assert.equal(f.interactions[1].status, "pending");
  assert.equal((await getPost(f.ctx, f.companyId, first.id)).status, "approved");
  assert.equal((await getPost(f.ctx, f.companyId, second.id)).approvalRequestId, f.interactions[1].id);
  f.answer(f.interactions[1], "approved", "another-human");
  assert.equal((await f.reconcile()).applied, 0);
  assert.equal((await getPost(f.ctx, f.companyId, second.id)).status, "pending_approval");
  f.answer(f.interactions[1]);
  assert.equal((await f.reconcile()).applied, 1);
  for (const post of [first, second]) assert.equal((await servicePublishPost(f.ctx, f.companyId, { postId: post.id }, f.actor, f.config)).status, "dry_run_completed");
  assert.equal(f.writes, 0);
});

test("concurrent Social requests serialize the conversation and retain one queued post", async (t) => {
  const f = await fixture(t);
  const first = await f.create("concurrent-first");
  const second = await f.create("concurrent-second");
  const results = await Promise.all([f.request(first), f.request(second)]);
  assert.equal(results.filter((result) => result.delivery.interactionId).length, 1);
  assert.equal(results.filter((result) => result.delivery.status === "queued").length, 1);
  assert.equal(f.interactions.filter((item) => item.status === "pending").length, 1);
  assert.equal(f.asks, 1);
});

test("native expiry, cancellation and local TTL become explicit system expiry; old callbacks cannot approve or publish", async (suite) => {
  for (const kind of ["native_expired", "native_cancelled", "external_supersede", "local_ttl"]) await suite.test(kind, async (t) => {
    const f = await fixture(t);
    const post = await f.create(kind);
    await f.request(post);
    const native = f.interactions[0];
    if (kind === "local_ttl") await f.ctx.db.execute(`UPDATE ${SCHEMA}.social_posts SET approval_expires_at=now()-interval '1 second' WHERE id=$1`, [post.id]);
    else if (kind === "native_cancelled") Object.assign(native, { status: "cancelled", result: { cancelled: true, answers: [] } });
    else Object.assign(native, { status: "expired", result: kind === "external_supersede" ? { expirationReason: "superseded_by_newer_interaction", answers: [] } : {} });
    assert.equal((await f.reconcile()).expired, 1);
    const expired = await getPost(f.ctx, f.companyId, post.id);
    assert.equal(expired.status, "approval_expired");
    assert.equal(expired.approvedBy, null);
    assert.equal(expired.approvalHash, null);
    const [audit] = await f.ctx.db.query(`SELECT actor_type,actor_id,action FROM ${SCHEMA}.social_audit_log WHERE action='approval_expired'`);
    assert.deepEqual(audit, { actor_type: "system", actor_id: "telegram_approval_queue", action: "approval_expired" });
    await assert.rejects(f.request(expired), /POST_CANNOT_REQUEST_APPROVAL/);
    await assert.rejects(servicePublishPost(f.ctx, f.companyId, { postId: post.id }, f.actor, f.config), /prevents publication/);
    const revised = (await serviceReviseDraft(f.ctx, f.companyId, { postId: post.id, version: post.version, text: "Nova versão editorial" }, f.actor, f.config)).post;
    assert.equal(revised.version, post.version + 1);
    assert.equal(revised.approvalRequestId, null);
    await f.request(revised);
    f.answer(native); // A delayed old callback cannot authorize the revised content.
    assert.equal((await f.reconcile()).applied, 0);
    assert.equal((await getPost(f.ctx, f.companyId, revised.id)).status, "pending_approval");
    assert.equal((await listReceiptsForPost(f.ctx, f.companyId, post.id)).length, 0);
    assert.equal(f.writes, 0);
  });
});

test("an unrelated native pending question blocks the queue, including after a worker restart", async (t) => {
  const f = await fixture(t);
  f.interactions.push({ id: randomUUID(), companyId: f.companyId, issueId: f.config.telegramConversationIssueId, kind: "ask_user_questions", status: "pending", createdByAgentId: f.config.telegramAgentId, idempotencyKey: "another-plugin-question" });
  const post = await f.create("external-blocker");
  assert.equal((await f.request(post)).delivery.reason, "conversation_busy");
  assert.equal((await f.reconcile({ ...f.ctx })).waiting, 1);
  assert.equal(f.asks, 0);
  await f.ctx.db.execute(`UPDATE ${SCHEMA}.social_posts SET approval_expires_at=now()-interval '1 second' WHERE id=$1`, [post.id]);
  assert.equal((await f.reconcile()).expired, 1);
  assert.equal((await getPost(f.ctx, f.companyId, post.id)).status, "approval_expired");
  assert.equal(f.interactions[0].status, "pending");
});

test("only a proven obsolete Social question may be ignored when admitting the next post", async (t) => {
  const f = await fixture(t);
  const old = await f.create("cancel-old");
  await f.request(old);
  await serviceCancelPost(f.ctx, f.companyId, { postId: old.id }, f.actor, f.config);
  const next = await f.create("after-cancel");
  assert.equal((await f.request(next)).delivery.status, "queued_by_native_host");
  assert.equal(f.asks, 2);
  assert.equal(f.interactions[0].status, "expired");
  assert.equal((await getPost(f.ctx, f.companyId, old.id)).status, "cancelled");
  assert.equal(f.interactions[1].status, "pending");
});

test("native receipts recover the same question after crashes before state acknowledgement or the post receipt", async (suite) => {
  for (const point of ["binding", "post_receipt"]) await suite.test(point, async (t) => {
    const f = await fixture(t);
    const post = await f.create(`crash-${point}`);
    const stateSet = f.ctx.state.set;
    const dbExecute = f.ctx.db.execute;
    let failOnce = true;
    if (point === "binding") f.ctx.state.set = async (key, value) => {
      if (value.interactionId && failOnce) { failOnce = false; throw new Error("simulated restart after native ask"); }
      return stateSet(key, value);
    };
    else f.ctx.db.execute = async (sql, values) => {
      if (sql.startsWith("UPDATE") && sql.includes("approval_request_id") && values[2] === "pending_approval" && failOnce) { failOnce = false; throw new Error("simulated restart before post receipt"); }
      return dbExecute(sql, values);
    };
    await assert.rejects(f.request(post), /simulated restart/);
    assert.equal(f.asks, 1);
    assert.equal((await getPost(f.ctx, f.companyId, post.id)).approvalRequestId, null);
    f.ctx.state.set = stateSet;
    f.ctx.db.execute = dbExecute;
    await f.reconcile({ ...f.ctx });
    const recovered = await getPost(f.ctx, f.companyId, post.id);
    assert.equal(recovered.approvalRequestId, f.interactions[0].id);
    assert.equal((await f.request(recovered)).delivery.replayed, true);
    assert.equal(f.asks, 1);
    f.answer(f.interactions[0]);
    assert.equal((await f.reconcile()).applied, 1);
    assert.equal(f.writes, 0);
  });
});

test("recovery refuses any changed presentation, addressee, resolver, author or target scope", async (suite) => {
  for (const field of ["preview", "questionSet", "description", "freeText", "submitLabel", "addressee", "resolver", "author", "company"]) await suite.test(field, async (t) => {
    const f = await fixture(t);
    const post = await f.create(`tamper-${field}`);
    await f.request(post);
    const native = f.interactions[0];
    if (field === "preview") native.payload.questions[0].helpText = "different content";
    if (field === "questionSet") native.payload.questionSet = {
      schema: "paperclip.question_set.v1",
      questions: [{ id: "social_decision", prompt: "Confirmar leitura", required: true, answerMode: "single_select", options: [{ id: "approved", label: "Li o aviso" }] }],
    };
    if (field === "description") native.payload.questions[0].options[0].description = "Only acknowledge reading; no publishing consent";
    if (field === "freeText") native.payload.questions[0].options[0].freeText = true;
    if (field === "submitLabel") native.payload.submitLabel = "Confirm reading only";
    if (field === "addressee") native.addresseeUserId = "another-human";
    if (field === "resolver") native.resolverPolicy = "human_or_agent";
    if (field === "author") native.createdByAgentId = randomUUID();
    if (field === "company") { native.companyId = randomUUID(); f.ctx.issues.listInteractions = async () => f.interactions; }
    f.answer(native);
    await assert.rejects(f.reconcile(), /TELEGRAM_APPROVAL_BINDING_MISMATCH/);
    assert.equal((await getPost(f.ctx, f.companyId, post.id)).status, "pending_approval");
    assert.equal((await listReceiptsForPost(f.ctx, f.companyId, post.id)).length, 0);
    assert.equal(f.asks, 1);
  });
});

test("a genuine human rejection ends the version and never becomes a system expiry", async (t) => {
  const f = await fixture(t);
  const post = await f.create("rejected");
  await f.request(post);
  f.answer(f.interactions[0], "rejected");
  const result = await f.reconcile();
  assert.equal(result.applied, 1);
  assert.equal(result.expired, 0);
  assert.equal((await getPost(f.ctx, f.companyId, post.id)).status, "rejected");
  await assert.rejects(servicePublishPost(f.ctx, f.companyId, { postId: post.id }, f.actor, f.config), /prevents publication/);
  assert.equal(f.writes, 0);
});

test("an external ask after Social supersedes its question and expires the version without issuing a replacement", async (t) => {
  const f = await fixture(t);
  const post = await f.create("external-after-social");
  await f.request(post);
  await f.ctx.issues.askUserQuestions(f.config.telegramConversationIssueId, {
    idempotencyKey: "another-plugin-after-social", resolverPolicy: "human_only", addresseeUserId: f.founderId,
    payload: { version: 1, questions: [] },
  }, f.companyId, { authorAgentId: f.config.telegramAgentId });
  assert.equal(f.interactions[0].status, "expired");
  assert.equal((await f.reconcile()).expired, 1);
  assert.equal((await getPost(f.ctx, f.companyId, post.id)).status, "approval_expired");
  await assert.rejects(f.request(post), /POST_CANNOT_REQUEST_APPROVAL/);
  assert.equal(f.asks, 2);
  assert.equal(f.interactions[1].status, "pending");
  assert.equal(f.writes, 0);
});

test("the SDK list/create gap can supersede an external ask arriving before Social; it still cannot authorize publication", async (t) => {
  const f = await fixture(t);
  const post = await f.create("external-between-list-and-ask");
  const create = f.ctx.issues.askUserQuestions;
  let once = true;
  f.ctx.issues.askUserQuestions = async (issueId, input, companyId, actor) => {
    if (once) {
      once = false;
      await create(issueId, { idempotencyKey: "external-race", resolverPolicy: "human_only", addresseeUserId: f.founderId, payload: { version: 1, questions: [] } }, companyId, actor);
    }
    return create(issueId, input, companyId, actor);
  };
  const requested = await f.request(post);
  assert.equal(f.interactions[0].status, "expired"); // Native API has no compare-and-create condition.
  assert.equal(f.interactions[0].result.supersededByInteractionId, requested.post.approvalRequestId);
  assert.equal(f.interactions[1].status, "pending");
  assert.equal((await servicePublishPost(f.ctx, f.companyId, { postId: post.id }, f.actor, f.config)).status, "pending_approval");
  assert.equal(f.writes, 0);
});

test("equal queue timestamps use the post ID as a stable FIFO tie breaker after restart", async (t) => {
  const f = await fixture(t);
  const blocker = { id: randomUUID(), companyId: f.companyId, issueId: f.config.telegramConversationIssueId, kind: "ask_user_questions", status: "pending", idempotencyKey: "unrelated" };
  f.interactions.push(blocker);
  const first = await f.create("same-time-first");
  const second = await f.create("same-time-second");
  await f.request(first);
  await f.request(second);
  await f.ctx.db.execute(`UPDATE ${SCHEMA}.social_posts SET created_at='2026-10-26T00:00:00Z' WHERE company_id=$1`, [f.companyId]);
  const [head, tail] = [first.id, second.id].sort();
  blocker.status = "answered";
  const result = await f.reconcile({ ...f.ctx });
  assert.equal(result.submitted, 1);
  assert.equal((await getPost(f.ctx, f.companyId, head)).approvalRequestId, f.interactions[1].id);
  assert.equal((await getPost(f.ctx, f.companyId, tail)).approvalRequestId, null);
  assert.equal(f.interactions[1].status, "pending");
});

test("a cancelled post without its durable ownership proof cannot release a pending native question", async (t) => {
  const f = await fixture(t);
  const old = await f.create("missing-proof-old");
  await f.request(old);
  await serviceCancelPost(f.ctx, f.companyId, { postId: old.id }, f.actor, f.config);
  f.state.clear();
  const next = await f.create("missing-proof-next");
  assert.equal((await f.request(next)).delivery.reason, "conversation_busy");
  assert.equal(f.asks, 1);
  assert.equal(f.interactions[0].status, "pending");
});

test("host-normalized nullable presentation fields preserve the exact critical preview and binding", async (t) => {
  const f = await fixture(t);
  const post = await f.create("normalized-host");
  await f.request(post);
  const native = f.interactions[0];
  native.effectiveResolverPolicy = "human_only";
  native.payload.submitLabel = null;
  for (const option of native.payload.questions[0].options) option.description = null;
  const replay = await f.request(post);
  assert.equal(replay.delivery.interactionId, native.id);
  assert.equal(replay.delivery.replayed, true);
  assert.equal(f.asks, 1);
});

test("the native host's helpText trim cannot poison a valid post whose factual source ends in whitespace", async (t) => {
  const f = await fixture(t);
  const input = draftInput({ metadata: { factualEvidence: [{ claim: "Released Tessel campaigns", sourceUrl: "https://tessel.app/\n", releaseStatus: "released" }] } });
  const created = await serviceCreateDraft(f.ctx, f.companyId, input, f.actor, f.config);
  assert.equal(created.validation.publicationReady, true);
  const requested = await f.request(created.post);
  const help = f.interactions[0].payload.questions[0].helpText;
  assert.equal(help, help.trim());
  assert.equal(requested.delivery.interactionId, f.interactions[0].id);
  assert.equal((await f.request(requested.post)).delivery.replayed, true);
  f.answer(f.interactions[0]);
  assert.equal((await f.reconcile()).applied, 1);
  assert.equal(f.asks, 1);
});

test("an overlong but factual presentation stays a draft and cannot poison the next post's approval", async (t) => {
  const f = await fixture(t);
  const input = draftInput({ metadata: { factualEvidence: [{ claim: "a".repeat(4000), sourceUrl: "https://tessel.app/", releaseStatus: "released" }] } });
  const bad = (await serviceCreateDraft(f.ctx, f.companyId, input, f.actor, f.config)).post;
  await assert.rejects(f.request(bad), /TELEGRAM_PREVIEW_TOO_LONG/);
  assert.equal((await getPost(f.ctx, f.companyId, bad.id)).status, "draft");
  assert.equal(f.asks, 0);
  const good = await f.create("after-overlong");
  assert.equal((await f.request(good)).delivery.status, "queued_by_native_host");
  assert.equal(f.asks, 1);
});

test("a legacy pending post with a permanent preparation failure expires without blocking the next queued post", async (t) => {
  const f = await fixture(t);
  const bad = (await serviceCreateDraft(f.ctx, f.companyId, draftInput({ metadata: { factualEvidence: [{ claim: "b".repeat(4000), sourceUrl: "https://tessel.app/", releaseStatus: "released" }] } }), f.actor, f.config)).post;
  await f.ctx.db.execute(`UPDATE ${SCHEMA}.social_posts SET status='pending_approval',approval_expires_at=now()+interval '1 hour' WHERE id=$1`, [bad.id]);
  const good = await f.create("after-legacy-poison");
  assert.equal((await f.request(good)).delivery.reason, "earlier_approval_waiting");
  const result = await f.reconcile();
  assert.equal(result.expired, 1);
  assert.equal(result.submitted, 1);
  assert.equal((await getPost(f.ctx, f.companyId, bad.id)).status, "approval_expired");
  assert.equal((await getPost(f.ctx, f.companyId, good.id)).approvalRequestId, f.interactions[0].id);
  assert.equal(f.asks, 1);
});
