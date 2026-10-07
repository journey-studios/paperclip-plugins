const EVENT_PREFIX = "[FOUNDER_COMMS_EVENT]";
const MAX_PROCESSED = 500;
const MAX_QUEUE = 100;
const MAX_PENDING_RUNS = 200;
const MAX_PUBLISHED = 500;
let knownCompaniesTail = Promise.resolve();

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function companyConfig(ctx, companyId) {
  const raw = asObject(await ctx.config.get(companyId));
  const validation = validateConfig(raw);
  const relevantErrors = validation.errors.filter((error) => !error.startsWith("Missing required setting:"));
  if (relevantErrors.length) throw new Error(`Invalid founder comms settings: ${relevantErrors.join("; ")}`);
  const channels = raw.chatChannels === undefined ? ["telegram"] : raw.chatChannels;
  const digestTimes = raw.digestTimes === undefined ? ["09:00", "17:00"] : raw.digestTimes;
  const weekdays = raw.digestWeekdays === undefined ? [1, 2, 3, 4, 5] : raw.digestWeekdays;
  const timezone = stringValue(raw.digestTimezone) ?? "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    throw new Error("Invalid founder comms settings: digestTimezone must be a valid IANA timezone");
  }
  return {
    liaisonAgentId: stringValue(raw.liaisonAgentId),
    founderUserId: stringValue(raw.founderUserId),
    immediateEnabled: raw.immediateEnabled !== false,
    digestEnabled: raw.digestEnabled !== false,
    publicationEnabled: raw.publicationEnabled === true,
    commandsEnabled: raw.commandsEnabled !== false,
    conversationIssueId: stringValue(raw.conversationIssueId),
    chatChannels: channels,
    projectId: stringValue(raw.projectId),
    digestTimezone: timezone,
    digestTimes: [...new Set(digestTimes)],
    digestWeekdays: [...new Set(weekdays)],
  };
}

function validateConfig(value) {
  const config = asObject(value);
  const errors = [];
  const knownKeys = new Set([
    "liaisonAgentId", "founderUserId", "conversationIssueId", "chatChannels", "projectId",
    "immediateEnabled", "digestEnabled", "publicationEnabled", "commandsEnabled", "digestTimezone", "digestTimes", "digestWeekdays",
  ]);
  for (const key of Object.keys(config)) {
    if (!knownKeys.has(key)) errors.push(`Unknown setting: ${key}`);
  }
  for (const key of ["liaisonAgentId", "founderUserId"]) {
    if (!stringValue(config[key])) errors.push(`Missing required setting: ${key}`);
  }
  for (const key of ["conversationIssueId", "projectId"]) {
    if (config[key] !== undefined && !stringValue(config[key])) errors.push(`${key} must be a non-empty string`);
  }
  for (const key of ["immediateEnabled", "digestEnabled", "publicationEnabled", "commandsEnabled"]) {
    if (config[key] !== undefined && typeof config[key] !== "boolean") errors.push(`${key} must be a boolean`);
  }
  if (config.chatChannels !== undefined) {
    if (!Array.isArray(config.chatChannels) || config.chatChannels.some((value) =>
      typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(value),
    )) errors.push("chatChannels must contain channel names using lowercase letters, numbers, underscores, or hyphens");
  }
  if (config.digestTimes !== undefined) {
    if (!Array.isArray(config.digestTimes) || config.digestTimes.some((value) =>
      typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value),
    )) errors.push("digestTimes must contain 24-hour HH:MM values");
  }
  if (config.digestWeekdays !== undefined) {
    if (!Array.isArray(config.digestWeekdays) || config.digestWeekdays.some((value) =>
      !Number.isInteger(value) || value < 1 || value > 7,
    )) errors.push("digestWeekdays must contain ISO weekday numbers from 1 to 7");
  }
  if (config.digestTimezone !== undefined) {
    if (!stringValue(config.digestTimezone)) errors.push("digestTimezone must be a valid IANA timezone");
    else {
      try {
        new Intl.DateTimeFormat("en", { timeZone: config.digestTimezone });
      } catch {
        errors.push("digestTimezone must be a valid IANA timezone");
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

function companyScope(companyId, stateKey) {
  return { scopeKind: "company", scopeId: companyId, stateKey };
}

async function rememberCompany(ctx, companyId) {
  const update = async () => {
    const key = { scopeKind: "instance", stateKey: "known-companies" };
    const prior = await ctx.state.get(key);
    const values = Array.isArray(prior) ? prior.filter((v) => typeof v === "string") : [];
    if (!values.includes(companyId)) {
      values.push(companyId);
      await ctx.state.set(key, values);
    }
  };
  const pending = knownCompaniesTail.catch(() => {}).then(update);
  knownCompaniesTail = pending;
  try {
    await pending;
  } finally {
    if (knownCompaniesTail === pending) knownCompaniesTail = Promise.resolve();
  }
}

async function alreadyProcessed(ctx, companyId, eventId) {
  const key = companyScope(companyId, "processed-event-ids");
  const prior = await ctx.state.get(key);
  const ids = Array.isArray(prior) ? prior.filter((v) => typeof v === "string") : [];
  return ids.includes(eventId);
}

async function markProcessed(ctx, companyId, eventId) {
  const key = companyScope(companyId, "processed-event-ids");
  const prior = await ctx.state.get(key);
  const ids = Array.isArray(prior) ? prior.filter((v) => typeof v === "string") : [];
  if (!ids.includes(eventId)) ids.push(eventId);
  await ctx.state.set(key, ids.slice(-MAX_PROCESSED));
}

function isFounderChatIssue(issue, config, companyId = null) {
  if (!issue || !config.liaisonAgentId || !config.founderUserId) return false;
  if (companyId && issue.companyId !== companyId) return false;
  const originId = stringValue(issue.originId) ?? "";
  const founderOwned =
    stringValue(issue.createdByUserId) === config.founderUserId ||
    stringValue(issue.responsibleUserId) === config.founderUserId;
  const live = issue.status !== "done" && issue.status !== "cancelled";
  const channelAllowed = config.chatChannels.some((channel) =>
    originId.startsWith(`${channel}:`) || originId.includes(`:${channel}:`),
  );
  return (
    issue.originKind === "chat_channel" &&
    channelAllowed &&
    issue.assigneeAgentId === config.liaisonAgentId &&
    founderOwned &&
    (!config.projectId || issue.projectId === config.projectId) &&
    live
  );
}

async function resolveConversation(ctx, companyId, config) {
  if (!config.liaisonAgentId || !config.founderUserId) return null;
  if (!(await hasCompanyRoutingMemberships(ctx, companyId, config))) return null;
  if (config.conversationIssueId) {
    const explicit = await ctx.issues.get(config.conversationIssueId, companyId);
    return isFounderChatIssue(explicit, config, companyId) ? explicit : null;
  }
  const key = companyScope(companyId, "conversation-issue-id");
  const saved = stringValue(await ctx.state.get(key));
  if (saved) {
    const issue = await ctx.issues.get(saved, companyId);
    if (isFounderChatIssue(issue, config, companyId)) return issue;
    await ctx.state.delete(key);
  }

  const issues = await ctx.issues.list({
    companyId,
    assigneeAgentId: config.liaisonAgentId,
    originKind: "chat_channel",
    includePluginOperations: true,
    limit: 100,
  });
  const conversation = issues
    .filter((issue) => isFounderChatIssue(issue, config, companyId))
    .sort((a, b) => String(b.updatedAt ?? b.createdAt ?? "").localeCompare(String(a.updatedAt ?? a.createdAt ?? "")))[0] ?? null;
  if (conversation) await ctx.state.set(key, conversation.id);
  return conversation;
}

async function hasCompanyRoutingMemberships(ctx, companyId, config) {
  const company = await ctx.companies.get(companyId);
  if (!company || company.id !== companyId) return false;
  const agent = await ctx.agents.get(config.liaisonAgentId, companyId);
  if (!agent || agent.id !== config.liaisonAgentId || agent.companyId !== companyId) return false;
  const members = await ctx.access.members.list({ companyId });
  if (!members.some((member) =>
    member.companyId === companyId && member.principalType === "user" &&
    member.principalId === config.founderUserId && member.status === "active",
  )) return false;
  if (config.projectId) {
    const project = await ctx.projects.get(config.projectId, companyId);
    if (!project || project.id !== config.projectId || project.companyId !== companyId) return false;
  }
  return true;
}

async function queueItem(ctx, companyId, queueKey, item) {
  const key = companyScope(companyId, queueKey);
  const prior = await ctx.state.get(key);
  const queue = Array.isArray(prior) ? prior : [];
  if (!queue.some((entry) => asObject(entry).id === item.id)) queue.push(item);
  await ctx.state.set(key, queue.slice(-MAX_QUEUE));
}

async function rememberPublicationRun(ctx, companyId, issueId, wake, sourceId) {
  if (!wake?.queued || !stringValue(wake.runId)) return;
  const key = companyScope(companyId, "pending-publication-runs");
  const prior = await ctx.state.get(key);
  const queue = Array.isArray(prior) ? prior.filter((item) => asObject(item).runId !== wake.runId) : [];
  queue.push({ runId: wake.runId, issueId, sourceId, requestedAt: new Date().toISOString(), ready: false });
  await ctx.state.set(key, queue.slice(-MAX_PENDING_RUNS));
}

async function publishForRun(ctx, companyId, config, runId) {
  if (!config.publicationEnabled) return { status: "disabled" };
  const key = companyScope(companyId, "pending-publication-runs");
  const queue = await ctx.state.get(key);
  const pending = (Array.isArray(queue) ? queue : []).find((entry) => stringValue(asObject(entry).runId) === runId);
  if (!pending) return { status: "not_pending" };
  if (pending.ready !== true) return { status: "run_not_completed" };
  const issueId = stringValue(asObject(pending).issueId);
  if (!issueId) return { status: "invalid_pending" };
  const issue = await ctx.issues.get(issueId, companyId);
  if (!isFounderChatIssue(issue, config, companyId)) return { status: "conversation_unavailable" };
  const comments = await ctx.issues.listComments(issueId, companyId);
  const eligible = comments.filter((comment) =>
    comment.issueId === issueId &&
    comment.companyId === companyId &&
    comment.createdByRunId === runId &&
    comment.authorType === "agent" &&
    comment.authorAgentId === config.liaisonAgentId &&
    !comment.deletedAt &&
    stringValue(comment.body) &&
    !comment.body.startsWith(EVENT_PREFIX),
  );
  eligible.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const comment = eligible[0];
  if (!comment) return { status: "comment_not_found" };
  const publishedKey = companyScope(companyId, "published-comment-ids");
  const prior = await ctx.state.get(publishedKey);
  const ids = Array.isArray(prior) ? prior.filter((value) => typeof value === "string") : [];
  if (!ids.includes(comment.id)) {
    // Native chat publications have a unique idempotency key per comment and endpoint.
    // Retry after a crash is safe even if the provider already accepted the message.
    const result = await ctx.chat.publishComment(comment.id, companyId);
    if (!["published", "pending", "retry", "delivery_unknown"].includes(result?.state)) {
      throw new Error(`Chat publication was not accepted: ${result?.state ?? "unknown"}`);
    }
    ids.push(comment.id);
    await ctx.state.set(publishedKey, ids.slice(-MAX_PUBLISHED));
  }
  await ctx.state.set(key, (Array.isArray(queue) ? queue : []).filter((entry) =>
    stringValue(asObject(entry).runId) !== runId));
  return { status: "accepted", commentId: comment.id };
}

async function reconcilePendingPublications(ctx, companyId, config) {
  if (!config.publicationEnabled) return;
  const queue = await ctx.state.get(companyScope(companyId, "pending-publication-runs"));
  for (const pending of Array.isArray(queue) ? queue : []) {
    const runId = stringValue(asObject(pending).runId);
    if (runId) await publishForRun(ctx, companyId, config, runId);
  }
}

async function reconcileKnownPublications(ctx, serialize = async (_companyId, fn) => fn()) {
  const known = await ctx.state.get({ scopeKind: "instance", stateKey: "known-companies" });
  for (const companyId of Array.isArray(known) ? known : []) {
    if (!stringValue(companyId)) continue;
    await serialize(companyId, async () => {
      try {
        await reconcilePendingPublications(ctx, companyId, await companyConfig(ctx, companyId));
      } catch (error) {
        ctx.logger.error("Founder publication startup reconciliation failed", {
          companyId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }
}

async function handleAgentRunFinished(ctx, event, config) {
  const payload = asObject(event.payload);
  const runId = stringValue(payload.runId) ?? stringValue(event.entityId);
  if (!runId || payload.agentId !== config.liaisonAgentId || !config.publicationEnabled) return;
  if (event.eventType === "agent.run.finished" && payload.status === "succeeded") {
    const key = companyScope(event.companyId, "pending-publication-runs");
    const stored = await ctx.state.get(key);
    const runs = Array.isArray(stored) ? stored : [];
    if (!runs.some((item) => asObject(item).runId === runId)) return;
    await ctx.state.set(key, runs.map((item) =>
      asObject(item).runId === runId ? { ...item, ready: true } : item));
    await publishForRun(ctx, event.companyId, config, runId);
  }
}

async function publishToConversation(ctx, companyId, config, item) {
  const conversation = await resolveConversation(ctx, companyId, config);
  if (!conversation) {
    await queueItem(ctx, companyId, "pending-immediate", item);
    return { delivered: false, reason: "conversation_not_bound" };
  }

  const body = [
    EVENT_PREFIX,
    `priority=${item.priority}`,
    `event=${item.type}`,
    `source=${item.sourceRef ?? "unknown"}`,
    "",
    item.message,
    "",
    "This is a system-originated founder communication event, not a message written by the founder. Validate the original Paperclip object before acting."
  ].join("\n");

  await ctx.issues.createComment(conversation.id, body, companyId);
  const wake = await ctx.issues.requestWakeup(conversation.id, companyId, {
    reason: "founder_comms_event",
    contextSource: "plugin.founder-comms-router",
    idempotencyKey: `founder-comms:${item.id}`,
  });
  if (config.publicationEnabled) await rememberPublicationRun(ctx, companyId, conversation.id, wake, item.id);
  return { delivered: true, issueId: conversation.id };
}

async function flushPendingImmediate(ctx, companyId, config) {
  if (!config.immediateEnabled) return;
  const key = companyScope(companyId, "pending-immediate");
  const prior = await ctx.state.get(key);
  const queue = Array.isArray(prior) ? prior : [];
  if (queue.length === 0) return;
  const conversation = await resolveConversation(ctx, companyId, config);
  if (!conversation) return;

  const lines = queue.slice(0, 20).map((raw) => {
    const item = asObject(raw);
    return `- [${stringValue(item.priority) ?? "P1"}] ${stringValue(item.message) ?? "Founder attention event"} (source: ${stringValue(item.sourceRef) ?? "unknown"})`;
  });
  const id = `pending-${queue.map((raw) => stringValue(asObject(raw).id) ?? "").join("-").slice(0, 180)}`;
  await ctx.issues.createComment(
    conversation.id,
    [EVENT_PREFIX, "priority=P1", "event=pending.flush", "", "Pending founder attention:", ...lines, "", "Validate each original Paperclip object before acting."].join("\n"),
    companyId,
  );
  const wake = await ctx.issues.requestWakeup(conversation.id, companyId, {
    reason: "founder_comms_pending_flush",
    contextSource: "plugin.founder-comms-router",
    idempotencyKey: `founder-comms:${id}`,
  });
  if (config.publicationEnabled) await rememberPublicationRun(ctx, companyId, conversation.id, wake, id);
  await ctx.state.set(key, queue.slice(20));
}

async function handleIssueCreated(ctx, event, config) {
  if (!config.liaisonAgentId || !config.founderUserId || !event.entityId) return;
  const issue = await ctx.issues.get(event.entityId, event.companyId);
  if (!issue) return;
  if (isFounderChatIssue(issue, config, event.companyId)) {
    await ctx.state.set(companyScope(event.companyId, "conversation-issue-id"), issue.id);
    await flushPendingImmediate(ctx, event.companyId, config);
  }
}

function founderOwnedBlock(issue, founderUserId) {
  const descriptor = asObject(issue.unblockDescriptor);
  const owner = descriptor.owner;
  if (owner === "board") return true;
  const ownerObject = asObject(owner);
  if (stringValue(ownerObject.userId) === founderUserId) return true;
  return stringValue(issue.responsibleUserId) === founderUserId;
}

function founderReview(issue, founderUserId) {
  const executionState = asObject(issue.executionState);
  const participant = asObject(executionState.currentParticipant);
  return participant.type === "user" && stringValue(participant.userId) === founderUserId;
}

async function handleIssueUpdated(ctx, event, config) {
  if (!event.entityId || !config.founderUserId) return;
  const issue = await ctx.issues.get(event.entityId, event.companyId);
  if (!issue || issue.companyId !== event.companyId) return;
  if (isFounderChatIssue(issue, config, event.companyId)) return;

  let signal = null;
  let message = null;
  if (issue.status === "blocked" && founderOwnedBlock(issue, config.founderUserId)) {
    signal = "blocked:founder";
    message = `Issue ${issue.identifier ?? issue.id} is blocked on founder action: ${issue.title ?? "untitled"}.`;
  } else if (issue.status === "in_review" && founderReview(issue, config.founderUserId)) {
    signal = "review:founder";
    message = `Issue ${issue.identifier ?? issue.id} is waiting for founder review: ${issue.title ?? "untitled"}.`;
  }

  const key = companyScope(event.companyId, "issue-attention-state");
  const prior = asObject(await ctx.state.get(key));
  const previous = stringValue(prior[issue.id]);

  if (!config.immediateEnabled && signal && previous) {
    delete prior[issue.id];
    await ctx.state.set(key, prior);
    return;
  }
  if (!config.immediateEnabled && signal) return;

  if (!signal) {
    if (previous) {
      delete prior[issue.id];
      await ctx.state.set(key, prior);
    }
    return;
  }
  if (previous === signal) return;
  await publishToConversation(ctx, event.companyId, config, {
    id: event.eventId,
    priority: "P1",
    type: "issue.attention",
    sourceRef: issue.identifier ?? issue.id,
    message,
  });
  prior[issue.id] = signal;
  await ctx.state.set(key, prior);
}

async function handleComment(ctx, event, config) {
  if (!event.entityId) return;
  const issue = await ctx.issues.get(event.entityId, event.companyId);
  if (!issue || issue.companyId !== event.companyId) return;
  const payload = asObject(event.payload);
  const commentId = stringValue(payload.commentId);
  if (!commentId) return;
  const comments = await ctx.issues.listComments(event.entityId, event.companyId);
  const comment = comments.find((entry) => entry.id === commentId);
  if (!comment) return;
  const body = typeof comment.body === "string" ? comment.body.trim() : "";
  if (!body || body.startsWith(EVENT_PREFIX)) return;

  if (body.startsWith("FOUNDER_ATTENTION:")) {
    if (!config.immediateEnabled) return;
    await publishToConversation(ctx, event.companyId, config, {
      id: commentId,
      priority: "P1",
      type: "founder.attention",
      sourceRef: event.entityId,
      message: body.slice("FOUNDER_ATTENTION:".length).trim(),
    });
    return;
  }

  if (body.startsWith("FOUNDER_UPDATE:") && config.digestEnabled) {
    await queueItem(ctx, event.companyId, "digest-queue", {
      id: commentId,
      priority: "P2",
      type: "founder.update",
      sourceRef: issue?.identifier ?? event.entityId,
      message: body.slice("FOUNDER_UPDATE:".length).trim(),
      occurredAt: event.occurredAt,
    });
  }
}

async function handleApproval(ctx, event, config) {
  if (!config.immediateEnabled || !event.entityId) return;
  const approval = await ctx.approvals.get(event.entityId, event.companyId);
  if (!approval || approval.companyId !== event.companyId || approval.status !== "pending") return;
  await publishToConversation(ctx, event.companyId, config, {
    id: event.eventId,
    priority: "P1",
    type: "approval.created",
    sourceRef: approval.id,
    message: `A Paperclip approval is pending. Approval ID: ${approval.id}. Type: ${approval.type}. Inspect the original approval, summarize the decision and recommendation for the founder, and preserve the decision on the original approval object.`,
  });
}

async function handleApprovalDecided(ctx, event) {
  if (!event.entityId) return;
  const key = companyScope(event.companyId, "pending-immediate");
  const prior = await ctx.state.get(key);
  if (!Array.isArray(prior) || prior.length === 0) return;
  const filtered = prior.filter((raw) => stringValue(asObject(raw).sourceRef) !== event.entityId);
  if (filtered.length !== prior.length) await ctx.state.set(key, filtered);
}

async function handleBudgetIncident(ctx, event, config) {
  if (!config.immediateEnabled) return;
  await publishToConversation(ctx, event.companyId, config, {
    id: event.eventId,
    priority: "P0",
    type: "budget.incident.opened",
    sourceRef: event.entityId ?? event.eventId,
    message: `A budget incident was opened in Paperclip. Incident reference: ${event.entityId ?? event.eventId}. Inspect the original incident and tell the founder only the material impact and required action.`,
  });
}

async function processEvent(ctx, event) {
  if (!stringValue(event?.companyId) || !stringValue(event?.eventId)) return;
  await rememberCompany(ctx, event.companyId);
  const config = await companyConfig(ctx, event.companyId);
  if (!config.liaisonAgentId || !config.founderUserId) return;
  if (await alreadyProcessed(ctx, event.companyId, event.eventId)) return;

  try {
    if (event.eventType === "issue.created") await handleIssueCreated(ctx, event, config);
    else if (event.eventType === "issue.updated") await handleIssueUpdated(ctx, event, config);
    else if (event.eventType === "issue.comment.created") await handleComment(ctx, event, config);
    else if (event.eventType === "approval.created") await handleApproval(ctx, event, config);
    else if (event.eventType === "approval.decided") await handleApprovalDecided(ctx, event);
    else if (event.eventType === "budget.incident.opened") await handleBudgetIncident(ctx, event, config);
    else if (event.eventType === "agent.run.finished" || event.eventType === "agent.run.failed")
      await handleAgentRunFinished(ctx, event, config);
    await markProcessed(ctx, event.companyId, event.eventId);
  } catch (error) {
    ctx.logger.error("Founder comms event failed", {
      eventId: event.eventId,
      eventType: event.eventType,
      companyId: event.companyId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function flushDigest(ctx, companyId, scheduledSlot = null) {
  const config = await companyConfig(ctx, companyId);
  if (!config.digestEnabled || !config.liaisonAgentId || !config.founderUserId) return;
  if (scheduledSlot) {
    const lastSlot = stringValue(await ctx.state.get(companyScope(companyId, "last-digest-slot")));
    if (lastSlot === scheduledSlot) return;
  }
  const key = companyScope(companyId, "digest-queue");
  const prior = await ctx.state.get(key);
  const queue = Array.isArray(prior) ? prior : [];
  if (queue.length === 0) return;

  const conversation = await resolveConversation(ctx, companyId, config);
  if (!conversation) return;

  const batch = queue.slice(0, 25);
  const lines = batch.map((raw) => {
    const item = asObject(raw);
    return `- ${stringValue(item.message) ?? "Meaningful update"} (source: ${stringValue(item.sourceRef) ?? "unknown"})`;
  });
  const digestId = batch.map((raw) => stringValue(asObject(raw).id) ?? "").join("-").slice(0, 180);
  await ctx.issues.createComment(
    conversation.id,
    [EVENT_PREFIX, "priority=P2", "event=founder.digest", "", "Founder digest input:", ...lines, "", "Summarize and deduplicate. This input is system-originated, not founder-authored. Do not invent actions where none are required."].join("\n"),
    companyId,
  );
  const wake = await ctx.issues.requestWakeup(conversation.id, companyId, {
    reason: "founder_comms_digest",
    contextSource: "plugin.founder-comms-router",
    idempotencyKey: `founder-digest:${digestId}`,
  });
  if (config.publicationEnabled) await rememberPublicationRun(ctx, companyId, conversation.id, wake, digestId);
  await ctx.state.set(key, queue.slice(batch.length));
  if (scheduledSlot) await ctx.state.set(companyScope(companyId, "last-digest-slot"), scheduledSlot);
}

function getLocalSlot(dateValue, timezone) {
  const date = new Date(dateValue ?? Date.now());
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const dayNumbers = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  const time = `${values.hour}:${values.minute}`;
  if (!dayNumbers[values.weekday]) return null;
  return {
    day: dayNumbers[values.weekday],
    time,
    id: `${values.year}-${values.month}-${values.day}@${time}[${timezone}]`,
  };
}

async function runDigestJob(ctx, job, serialize = async (_companyId, operation) => operation()) {
  const known = await ctx.state.get({ scopeKind: "instance", stateKey: "known-companies" });
  for (const companyId of Array.isArray(known) ? known : []) {
    if (typeof companyId !== "string") continue;
    await serialize(companyId, async () => {
      try {
        const queue = await ctx.state.get(companyScope(companyId, "digest-queue"));
        if (!Array.isArray(queue) || queue.length === 0) return;
        const config = await companyConfig(ctx, companyId);
        if (!config.digestEnabled) return;
        const slot = getLocalSlot(job.scheduledAt, config.digestTimezone);
        if (!slot || !config.digestWeekdays.includes(slot.day) || !config.digestTimes.includes(slot.time)) return;
        await flushDigest(ctx, companyId, slot.id);
      } catch (error) {
        ctx.logger.error("Founder comms digest job failed", {
          companyId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }
}

export {
  companyConfig,
  flushDigest,
  flushPendingImmediate,
  getLocalSlot,
  isFounderChatIssue,
  processEvent,
  publishForRun,
  reconcileKnownPublications,
  reconcilePendingPublications,
  runDigestJob,
  validateConfig,
};
