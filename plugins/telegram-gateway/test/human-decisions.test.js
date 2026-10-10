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
      prompt: "Use api_key=sk-abcdefghij12345 para concluir",
      detailsMarkdown: "Bearer abcdefghijklmnop",
    },
  };
  const body = buildInteractionCardBody(interaction, issue, BASE);
  assert.doesNotMatch(body, /sk-abcdefghij12345|abcdefghijklmnop/);
  assert.match(body, /\[redacted\]/);
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
    assert.equal(resolveWebBaseUrl("not a url"), "https://paper.journeystudios.com.br");
    assert.equal(resolveWebBaseUrl(undefined), "https://paper.journeystudios.com.br");
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
