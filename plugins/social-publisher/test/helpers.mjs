import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
export const SCHEMA = "plugin_social_publisher_f5a795450a";
export async function databaseContext(overrides = {}) {
  const database = new PGlite();
  const companyId = randomUUID();
  const founderId = "founder-test";
  const agentId = randomUUID();
  await database.exec(
    `CREATE TABLE public.companies (id uuid PRIMARY KEY); CREATE TABLE public.projects(id uuid PRIMARY KEY); CREATE SCHEMA ${SCHEMA}; INSERT INTO public.companies VALUES ('${companyId}');`,
  );
  const migrationsUrl = new URL("../migrations/", import.meta.url);
  for (const file of (await readdir(migrationsUrl)).filter((name) => name.endsWith(".sql")).sort())
    await database.exec(await readFile(new URL(file, migrationsUrl), "utf8"));
  const config = {
    publicBaseUrl: "https://paper.journeystudios.com.br",
    founderUserId: founderId,
    allowedAgentIds: [agentId],
    dryRunOnly: true,
    killSwitch: true,
    telegramNotificationsEnabled: true,
    telegramConversationIssueId: randomUUID(),
    telegramAgentId: agentId,
    requireFactualEvidence: true,
    approvalTtlSeconds: 86400,
    maxAttempts: 3,
    ...overrides,
  };
  const events = [];
  const state = new Map();
  const ctx = {
    db: {
      namespace: SCHEMA,
      query: async (sql, values) => (await database.query(sql, values)).rows,
      execute: async (sql, values) => ({
        rowCount: (await database.query(sql, values)).affectedRows,
      }),
    },
    config: { get: async () => config },
    projects: { get: async () => null },
    events: { emit: async (...event) => events.push(event) },
    issues: {
      get: async (id) => ({
        id,
        companyId,
        originKind: "chat_channel",
        originId: "native:telegram:test",
      }),
      askUserQuestions: async (issueId, input, companyId, actor) => ({
        ...input, id: "native-test", issueId, companyId, kind: "ask_user_questions", status: "pending", createdByAgentId: actor.authorAgentId,
      }),
      listInteractions: async () => [],
      createComment: async () => ({ id: randomUUID() }),
    },
    chat: { publishComment: async () => ({ id: randomUUID(), state: "published" }) },
    state: {
      get: async (key) => state.get(JSON.stringify(key)),
      set: async (key, value) => state.set(JSON.stringify(key), value),
    },
    logger: { warn() {}, info() {}, error() {} },
  };
  return {
    database,
    ctx,
    companyId,
    founderId,
    agentId,
    config,
    events,
    state,
    actor: { actorType: "agent", actorId: agentId },
    human: { actorType: "user", actorId: founderId },
    close: () => database.close(),
  };
}
export const factualEvidence = [
  {
    id: "released-home",
    claim: "Tessel organizes RPG campaigns",
    sourceUrl: "https://tessel.app/",
    releaseStatus: "released",
  },
];
export const draftInput = (extra = {}) => ({
  text: "Organize sua campanha de RPG com Tessel.",
  platforms: ["x", "threads"],
  campaign: "tessel-social-daily",
  metadata: { factualEvidence },
  dryRun: true,
  ...extra,
});
