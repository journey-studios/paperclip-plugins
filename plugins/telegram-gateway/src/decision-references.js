import { createHash } from "node:crypto";

const ISSUE_REF = /^[A-Z][A-Z0-9]{1,11}-[1-9]\d{0,8}$/;
const APPROVAL_REF = /^AP-([0-9A-F]{10})$/;
const INTERACTION_REF = /^([A-Z][A-Z0-9]{1,11}-[1-9]\d{0,8})\.([0-9A-F]{10})$/;

function shortDigest(fields) {
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex").slice(0, 10).toUpperCase();
}

/**
 * Display references are version-scoped locators, never bearer credentials:
 * the Telegram host must independently authenticate a linked human.
 * Status and updatedAt make an old card reference invalid after a mutation.
 */
export function approvalActionRef(approval) {
  if (!approval?.id || approval.status !== "pending") return null;
  return "AP-" + shortDigest(["approval", approval.id, approval.status, approval.updatedAt ?? approval.createdAt ?? null, approval.type]);
}

export function interactionActionRef(interaction, issue) {
  if (!interaction?.id || interaction.status !== "pending" || !ISSUE_REF.test(issue?.identifier ?? "")) return null;
  return issue.identifier + "." + shortDigest([
    "interaction", interaction.id, interaction.status, interaction.updatedAt ?? interaction.createdAt ?? null,
    interaction.kind, interaction.title ?? null,
    interaction.payload?.target?.revisionId ?? null,
  ]);
}

export function allowDirectApproval(approval) {
  const payload = approval?.payload ?? {};
  // Other board approval types may imply security, spend, agent provisioning or
  // strategy commitments and remain on the complete Paperclip review screen.
  return approval?.status === "pending" && approval.type === "request_board_approval" &&
    !payload.secretProposal && !payload.toolAction && !payload.connectionAuthorization &&
    !payload.connectionIntent && !payload.target?.type;
}

export function allowDirectInteraction(interaction) {
  const payload = interaction?.payload ?? {};
  return interaction?.status === "pending" && interaction.kind === "request_confirmation" &&
    !payload.secretProposal && !payload.toolAction && !payload.connectionAuthorization &&
    !payload.connectionIntent && payload.target?.type !== "issue_document";
}

export function parseDecisionReference(reference) {
  const token = typeof reference === "string" ? reference.trim().toUpperCase() : "";
  const approval = APPROVAL_REF.exec(token);
  if (approval) return { kind: "approval", ref: token };
  const interaction = INTERACTION_REF.exec(token);
  if (interaction) return { kind: "interaction", ref: token, issueRef: interaction[1] };
  return null;
}
