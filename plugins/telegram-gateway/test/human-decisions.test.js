import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CARD_CHARS,
  buildApprovalCardBody,
  buildInteractionCardBody,
  isFounderReachableInteraction,
  resolveWebBaseUrl,
  sanitizeMarkdownField,
  stripSensitiveText,
} from "../src/human-decisions.js";

const BASE = { baseUrl: "https://paper.journeystudios.com.br", issuePrefix: "JOU" };

test("redacts namespaced secret assignments from env, JSON and YAML", () => {
  const value = ["EXAMPLE", "REDACT", "ME"].join("_");
  const cases = [
    "INTERNAL_API_KEY=" + value,
    "EDGE_SYNC_WEBHOOK_SECRET=" + value,
    "SUPABASE_SERVICE_ROLE_KEY=" + value,
    '"INTERNAL_API_KEY": "' + value + '"',
    "client_secret: " + value,
    "DATABASE_URL='postgres://example:" + value + "@localhost/test'",
    "session_cookie=" + value,
  ];
  for (const original of cases) {
    const redacted = stripSensitiveText(original);
    assert.match(redacted, /\[redacted\]/);
    assert.ok(!redacted.includes(value), "secret must not appear in the sanitized card");
  }
  assert.equal(stripSensitiveText("Plugin running; version=0.3.7"), "Plugin running; version=0.3.7");
});

test("redacts Markdown-wrapped environment assignments before publishing a card", () => {
  const secret = ["EXAMPLE", "REDACT", "ME"].join("_");
  const tick = String.fromCharCode(96);
  const issue = { id: "issue-synthetic", identifier: "JOU-20", title: "Synthetic safe card" };
  const interaction = {
    id: "interaction-synthetic",
    kind: "request_confirmation",
    status: "pending",
    effectiveResolverPolicy: "anyone",
    payload: {
      prompt: tick + "INTERNAL_API_KEY" + tick + " = **" + secret + "**",
      detailsMarkdown: "**EDGE_SYNC_WEBHOOK_SECRET**: " + tick + secret + tick,
    },
  };
  const card = buildInteractionCardBody(interaction, issue, BASE);
  assert.ok(!card.includes(secret), "an inline Markdown assignment must be redacted");
  assert.match(card, /\[redacted\]/);
});

test("redacts a whole PEM body and complete prefixed API tokens", () => {
  const begin = ["-----", "BEGIN PRIVATE KEY", "-----"].join("");
  const end = ["-----", "END PRIVATE KEY", "-----"].join("");
  const block = [begin, "FAKE_TEST_ONLY_MATERIAL", end, "status=ok"].join("\n");
  const redactedPem = stripSensitiveText(block);
  assert.match(redactedPem, /\[redacted\]/);
  assert.doesNotMatch(redactedPem, /FAKE_TEST_ONLY_MATERIAL|BEGIN PRIVATE KEY/);
  assert.match(redactedPem, /status=ok/);
  const token = ["sk", "proj", "FAKE_TEST_ONLY_TOKEN_REDACT_ME"].join("-");
  assert.equal(stripSensitiveText(token), "[redacted]");
});

test("stripSensitiveText redacts bearer tokens and long secrets", () => {
  const input = "Use Bearer abcdefghijklmnop and api_key=super-secret-value";
  const out = stripSensitiveText(input);
  assert.match(out, /\[redacted\]/);
  assert.doesNotMatch(out, /super-secret-value/);
});

test("JOU-84 style interaction card is readable, in PT-BR, without internal metadata", () => {
  const issue = { id: "issue-84", identifier: "JOU-84", companyId: "companyA", title: "Rotação de credencial" };
  const interaction = {
    id: "2ba4cad6-3ffa-4439-ab81-b312c52b2bf2",
    kind: "request_confirmation",
    status: "pending",
    effectiveResolverPolicy: "human_only",
    title: "Confirm credential proposal",
    payload: {
      prompt: "Approve storing the GitHub token?",
      detailsMarkdown: "Token value: ghp_deadbeefnotreal",
      rejectRequiresReason: true,
      target: { type: "issue_document", issueId: issue.id, key: "plan" },
      secretProposal: { label: "github_token", value: "ghp_topsecret" },
    },
    updatedAt: "2026-10-08T00:00:00.000Z",
  };
  assert.equal(isFounderReachableInteraction(interaction, "founder-a"), true);
  const body = buildInteractionCardBody(interaction, issue, BASE);
  assert.match(body, /^Ação necessária · JOU-84 — Rotação de credencial/);
  assert.match(body, /Estado: Aguardando decisão/);
  assert.match(body, /https:\/\/paper\.journeystudios\.com\.br\/JOU\/issues\/JOU-84#interaction-2ba4cad6/);
  assert.match(body, /só o Founder pode resolver/);
  assert.doesNotMatch(body, /FOUNDER_HUMAN_DECISION_CARD|kind=|companyId=|interactionId=|fingerprint=|delivery=|Coverage note/);
  assert.doesNotMatch(body, /ghp_topsecret|ghp_deadbeef/);
});

test("restricted action and connection cards never fall back to raw prompt or details", () => {
  const issue = { id: "issue-1", identifier: "JOU-1", companyId: "companyA" };
  for (const restricted of [
    { toolAction: { toolName: "deploy", arguments: { token: "raw-token" } } },
    { connectionAuthorization: { token: "raw-token" } },
    { connectionIntent: { token: "raw-token" } },
  ]) {
    const body = buildInteractionCardBody({
      id: "interaction-1",
      kind: "request_confirmation",
      status: "pending",
      title: "Review in Paperclip",
      payload: { ...restricted, prompt: "OAuth-code-abc12345", detailsMarkdown: "opaque-bearer-abcdef123456" },
    }, issue, BASE);
    assert.match(body, /Review in Paperclip/);
    assert.doesNotMatch(body, /OAuth-code-abc12345|opaque-bearer-abcdef123456|raw-token/);
    assert.match(body, /precisa ser confirmada dentro do Paperclip/);
  }
});

test("governance-critical interactions explain the constraint without dumping prompt or details", () => {
  const issue = { id: "issue-gov", identifier: "JOU-9", companyId: "companyA", title: "Decisão governada" };
  for (const critical of [
    { effectiveResolverPolicy: "human_only", payload: {} },
    { effectiveResolverPolicy: "anyone", payload: { target: { type: "issue_document" } } },
    { effectiveResolverPolicy: "anyone", payload: { rejectRequiresReason: true } },
  ]) {
    const body = buildInteractionCardBody({
      id: "interaction-gov",
      kind: "request_confirmation",
      status: "pending",
      title: "Decidir",
      ...critical,
      payload: { prompt: "Conteúdo interno do pedido", detailsMarkdown: "Detalhe interno reservado", ...critical.payload },
    }, issue, BASE);
    assert.doesNotMatch(body, /Conteúdo interno do pedido|Detalhe interno reservado/);
    assert.match(body, /precisa ser confirmada dentro do Paperclip/);
    assert.match(body, /https:\/\/paper\.journeystudios\.com\.br\/JOU\/issues\/JOU-9#interaction-interaction-gov/);
  }
});

test("approval card carries a human summary and canonical absolute link", () => {
  const approval = {
    id: "appr-1",
    companyId: "companyA",
    status: "pending",
    type: "request_board_approval",
    updatedAt: "2026-10-08T00:00:00.000Z",
    payload: {
      title: "Aprovação de gasto",
      summary: "Aprovar R$ 40 de hospedagem",
      recommendedAction: "Aprovar",
      risks: ["Uso pode crescer"],
    },
  };
  const body = buildApprovalCardBody(approval, BASE);
  assert.match(body, /^Ação necessária · Aprovação — Aprovação de gasto/);
  assert.match(body, /Pedido: Aprovar R\$ 40 de hospedagem/);
  assert.match(body, /Recomendação: Aprovar/);
  assert.match(body, /https:\/\/paper\.journeystudios\.com\.br\/JOU\/approvals\/appr-1/);
  assert.doesNotMatch(body, /COMPANY|decisions|FOUNDER_HUMAN_DECISION_CARD|fingerprint=/);
  assert.equal(sanitizeMarkdownField("  hello  "), "hello");
});

test("cards flatten Markdown structure and stay within the Telegram size budget", () => {
  const issue = { id: "issue-2", identifier: "JOU-2", companyId: "companyA", title: "# Título com markdown" };
  const interaction = {
    id: "interaction-2",
    kind: "request_confirmation",
    status: "pending",
    effectiveResolverPolicy: "anyone",
    title: "Decidir",
    payload: {
      prompt: "**Você** aprova o plano?",
      detailsMarkdown: "## Contexto\n- item um\n- item dois\n```code```",
    },
  };
  const body = buildInteractionCardBody(interaction, issue, BASE);
  assert.doesNotMatch(body, /^#{1,6}\s/m);
  assert.doesNotMatch(body, /\n\s*[-*+]\s/);
  assert.doesNotMatch(body, /`/);
  assert.ok(body.length <= MAX_CARD_CHARS);
  assert.ok(Array.from(body).length <= 4096);
});

test("cards never leak secrets from prompt or details", () => {
  const issue = { id: "issue-3", identifier: "JOU-3", companyId: "companyA", title: "Segredo" };
  const interaction = {
    id: "interaction-3",
    kind: "request_confirmation",
    status: "pending",
    effectiveResolverPolicy: "anyone",
    title: "Decidir",
    payload: {
      prompt: "Use api_key=aaaaaaaaaaaaaaaaaa para concluir",
      detailsMarkdown: "Bearer cccccccccccccccc",
    },
  };
  const body = buildInteractionCardBody(interaction, issue, BASE);
  assert.doesNotMatch(body, /aaaaaaaaaaaaaaaaaa|cccccccccccccccc/);
  assert.match(body, /\[redacted\]/);
});

test("approval card keeps its link even with many long risks", () => {
  const approval = {
    id: "appr-many",
    companyId: "companyA",
    status: "pending",
    type: "request_board_approval",
    payload: {
      title: "Decisão com muitos riscos",
      summary: "Resumo longo ".repeat(40),
      risks: Array.from({ length: 20 }, (_, i) => `Risco numero ${i} `.repeat(20)),
    },
  };
  const body = buildApprovalCardBody(approval, BASE);
  assert.ok(body.length <= MAX_CARD_CHARS);
  assert.match(body, /https:\/\/paper\.journeystudios\.com\.br\/JOU\/approvals\/appr-many$/);
});

test("resolveWebBaseUrl prefers config and rejects non-http(s) values", () => {
  const keys = [
    "PAPERCLIP_PUBLIC_URL", "PAPERCLIP_AUTH_PUBLIC_BASE_URL", "BETTER_AUTH_URL",
    "BETTER_AUTH_BASE_URL", "PAPERCLIP_MANAGED_RUNTIME_PUBLIC_URL",
  ];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  try {
    assert.equal(resolveWebBaseUrl("https://paper.example.com/"), "https://paper.example.com");
    assert.equal(resolveWebBaseUrl("http://paper.example.com"), "https://paper.journeystudios.com.br");
    assert.equal(resolveWebBaseUrl("not a url"), "https://paper.journeystudios.com.br");
    assert.equal(resolveWebBaseUrl(undefined), "https://paper.journeystudios.com.br");
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
