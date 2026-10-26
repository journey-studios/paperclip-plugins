import { createHash } from "node:crypto";
import { getAdapter } from "./adapters/index.js";
import { canonical, contentHash, PLATFORMS } from "./catalog.js";
import { selectedMedia } from "./media.js";

export class PolicyError extends Error {
  constructor(message, code = "policy_denied", status = 403) {
    super(message);
    this.name = "PolicyError";
    this.code = code;
    this.status = status;
  }
}
export function approvalMatches(post, now = Date.now()) {
  return Boolean(
    post.approvedAt &&
    post.approvedBy &&
    post.approvalHash &&
    post.approvalHash === post.contentHash &&
    contentHash(post) === post.contentHash &&
    new Date(post.approvalExpiresAt).getTime() > now,
  );
}
export function evaluateChannelPolicy(account, post, options = {}) {
  const deny = (reason, requiresApproval = false) => ({
    allowed: false,
    requiresApproval,
    reason,
    policy: account?.policy ?? "approval_required",
  });
  if (
    ["cancelled", "rejected", "superseded", "revision_requested", "approval_expired", "unknown", "failed"].includes(
      post.status,
    )
  )
    return deny(`Post status '${post.status}' prevents publication`);
  const needsHuman =
    post.campaign === "tessel-social-daily" ||
    post.campaign === "JOU-1051" ||
    options.requireApproval === true ||
    post.dryRun !== false;
  if (options.config?.killSwitch && !post.dryRun) return deny("Global kill switch is active");
  if (account?.killSwitch && !post.dryRun) return deny("Kill switch is active for this account");
  if (!post.dryRun) {
    if (!account || account.status !== "connected")
      return deny("Account not connected or not found");
    if (!["VERIFIED", "PUBLISH_TESTED"].includes(account.verificationStatus))
      return deny("Account authorization has not been verified");
    if (account.policy === "disabled")
      return deny("Publication to this channel is disabled by policy");
    if (
      !Number.isInteger(account.dailyLimit) ||
      account.dailyLimit < 1 ||
      account.postsToday >= account.dailyLimit
    )
      return deny("Daily post quota exceeded for account");
    if (
      options.actor?.actorType === "agent" &&
      !account.allowedAgentIds?.includes(options.actor.actorId)
    )
      return deny("Agent is not permitted for this account");
  }
  if (needsHuman || account?.policy === "approval_required") {
    if (!approvalMatches(post))
      return deny("Explicit approval for this exact version and destinations is required", true);
    return {
      allowed: true,
      requiresApproval: false,
      mode: "approved_publish",
      policy: "approval_required",
    };
  }
  if (account?.policy === "autonomous") {
    if (!account.autonomousOptIn) return deny("Autonomous destination opt-in is not active");
    if (!options.factsVerified)
      return deny("Autonomous factual evidence has not been independently verified");
    return {
      allowed: true,
      requiresApproval: false,
      mode: "autonomous_publish",
      policy: "autonomous",
    };
  }
  return deny("Unknown account policy");
}
export function validateContentForPlatforms(content, platforms) {
  const results = {};
  const errors = [];
  if (
    !Array.isArray(platforms) ||
    platforms.length < 1 ||
    platforms.length > 4 ||
    new Set(platforms).size !== platforms.length
  )
    return {
      valid: false,
      errors: ["One to four unique platforms are required"],
      platforms: results,
    };
  if (typeof content.text !== "string" || !content.text.trim()) errors.push("Text is required");
  for (const platform of platforms) {
    if (!PLATFORMS.includes(platform)) {
      errors.push(`Unsupported platform: ${String(platform).slice(0, 40)}`);
      continue;
    }
    try {
      const override = content.platformCustomizations?.[platform] ?? {};
      const selected = selectedMedia(content, platform);
      const channelContent = {
        text: override.text ?? content.text,
        mediaUrls: selected.urls,
        ...(selected.refs.length ? { mediaRefs: selected.refs, mediaMimeTypes: selected.refs.map((ref) => ref.contentType) } : {}),
        linkUrl: override.linkUrl ?? content.linkUrl,
      };
      const result = getAdapter(platform).validate(channelContent);
      results[platform] = result;
      if (!result.valid) errors.push(...result.errors.map((error) => `[${platform}] ${error}`));
    } catch {
      errors.push(`[${platform}] Content format is invalid`);
    }
  }
  return { valid: errors.length === 0, errors, platforms: results };
}
export function factualEvidenceStatus(post, config = {}) {
  const evidence = post.metadata?.factualEvidence;
  const valid =
    Array.isArray(evidence) &&
    evidence.length > 0 &&
    evidence.length <= 20 &&
    evidence.every((item) => {
      if (
        typeof item?.claim !== "string" ||
        !item.claim.trim() ||
        item.releaseStatus !== "released" ||
        typeof item.sourceUrl !== "string"
      )
        return false;
      try {
        const u = new URL(item.sourceUrl);
        return (
          u.protocol === "https:" &&
          !u.username &&
          !u.password &&
          (u.hostname === "tessel.app" ||
            u.hostname.endsWith(".tessel.app") ||
            (u.hostname === "github.com" && u.pathname.startsWith("/wallynm/tesselapp/")))
        );
      } catch {
        return false;
      }
    });
  const evidenceHashes = valid
    ? evidence.map((item) => createHash("sha256").update(canonical(item)).digest("hex"))
    : [];
  const independentlyVerified =
    valid &&
    Array.isArray(config.verifiedEvidenceHashes) &&
    evidenceHashes.every((hash) => config.verifiedEvidenceHashes.includes(hash));
  return {
    valid,
    independentlyVerified,
    status: independentlyVerified ? "VERIFIED" : valid ? "HUMAN_REVIEW_REQUIRED" : "MISSING",
    evidence: valid ? evidence : [],
    evidenceHashes,
  };
}
export function sameTargets(left, right) {
  return canonical(left) === canonical(right);
}
