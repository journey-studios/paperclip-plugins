import { readBounded } from './bounded-response.mjs';

const PROFILE_LIMIT_BYTES = 64 * 1024;
const IDENTITY_TIMEOUT_MS = 10_000;

export const IDENTITY_DESCRIPTION = 'Get the authenticated human profile (actorType: board) or the native agent self view. Uses the existing credentials; does not impersonate an agent.';

export class IdentityLookupError extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nullableText = (value, limit) => value === null || (typeof value === 'string' && value.length <= limit);

function boardActor(profile) {
  if (!isRecord(profile) || typeof profile.id !== 'string' || !profile.id.trim() || profile.id.length > 256
    || !nullableText(profile.name, 1024) || !nullableText(profile.email, 320) || !nullableText(profile.image, 4096)) {
    throw new IdentityLookupError('identity_invalid_response', 'Paperclip returned an invalid identity profile.');
  }
  // /auth/profile itself authenticates a board actor. Ignore every other field,
  // especially sessions, key material, roles and future credential metadata.
  return { actorType: 'board', id: profile.id, name: profile.name, email: profile.email, image: profile.image };
}

/**
 * Probe the native human endpoint using the SAME bearer as the stock server.
 * Only its precise agent-vs-board rejection permits native agent forwarding.
 * Revoked keys, missing users, forbidden requests, transport failures, bad JSON
 * and redirects never trigger a fallback, and identities are never cached.
 */
export async function resolveBoardIdentity(config, fetchImpl = globalThis.fetch) {
  const apiRoot = config.apiBase.replace(/\/+$/, '').replace(/\/api$/, '');
  const url = new URL(`${apiRoot}/api/auth/profile`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IDENTITY_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${config.apiKey}`, accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    });
    const text = await readBounded(response, PROFILE_LIMIT_BYTES);
    let body;
    try { body = JSON.parse(text); } catch { body = null; }
    if (response.status === 401 && isRecord(body) && body.error === 'Board authentication required') {
      // Not an authorization bypass: the unchanged stock /agents/me endpoint
      // must independently authenticate the same key and enforce agent scope.
      return { kind: 'native-agent' };
    }
    if (!response.ok) {
      const code = response.status === 401 ? 'identity_unauthorized'
        : response.status === 403 ? 'identity_forbidden' : 'identity_upstream_error';
      throw new IdentityLookupError(code, `Paperclip identity request failed (HTTP ${response.status}).`, response.status);
    }
    if (response.status !== 200) {
      throw new IdentityLookupError('identity_invalid_response', 'Paperclip returned an invalid identity profile.');
    }
    return { kind: 'board', actor: boardActor(body) };
  } catch (error) {
    if (error instanceof IdentityLookupError) throw error;
    // Do not echo fetch exceptions, upstream bodies or credentials to MCP/logs.
    throw new IdentityLookupError('identity_unavailable', 'Paperclip identity could not be verified. Retry when the service is available.');
  } finally {
    clearTimeout(timer);
  }
}

export function identityToolError(error) {
  const known = error instanceof IdentityLookupError;
  const detail = known
    ? { code: error.code, error: error.message, ...(error.status !== null ? { status: error.status } : {}) }
    : { code: 'identity_unavailable', error: 'Paperclip identity could not be verified.' };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(detail, null, 2) }] };
}
