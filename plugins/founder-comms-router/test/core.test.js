import test from "node:test";
import assert from "node:assert/strict";
import { companyConfig, getLocalSlot, processEvent, runDigestJob, validateConfig } from "../src/core.js";

function makeContext(configs, issues = {}, approvals = {}, overrides = {}) {
  const state = new Map();
  const comments = [];
  const wakes = [];
  const companyIssueKey = (companyId, issueId) => `${companyId}:${issueId}`;
  const ctx = {
    config: { get: async (companyId) => configs[companyId] },
    state: {
      get: async (key) => {
        if (overrides.delayKnownCompanies && key.stateKey === "known-companies") await new Promise((resolve) => setTimeout(resolve, 2));
        return state.get(JSON.stringify(key));
      },
      set: async (key, value) => {
        if (overrides.delayKnownCompanies && key.stateKey === "known-companies") await new Promise((resolve) => setTimeout(resolve, 2));
        return state.set(JSON.stringify(key), structuredClone(value));
      },
      delete: async (key) => state.delete(JSON.stringify(key)),
    },
    issues: {
      get: async (issueId, companyId) => issues[companyIssueKey(companyId, issueId)] ?? null,
      list: async ({ companyId }) => Object.entries(issues)
        .filter(([key]) => key.startsWith(`${companyId}:`))
        .map(([, issue]) => issue),
      listComments: async (issueId, companyId) => issues[companyIssueKey(companyId, issueId)]?.comments ?? [],
      createComment: async (issueId, body, companyId) => {
        const entry = { issueId, body, companyId };
        if (overrides.createComment) return overrides.createComment(entry, comments);
        comments.push(entry);
      },
      requestWakeup: async (issueId, companyId, options) => wakes.push({ issueId, companyId, options }),
    },
    approvals: { get: async (id, companyId) => approvals[companyIssueKey(companyId, id)] ?? null },
    companies: {
      get: async (companyId) => overrides.company ? overrides.company(companyId) : (configs[companyId] ? { id: companyId } : null),
    },
    agents: {
      get: async (id, companyId) => overrides.agent ? overrides.agent(id, companyId) :
        (configs[companyId]?.liaisonAgentId === id ? { id, companyId } : null),
    },
    access: {
      members: {
        list: async ({ companyId }) => overrides.members ? overrides.members(companyId) : (configs[companyId]?.founderUserId ? [{
          companyId,
          principalType: "user",
          principalId: configs[companyId].founderUserId,
          status: "active",
        }] : []),
      },
    },
    projects: {
      get: async (id, companyId) => overrides.project ? overrides.project(id, companyId) :
        (configs[companyId]?.projectId === id ? { id, companyId } : null),
    },
    logger: { error() {} },
    inspect: { state, comments, wakes },
  };
  return ctx;
}

const chat = (id, originId, projectId = "project-a") => ({
  id,
  companyId: "companyA",
  originKind: "chat_channel",
  originId,
  assigneeAgentId: "liaison-a",
  createdByUserId: "founder-a",
  responsibleUserId: "founder-a",
  projectId,
  status: "open",
});

test("validates required settings, timezone, schedules, and optional IDs", () => {
  assert.deepEqual(validateConfig({
    liaisonAgentId: "agent-a",
    founderUserId: "user-1",
    digestTimezone: "Asia/Kolkata",
    digestTimes: ["09:30"],
    digestWeekdays: [1, 5],
    projectId: "project-a",
  }), { ok: true, errors: [] });
  const invalid = validateConfig({
    liaisonAgentId: "agent-a",
    founderUserId: "user-1",
    digestTimezone: "Not/A-Timezone",
    digestTimes: ["9:00"],
    digestWeekdays: [0],
    projectId: " ",
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.errors.length, 4);
});

test("rejects invalid timezone and schedule config instead of silently changing it", async () => {
  const ctx = makeContext({
    a: {
      liaisonAgentId: " agent-a ",
      founderUserId: " founder-a ",
      chatChannels: ["discord"],
      digestTimezone: "Asia/Kolkata",
      digestTimes: ["08:00", "17:00"],
      digestWeekdays: [2, 5, 2],
      projectId: "project-a",
    },
  });
  const config = await companyConfig(ctx, "a");
  assert.equal(config.liaisonAgentId, "agent-a");
  assert.deepEqual(config.chatChannels, ["discord"]);
  assert.equal(config.digestTimezone, "Asia/Kolkata");
  assert.deepEqual(config.digestTimes, ["08:00", "17:00"]);
  assert.deepEqual(config.digestWeekdays, [2, 5]);
  assert.equal(config.projectId, "project-a");
  const invalidCtx = makeContext({ a: { liaisonAgentId: "agent-a", founderUserId: "user-a", digestTimezone: "Bad/Timezone" } });
  await assert.rejects(companyConfig(invalidCtx, "a"), /valid IANA timezone/);
  const defaultCtx = makeContext({ a: { liaisonAgentId: "agent-a", founderUserId: "user-a" } });
  assert.equal((await companyConfig(defaultCtx, "a")).digestTimezone, "UTC");
});

test("routes immediate events to the configured company conversation and ignores repeats", async () => {
  const ctx = makeContext({
    companyA: {
      liaisonAgentId: "liaison-a",
      founderUserId: "founder-a",
      conversationIssueId: "chat-a",
      chatChannels: ["discord"],
    },
  }, {
    "companyA:chat-a": chat("chat-a", "source:discord:room-a"),
    "companyA:telegram-chat": chat("telegram-chat", "source:telegram:room-a"),
  }, {
    "companyA:approval-a": { id: "approval-a", companyId: "companyA", status: "pending", type: "budget" },
  });
  const event = {
    eventId: "event-1",
    eventType: "approval.created",
    entityId: "approval-a",
    companyId: "companyA",
  };
  await processEvent(ctx, event);
  await processEvent(ctx, event);
  assert.equal(ctx.inspect.comments.length, 1);
  assert.equal(ctx.inspect.comments[0].issueId, "chat-a");
  assert.equal(ctx.inspect.wakes.length, 1);
  assert.equal(ctx.inspect.wakes[0].companyId, "companyA");
  assert.match(ctx.inspect.comments[0].body, /approval\.created/);
});

test("issue attention alert retries after a transient comment failure", async () => {
  let failOnce = true;
  const ctx = makeContext({
    companyA: { liaisonAgentId: "liaison-a", founderUserId: "founder-a", conversationIssueId: "chat-a" },
  }, {
    "companyA:chat-a": chat("chat-a", "source:telegram:room-a"),
    "companyA:blocked-issue": {
      id: "blocked-issue",
      companyId: "companyA",
      identifier: "OPS-12",
      title: "Needs founder decision",
      status: "blocked",
      unblockDescriptor: { owner: "board" },
    },
  }, {}, {
    createComment: (entry, comments) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("temporary comment write failure");
      }
      comments.push(entry);
    },
  });
  const event = { eventId: "blocked-event", eventType: "issue.updated", entityId: "blocked-issue", companyId: "companyA" };
  await assert.rejects(processEvent(ctx, event), /temporary comment write failure/);
  await processEvent(ctx, event);
  assert.equal(ctx.inspect.comments.length, 1);
  assert.equal(ctx.inspect.wakes.length, 1);
});

test("immediateEnabled suppresses founder attention issue updates", async () => {
  const ctx = makeContext({
    companyA: {
      liaisonAgentId: "liaison-a",
      founderUserId: "founder-a",
      conversationIssueId: "chat-a",
      immediateEnabled: false,
    },
  }, {
    "companyA:chat-a": chat("chat-a", "source:telegram:room-a"),
    "companyA:blocked-issue": {
      id: "blocked-issue",
      companyId: "companyA",
      status: "blocked",
      unblockDescriptor: { owner: "board" },
    },
  });
  await processEvent(ctx, {
    eventId: "blocked-event",
    eventType: "issue.updated",
    entityId: "blocked-issue",
    companyId: "companyA",
  });
  assert.deepEqual(ctx.inspect.comments, []);
  assert.deepEqual(ctx.inspect.wakes, []);
});

test("concurrent events retain all companies for scheduled jobs", async () => {
  const ctx = makeContext({
    companyA: { liaisonAgentId: "liaison-a", founderUserId: "founder-a" },
    companyB: { liaisonAgentId: "liaison-b", founderUserId: "founder-b" },
  }, {}, {}, { delayKnownCompanies: true });
  await Promise.all([
    processEvent(ctx, { eventId: "event-a", eventType: "ignored", companyId: "companyA" }),
    processEvent(ctx, { eventId: "event-b", eventType: "ignored", companyId: "companyB" }),
  ]);
  assert.deepEqual(
    await ctx.state.get({ scopeKind: "instance", stateKey: "known-companies" }),
    ["companyA", "companyB"],
  );
});

test("company scoped issue reads prevent a configured ID from crossing companies", async () => {
  const ctx = makeContext({
    companyA: { liaisonAgentId: "liaison-a", founderUserId: "founder-a", conversationIssueId: "shared-id" },
    companyB: { liaisonAgentId: "liaison-a", founderUserId: "founder-a", conversationIssueId: "shared-id" },
  }, {
    "companyA:shared-id": chat("shared-id", "source:telegram:room-a"),
  }, {
    "companyB:approval-b": { id: "approval-b", companyId: "companyB", status: "pending", type: "security" },
  });
  await processEvent(ctx, {
    eventId: "event-b",
    eventType: "approval.created",
    entityId: "approval-b",
    companyId: "companyB",
  });
  assert.deepEqual(ctx.inspect.comments, []);
  assert.deepEqual(ctx.inspect.wakes, []);
});

test("conversation discovery respects the company, channel, and project filters", async () => {
  const ctx = makeContext({
    companyA: {
      liaisonAgentId: "liaison-a",
      founderUserId: "founder-a",
      chatChannels: ["discord"],
      projectId: "project-a",
    },
  }, {
    "companyA:chat-a": chat("chat-a", "source:discord:room-a", "project-a"),
    "companyA:other-project": chat("other-project", "source:discord:room-b", "project-b"),
    "companyA:other-channel": chat("other-channel", "source:telegram:room-c", "project-a"),
  }, {
    "companyA:approval-a": { id: "approval-a", companyId: "companyA", status: "pending", type: "review" },
  });
  await processEvent(ctx, {
    eventId: "event-a",
    eventType: "approval.created",
    entityId: "approval-a",
    companyId: "companyA",
  });
  assert.equal(ctx.inspect.comments.length, 1);
  assert.equal(ctx.inspect.comments[0].issueId, "chat-a");
});

test("routing requires the founder user to be an active member of the same company", async () => {
  const ctx = makeContext({
    companyA: { liaisonAgentId: "liaison-a", founderUserId: "founder-a", conversationIssueId: "chat-a" },
  }, { "companyA:chat-a": chat("chat-a", "source:telegram:room-a") }, {
    "companyA:approval-a": { id: "approval-a", companyId: "companyA", status: "pending", type: "review" },
  }, { members: () => [{ companyId: "company-other", principalType: "user", principalId: "founder-a", status: "active" }] });
  await processEvent(ctx, {
    eventId: "event-a",
    eventType: "approval.created",
    entityId: "approval-a",
    companyId: "companyA",
  });
  assert.deepEqual(ctx.inspect.comments, []);
  assert.deepEqual(ctx.inspect.wakes, []);
});

test("routing rejects a liaison agent outside the configured company", async () => {
  const ctx = makeContext({
    companyA: { liaisonAgentId: "liaison-a", founderUserId: "founder-a", conversationIssueId: "chat-a" },
  }, { "companyA:chat-a": chat("chat-a", "source:telegram:room-a") }, {
    "companyA:approval-a": { id: "approval-a", companyId: "companyA", status: "pending", type: "review" },
  }, { agent: () => ({ id: "liaison-a", companyId: "companyB" }) });
  await processEvent(ctx, {
    eventId: "event-a",
    eventType: "approval.created",
    entityId: "approval-a",
    companyId: "companyA",
  });
  assert.deepEqual(ctx.inspect.comments, []);
  assert.deepEqual(ctx.inspect.wakes, []);
});

test("routing rejects a company lookup that does not match the event company", async () => {
  const ctx = makeContext({
    companyA: { liaisonAgentId: "liaison-a", founderUserId: "founder-a", conversationIssueId: "chat-a" },
  }, { "companyA:chat-a": chat("chat-a", "source:telegram:room-a") }, {
    "companyA:approval-a": { id: "approval-a", companyId: "companyA", status: "pending", type: "review" },
  }, { company: () => ({ id: "company-other" }) });
  await processEvent(ctx, {
    eventId: "event-a",
    eventType: "approval.created",
    entityId: "approval-a",
    companyId: "companyA",
  });
  assert.deepEqual(ctx.inspect.comments, []);
  assert.deepEqual(ctx.inspect.wakes, []);
});

test("an explicit conversation is rejected when the configured project is unavailable", async () => {
  const ctx = makeContext({
    companyA: {
      liaisonAgentId: "liaison-a",
      founderUserId: "founder-a",
      conversationIssueId: "chat-a",
      projectId: "project-a",
    },
  }, { "companyA:chat-a": chat("chat-a", "source:telegram:room-a", "project-a") }, {
    "companyA:approval-a": { id: "approval-a", companyId: "companyA", status: "pending", type: "review" },
  }, { project: () => null });
  await processEvent(ctx, {
    eventId: "event-a",
    eventType: "approval.created",
    entityId: "approval-a",
    companyId: "companyA",
  });
  assert.deepEqual(ctx.inspect.comments, []);
  assert.deepEqual(ctx.inspect.wakes, []);
});

test("digest scheduler sends only at configured local slots with queued updates", async () => {
  const ctx = makeContext({
    companyA: {
      liaisonAgentId: "liaison-a",
      founderUserId: "founder-a",
      conversationIssueId: "chat-a",
      digestTimezone: "America/Sao_Paulo",
      digestTimes: ["09:00"],
      digestWeekdays: [1],
    },
  }, {
    "companyA:chat-a": chat("chat-a", "source:telegram:room-a"),
    "companyA:issue-a": {
      id: "issue-a",
      companyId: "companyA",
      identifier: "PRJ-1",
      comments: [{ id: "comment-a", body: "FOUNDER_UPDATE: The milestone is ready." }],
    },
  });
  await processEvent(ctx, {
    eventId: "comment-event",
    eventType: "issue.comment.created",
    entityId: "issue-a",
    companyId: "companyA",
    payload: { commentId: "comment-a" },
  });
  const config = await companyConfig(ctx, "companyA");
  assert.equal(config.digestTimezone, "America/Sao_Paulo");
  assert.equal(getLocalSlot("2026-10-05T12:00:00.000Z", config.digestTimezone).time, "09:00");
  assert.equal(getLocalSlot("2026-10-05T04:00:00.000Z", "Asia/Kolkata").time, "09:30");

  await runDigestJob(ctx, { scheduledAt: "2026-10-05T11:00:00.000Z" });
  assert.equal(ctx.inspect.comments.length, 0);
  await runDigestJob(ctx, { scheduledAt: "2026-10-05T12:00:00.000Z" });
  await runDigestJob(ctx, { scheduledAt: "2026-10-05T12:00:00.000Z" });
  assert.equal(ctx.inspect.comments.length, 1);
  assert.equal(ctx.inspect.wakes.length, 1);
  assert.match(ctx.inspect.comments[0].body, /founder\.digest/);
});

test("digest job does not wake a conversation when the company queue is empty", async () => {
  const ctx = makeContext({
    companyA: { liaisonAgentId: "liaison-a", founderUserId: "founder-a", conversationIssueId: "chat-a" },
  }, { "companyA:chat-a": chat("chat-a", "source:telegram:room-a") });
  await runDigestJob(ctx, { scheduledAt: "2026-10-05T12:00:00.000Z" });
  assert.deepEqual(ctx.inspect.comments, []);
  assert.deepEqual(ctx.inspect.wakes, []);
});

test("digest scheduler sends a configured half-hour timezone slot", async () => {
  const ctx = makeContext({
    companyA: {
      liaisonAgentId: "liaison-a",
      founderUserId: "founder-a",
      conversationIssueId: "chat-a",
      digestTimezone: "Asia/Kolkata",
      digestTimes: ["09:30"],
      digestWeekdays: [1],
    },
  }, {
    "companyA:chat-a": chat("chat-a", "source:telegram:room-a"),
    "companyA:issue-a": {
      id: "issue-a",
      companyId: "companyA",
      identifier: "PRJ-2",
      comments: [{ id: "comment-half-hour", body: "FOUNDER_UPDATE: Half-hour timezone update." }],
    },
  });
  await processEvent(ctx, {
    eventId: "half-hour-comment-event",
    eventType: "issue.comment.created",
    entityId: "issue-a",
    companyId: "companyA",
    payload: { commentId: "comment-half-hour" },
  });
  await runDigestJob(ctx, { scheduledAt: "2026-10-05T04:00:00.000Z" });
  assert.equal(ctx.inspect.comments.length, 1);
  assert.equal(ctx.inspect.wakes.length, 1);
});

test("marked plugin comments are ignored to prevent event loops", async () => {
  const ctx = makeContext({ companyA: { liaisonAgentId: "liaison-a", founderUserId: "founder-a" } }, {
    "companyA:issue-a": { id: "issue-a", companyId: "companyA", comments: [{ id: "comment-a", body: "[FOUNDER_COMMS_EVENT] generated" }] },
  });
  await processEvent(ctx, {
    eventId: "comment-event",
    eventType: "issue.comment.created",
    entityId: "issue-a",
    companyId: "companyA",
    payload: { commentId: "comment-a" },
  });
  assert.deepEqual(ctx.inspect.comments, []);
  assert.deepEqual(ctx.inspect.wakes, []);
});
