import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { databaseContext, draftInput, SCHEMA } from "./helpers.mjs";
import { enrollMedia, listEnrolledMedia, resolvePublicationMedia, approvalMediaLinks, getMediaPreview } from "../src/media.js";
import { contentHash, getPost, listReceiptsForPost } from "../src/catalog.js";
import { checkpointOf } from "../src/adapters/common.js";
import { ThreadsAdapter } from "../src/adapters/threads.js";
import plugin from "../src/plugin.js";
import manifest from "../src/manifest.js";
import { approvalMatches } from "../src/governance.js";
import { serviceCreateDraft, servicePreviewPost, channelContent, serviceRequestApproval, serviceDecideApproval, servicePublishPost, serviceReviseDraft } from "../src/service.js";

const { S3Client } = createRequire(new URL("../../s3-storage/package.json", import.meta.url))("@aws-sdk/client-s3");
const jpeg = await readFile(new URL("./fixtures/editorial.jpg", import.meta.url));
const sha256 = createHash("sha256").update(jpeg).digest("hex");

test("the existing production 0.2.3 text approval keeps its exact legacy content hash after migration", async () => {
  const post = JSON.parse(await readFile(new URL("./fixtures/legacy-v023-post.json", import.meta.url), "utf8"));
  const expected = "713b8b63a2d1c39cb4c39c6aed58ad39df5ccb043e397f4d070c37985a116621";
  assert.equal(post.id, "b9649fc2-879e-43e6-9778-6b87229644c7");
  assert.equal(contentHash(post), expected);
  assert.equal(contentHash({ ...post, mediaRefs: [] }), expected);
  assert.equal(approvalMatches({ ...post, mediaRefs: [], approvedAt: new Date().toISOString(), approvedBy: "human", approvalHash: expected, approvalExpiresAt: new Date(Date.now() + 60000).toISOString() }), true);
});

async function fixture(t) {
  const storage = {
    provider: "backblaze", endpoint: "https://s3.us-east-005.backblazeb2.com",
    region: "us-east-005", bucket: "journey-paperclip", prefix: "paperclip",
    urlTtlSeconds: 300, forcePathStyle: false,
    accessKeyIdRef: { type: "secret_ref", secretId: randomUUID() },
    secretAccessKeyRef: { type: "secret_ref", secretId: randomUUID() },
  };
  const f = await databaseContext({ mediaStorage: storage });
  t.after(f.close);
  f.projectId = randomUUID();
  f.objectId = randomUUID();
  f.ctx.projects.get = async (id, companyId) => id === f.projectId && companyId === f.companyId
    ? { id, companyId } : null;
  f.ctx.companies = { get: async (id) => id === f.companyId ? { id, issuePrefix: "JOU" } : null };
  f.secrets = [];
  f.ctx.secrets = { resolve: async (ref, scope) => {
    f.secrets.push({ ref, scope });
    assert.equal(scope.companyId, f.companyId);
    assert.ok(["mediaStorage.accessKeyIdRef", "mediaStorage.secretAccessKeyRef"].includes(scope.configPath));
    return ref.secretId === storage.accessKeyIdRef.secretId ? "TEST-ACCESS-KEY" : "test-signing-secret-not-real";
  } };
  f.calls = [];
  f.keyHash = sha256;
  f.head = { ContentLength: jpeg.length, ContentType: "image/jpeg", ETag: '"immutable-etag"', VersionId: "immutable-version", Metadata: { sha256, objectid: f.objectId } };
  f.bytes = jpeg;
  t.mock.method(S3Client.prototype, "send", async function(command) {
    f.calls.push({ operation: command.constructor.name, input: command.input });
    assert.equal(command.input.Bucket, storage.bucket);
    assert.equal(command.input.Key, `paperclip/companies/${f.companyId}/projects/${f.projectId}/sha256/${f.keyHash.slice(0, 2)}/${f.keyHash}`);
    if (command.constructor.name === "HeadObjectCommand") return f.head;
    if (command.constructor.name === "GetObjectCommand") return { Body: (async function* () { yield f.bytes; })() };
    throw new Error("unexpected provider operation");
  });
  f.input = { purpose: "social_publication", objectId: f.objectId, projectId: f.projectId, sha256, byteSize: jpeg.length, contentType: "image/jpeg", filename: "editorial.jpg" };
  f.enroll = () => enrollMedia(f.ctx, f.companyId, f.input, f.human, f.config);
  f.draft = async (extra = {}) => {
    const { media } = await f.enroll();
    return serviceCreateDraft(f.ctx, f.companyId, draftInput({ projectId: f.projectId, platforms: ["instagram", "threads"], mediaRefs: [{ id: media.id }], ...extra }), f.actor, f.config);
  };
  return f;
}

test("only the founder can deliberately enroll a finalized, bounded JPEG; model-facing data contains no provider capabilities", async (t) => {
  const f = await fixture(t);
  await assert.rejects(enrollMedia(f.ctx, f.companyId, f.input, f.actor, f.config), /MEDIA_FOUNDER_REQUIRED/);
  await assert.rejects(enrollMedia(f.ctx, f.companyId, { ...f.input, objectKey: "private/payroll.pdf" }, f.human, f.config), /JPEG_ENROLLMENT/);
  await assert.rejects(enrollMedia(f.ctx, f.companyId, { ...f.input, purpose: "private_document" }, f.human, f.config), /JPEG_ENROLLMENT/);
  assert.equal(f.calls.length, 0);
  const first = await f.enroll();
  const replay = await f.enroll();
  assert.equal(replay.media.id, first.media.id);
  assert.equal(first.media.contentType, "image/jpeg");
  assert.equal(first.media.width, 320);
  assert.ok(f.calls.some((call) => call.operation === "GetObjectCommand" && call.input.IfMatch && call.input.VersionId));
  const output = JSON.stringify(await listEnrolledMedia(f.ctx, f.companyId));
  for (const forbidden of ["secret_ref", "accessKey", "X-Amz-", "objectKey", "downloadUrl", "TEST-ACCESS-KEY"])
    assert.ok(!output.includes(forbidden), forbidden);
  const [audit] = await f.ctx.db.query(`SELECT details FROM ${SCHEMA}.social_audit_log WHERE action='social_media_enrolled' LIMIT 1`);
  assert.equal(audit.details.purpose, "social_publication");
  assert.ok(!JSON.stringify(audit).includes("X-Amz-"));
});

test("enrollment refuses another company/project, unfinalized object metadata, private documents and corrupt bytes", async (t) => {
  const f = await fixture(t);
  await assert.rejects(enrollMedia(f.ctx, randomUUID(), f.input, f.human, f.config), /MEDIA_PROJECT_NOT_IN_COMPANY/);
  await assert.rejects(enrollMedia(f.ctx, f.companyId, { ...f.input, projectId: randomUUID() }, f.human, f.config), /MEDIA_PROJECT_NOT_IN_COMPANY/);
  f.head.Metadata.objectid = randomUUID();
  await assert.rejects(f.enroll(), /social_media_not_finalized/);
  f.head.Metadata.objectid = f.objectId;
  f.head.ContentType = "application/pdf";
  await assert.rejects(f.enroll(), /social_media_not_finalized/);
  f.head.ContentType = "image/jpeg";
  f.bytes = Buffer.alloc(jpeg.length);
  await assert.rejects(f.enroll(), /social_media_digest_mismatch/);
  f.bytes = Buffer.from("%PDF-1.7 private document, deliberately mislabeled as JPEG\n");
  f.keyHash = createHash("sha256").update(f.bytes).digest("hex");
  f.input.sha256 = f.keyHash;
  f.input.byteSize = f.bytes.length;
  f.head.ContentLength = f.bytes.length;
  f.head.Metadata.sha256 = f.keyHash;
  await assert.rejects(f.enroll(), /social_media_jpeg_dimensions_invalid/);
  assert.deepEqual((await listEnrolledMedia(f.ctx, f.companyId)).media, []);
});

test("draft references are expanded server-side, scoped to project and hash, and reject arbitrary keys or expiring URLs", async (t) => {
  const f = await fixture(t);
  const { media } = await f.enroll();
  for (const input of [
    { mediaRefs: [{ ...media }] },
    { mediaRefs: [{ id: media.id, objectKey: "private.doc" }] },
    { mediaRefs: [{ id: media.id }], projectId: randomUUID() },
    { mediaRefs: [{ id: media.id }], mediaUrls: ["https://www.tessel.app/image.jpg"] },
    { mediaRefs: [], mediaUrls: ["https://journey-paperclip.s3.us-east-005.backblazeb2.com/image?X-Amz-Signature=private"] },
  ]) await assert.rejects(serviceCreateDraft(f.ctx, f.companyId, draftInput({ projectId: f.projectId, platforms: ["instagram"], ...input }), f.actor, f.config));
  const { post, validation } = await f.draft();
  assert.equal(validation.publicationReady, true);
  assert.equal(validation.platforms.instagram.mediaRequirements.dimensionsVerified, true);
  assert.equal(validation.platforms.instagram.mediaRequirements.verificationSource, "founder_enrolled_s3_jpeg");
  assert.ok(!validation.platforms.instagram.warnings.some((warning) => warning.includes("not verified by URL validation")));
  assert.deepEqual(post.mediaRefs, [media]);
  const preview = await servicePreviewPost(f.ctx, f.companyId, { postId: post.id }, f.config);
  assert.deepEqual(preview.previews.instagram.mediaRefs, [media]);
  assert.ok(!JSON.stringify(preview).includes("X-Amz-"));
  assert.ok(!JSON.stringify(post).includes("downloadUrl"));
  const override = await f.draft({ platformCustomizations: { threads: { mediaRefs: [] } } });
  assert.deepEqual(override.post.platformCustomizations.threads.mediaRefs, []);
  assert.deepEqual(channelContent(override.post, { platform: "threads" }).mediaUrls, []);
  assert.equal(channelContent(override.post, { platform: "threads" }).mediaRefs, undefined);
  assert.equal(channelContent(override.post, { platform: "instagram" }).mediaRefs.length, 1);
  await assert.rejects(serviceCreateDraft(f.ctx, randomUUID(), draftInput({ projectId: f.projectId, mediaRefs: [{ id: media.id }] }), f.actor, f.config), /SOCIAL_MEDIA_NOT_FOUND/);
});

test("expired GET capabilities are freshly signed while approved content and adapter resume fingerprints remain stable", async (t) => {
  const f = await fixture(t);
  const { post } = await f.draft();
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const content = channelContent(post, post.targets[0]);
  const account = { accountIdExternal: "instagram-account" };
  const first = await resolvePublicationMedia(f.ctx, f.companyId, content, f.config);
  const checkpoint = checkpointOf("instagram", account, first, "exact-version");
  t.mock.timers.tick(301000);
  const second = await resolvePublicationMedia(f.ctx, f.companyId, content, f.config);
  assert.notEqual(first.mediaUrls[0], second.mediaUrls[0]);
  assert.equal(new URL(second.mediaUrls[0]).searchParams.get("X-Amz-Expires"), "300");
  assert.equal(new URL(second.mediaUrls[0]).searchParams.get("versionId"), "immutable-version");
  assert.deepEqual(checkpointOf("instagram", account, second, "exact-version", checkpoint), checkpoint);
  assert.equal(contentHash(await getPost(f.ctx, f.companyId, post.id)), post.contentHash);
  assert.ok(!JSON.stringify(checkpoint).includes("X-Amz-"));
  assert.throws(() => checkpointOf("instagram", account, { ...second, mediaRefs: [{ ...second.mediaRefs[0], sha256: "a".repeat(64) }] }, "exact-version", checkpoint), /checkpoint_scope_mismatch/);
});

test("issue-readable interactions persist only a stable authenticated page link, never a presigned URL", async (t) => {
  const f = await fixture(t);
  const { post } = await f.draft();
  const interactions = [];
  f.ctx.issues.askUserQuestions = async (issueId, body, companyId, actor) => {
    interactions.push(body);
    return { ...body, id: "native-media-test", companyId: f.companyId, issueId, kind: "ask_user_questions", status: "pending", createdByAgentId: actor.authorAgentId };
  };
  // GET /issues/:id/interactions exposes stored payloads to issue readers, regardless of human_only resolution.
  f.ctx.issues.listInteractions = async () => interactions;
  const readsBeforeApproval = f.calls.length;
  const result = await serviceRequestApproval(f.ctx, f.companyId, { postId: post.id }, f.actor, f.config);
  const help = interactions[0].payload.questions[0].helpText;
  assert.ok(help.includes("Ver JPEG"));
  const url = help.split("\n").find((line) => line.startsWith("https://paper.journeystudios.com.br/"));
  assert.equal(url, `https://paper.journeystudios.com.br/JOU/social-media-preview?mediaId=${post.mediaRefs[0].id}`);
  const issueReaderView = await f.ctx.issues.listInteractions(f.config.telegramConversationIssueId, f.companyId);
  for (const forbidden of ["X-Amz-", "downloadUrl", "TEST-ACCESS-KEY", "backblazeb2.com"])
    assert.ok(!JSON.stringify(issueReaderView).includes(forbidden), forbidden);
  assert.equal(f.calls.length, readsBeforeApproval);
  assert.equal(f.config.mediaStorage.urlTtlSeconds, 300);
  assert.ok(!JSON.stringify(result).includes("X-Amz-"));
  await serviceDecideApproval(f.ctx, f.companyId, { postId: post.id, version: post.version, contentHash: post.contentHash, targets: post.targets, interactionId: "native-media-test", decision: "approved" }, f.human, f.config);
  const readsBefore = f.calls.length;
  const complete = await servicePublishPost(f.ctx, f.companyId, { postId: post.id }, f.actor, f.config, () => { throw new Error("NO_PROVIDER_WRITE"); });
  assert.equal(complete.status, "dry_run_completed");
  assert.equal(f.calls.length, readsBefore);
  assert.equal((await listReceiptsForPost(f.ctx, f.companyId, post.id)).length, 2);
  const audit = await f.ctx.db.query(`SELECT details FROM ${SCHEMA}.social_audit_log`);
  assert.ok(!JSON.stringify({ complete, audit }).includes("X-Amz-"));
});

test("the founder Board preview mints a fresh 300 second image capability; agents and other users are denied", async (t) => {
  const f = await fixture(t);
  const { media } = await f.enroll();
  f.ctx.tools = { register() {} };
  f.ctx.jobs = { register() {} };
  await plugin.setup(f.ctx);
  const callsBefore = f.calls.length;
  for (const actor of [f.actor, { actorType: "user", actorId: "another-member" }]) {
    const denied = await plugin.onApiRequest({ companyId: f.companyId, routeKey: "media-preview", params: { mediaId: media.id }, actor });
    assert.equal(denied.status, 403);
    assert.ok(!JSON.stringify(denied).includes("X-Amz-"));
    await assert.rejects(getMediaPreview(f.ctx, f.companyId, media.id, actor, f.config), /MEDIA_FOUNDER_REQUIRED/);
  }
  assert.equal(f.calls.length, callsBefore);
  const first = await plugin.onApiRequest({ companyId: f.companyId, routeKey: "media-preview", params: { mediaId: media.id }, actor: f.human });
  assert.equal(first.status, 200);
  assert.equal(new URL(first.body.data.downloadUrl).searchParams.get("X-Amz-Expires"), "300");
  const declared = manifest.apiRoutes.find((entry) => entry.routeKey === "media-preview");
  assert.equal(declared.method, "GET");
  assert.equal(declared.auth, "board");
  assert.equal(declared.path, "/media/:mediaId/preview");
  assert.ok(manifest.capabilities.includes("ui.page.register"));
  assert.equal(manifest.ui.slots[0].exportName, "SocialMediaPreviewPage");
  const audit = await f.ctx.db.query(`SELECT details FROM ${SCHEMA}.social_audit_log`);
  assert.ok(!JSON.stringify(audit).includes("X-Amz-"));
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  t.mock.timers.tick(301000);
  const refreshed = await getMediaPreview(f.ctx, f.companyId, media.id, f.human, f.config);
  assert.notEqual(refreshed.downloadUrl, first.body.data.downloadUrl);
  assert.equal(new URL(refreshed.downloadUrl).searchParams.get("X-Amz-Expires"), "300");
});

test("media page links fail closed without validated company routing metadata", async (t) => {
  const f = await fixture(t);
  const { post } = await f.draft();
  f.ctx.companies.get = async () => ({ id: f.companyId, issuePrefix: "JOU/../../private" });
  await assert.rejects(approvalMediaLinks(f.ctx, f.companyId, post, f.config), /MEDIA_COMPANY_URL_PREFIX_UNAVAILABLE/);
});

test("stored reference tampering fails validation and a revision changes approval identity without signing a URL", async (t) => {
  const f = await fixture(t);
  const { post } = await f.draft();
  const revised = await serviceReviseDraft(f.ctx, f.companyId, { postId: post.id, version: post.version, text: "Nova legenda", platforms: post.platforms }, f.actor, f.config);
  assert.equal(revised.post.version, 2);
  assert.deepEqual(revised.post.mediaRefs, post.mediaRefs);
  assert.notEqual(revised.post.contentHash, post.contentHash);
  const changed = [{ ...post.mediaRefs[0], byteSize: 3 }];
  await f.ctx.db.execute(`UPDATE ${SCHEMA}.social_posts SET media_refs=$2::jsonb WHERE id=$1`, [revised.post.id, JSON.stringify(changed)]);
  await assert.rejects(serviceRequestApproval(f.ctx, f.companyId, { postId: revised.post.id }, f.actor, f.config), /MEDIA_REFERENCE_INTEGRITY_FAILURE/);
});

test("media processing retry preserves the remote container after the first signed URL has expired", async (t) => {
  const f = await fixture(t);
  const { post } = await f.draft({ platforms: ["threads"] });
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const content = channelContent(post, post.targets[0]);
  const account = { accountIdExternal: "threads-marketing", credentials: { accessToken: "test-provider-token" } };
  const adapter = new ThreadsAdapter();
  let containerCreates = 0;
  let publishes = 0;
  let finished = false;
  let checkpoint;
  const options = {
    account, idempotencyKey: "post:version:destination", mediaAllowedHosts: ["journey-paperclip.s3.us-east-005.backblazeb2.com"],
    onCheckpoint: async (value) => { checkpoint = structuredClone(value); },
    fetchImpl: async (raw, init) => {
      const url = new URL(raw);
      let body;
      if (url.pathname.endsWith("/threads")) { containerCreates++; body = { id: "container-existing" }; }
      else if (url.searchParams.get("fields") === "status") body = { status: finished ? "FINISHED" : "IN_PROGRESS" };
      else if (url.pathname.endsWith("/threads_publish")) { publishes++; body = { id: "published-final" }; }
      else if (url.pathname.endsWith("/published-final")) body = { id: "published-final", permalink: "https://www.threads.net/@tessel/post/example" };
      else throw new Error(`unexpected test provider request ${init.method}`);
      return new Response(JSON.stringify(body));
    },
  };
  const first = await resolvePublicationMedia(f.ctx, f.companyId, content, f.config);
  await assert.rejects(adapter.publish({ ...options, content: first }), (error) => error.code === "media_processing");
  assert.equal(checkpoint.containerId, "container-existing");
  t.mock.timers.tick(301000);
  finished = true;
  const second = await resolvePublicationMedia(f.ctx, f.companyId, content, f.config);
  assert.notEqual(first.mediaUrls[0], second.mediaUrls[0]);
  const receipt = await adapter.publish({ ...options, content: second, resume: checkpoint });
  assert.equal(receipt.platformPostId, "published-final");
  assert.equal(containerCreates, 1);
  assert.equal(publishes, 1);
  assert.ok(!JSON.stringify(receipt).includes("X-Amz-"));
});

test("media enrollment is a founder Board route and does not expand the native agent tool policy", async (t) => {
  const f = await fixture(t);
  const tools = new Map();
  f.ctx.tools = { register: (name, schema, handler) => tools.set(name, handler) };
  f.ctx.jobs = { register() {} };
  await plugin.setup(f.ctx);
  assert.equal(tools.size, 19);
  assert.equal(manifest.version, "0.2.5");
  assert.ok(![...tools.keys()].some((name) => /media.*enroll/i.test(name)));
  for (const actor of [f.actor, { actorType: "user", actorId: "another-board-member" }]) {
    const denied = await plugin.onApiRequest({ companyId: f.companyId, routeKey: "media-enroll", body: f.input, actor });
    assert.equal(denied.status, 403);
  }
  assert.equal(f.calls.length, 0);
  const enrolled = await plugin.onApiRequest({ companyId: f.companyId, routeKey: "media-enroll", body: f.input, actor: f.human });
  assert.equal(enrolled.status, 200);
  assert.equal(enrolled.body.data.media.sha256, sha256);
  const listed = await plugin.onApiRequest({ companyId: f.companyId, routeKey: "media-list", actor: f.human });
  assert.equal(listed.body.data.media[0].id, enrolled.body.data.media.id);
  assert.ok(!JSON.stringify(listed.body).includes("X-Amz-"));
});
