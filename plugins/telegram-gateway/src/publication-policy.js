const MAX_PUBLICATION_ATTEMPTS = 5;
const ACCEPTED_PUBLICATION_STATES = new Set(["published", "pending", "retry", "delivery_unknown"]);

class PermanentPublicationError extends Error {}

function assertPublicationAccepted(result) {
  if (!ACCEPTED_PUBLICATION_STATES.has(result?.state)) {
    throw new PermanentPublicationError(`Chat publication rejected: ${result?.state ?? "unknown"}`);
  }
}

function nextPublicationFailure(attempts, error) {
  const nextAttempts = attempts + 1;
  const permanent = error instanceof PermanentPublicationError;
  return {
    attempts: nextAttempts,
    lastFailure: permanent ? "provider_rejected" : "publication_attempt_failed",
    lastAttemptAt: new Date().toISOString(),
    terminal: permanent || nextAttempts >= MAX_PUBLICATION_ATTEMPTS,
  };
}

export {
  ACCEPTED_PUBLICATION_STATES,
  MAX_PUBLICATION_ATTEMPTS,
  PermanentPublicationError,
  assertPublicationAccepted,
  nextPublicationFailure,
};
