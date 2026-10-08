import { createHash } from "node:crypto";
import {
  CARD_MARKER,
  INTERACTION_ISSUE_LIMIT_PER_STATUS,
  INTERACTION_ISSUE_STATUSES,
  approvalFingerprint,
  buildApprovalCardBody,
  buildInteractionCardBody,
  cardDeliveryId,
  interactionFingerprint,
  isFounderReachableInteraction,
} from "./human-decisions.js";

const EVENT_PREFIX = "[FOUNDER_COMMS_EVENT]";
const HUMAN_DECISION_STATE_KEY = "human-decision-fingerprints";
const MAX_PROCESSED = 500;
const MAX_QUEUE = 100;
const MAX_PENDING_RUNS = 200;
const MAX_PUBLISHED = 500;
const MAX_PUBLICATION_ATTEMPTS = 5;

class PermanentPublicationError extends Error {}

let knownCompaniesTail = Promise.resolve();

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function publishHumanDecisionCard(ctx, companyId, config, deliveryId, cardBody) {
  const conversation = await resolveConversation(ctx, companyId, config);
  if (!conversation) return { delivered: false, reason: "conversation_not_bound" };
  return { delivered: true, commentId: "x", issueId: conversation.id };
}
