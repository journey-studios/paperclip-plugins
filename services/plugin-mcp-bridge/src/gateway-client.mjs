import { parseApiBase } from './api-base.mjs';
import { readBounded } from './bounded-response.mjs';
import { isRecord } from './dashboards.mjs';

// The gateway caps a session at 60 minutes; asking for the maximum means one session normally
// covers a whole run and renewals are the exception.
const SESSION_TTL_MS = 60 * 60_000;
// Renew early so a call never starts with a token that expires mid-flight.
const RENEW_MARGIN_MS = 60_000;
const SESSION_TIMEOUT_MS = 15_000;
const LIST_TIMEOUT_MS = 20_000;
// The gateway enforces its own budget for the upstream call; the HTTP timeout is a little longer
// so the gateway's structured timeout answer arrives before this process gives up.
const CALL_BUDGET_MS = 55_000;
const CALL_HTTP_TIMEOUT_MS = 60_000;
const REVOKE_TIMEOUT_MS = 2_000;
const MAX_BODY_BYTES = 1024 * 1024;

// The gateway token is a different credential from the agent key, and is sent raw (no `Bearer`).
const TOKEN_HEADER = 'x-paperclip-tool-gateway-token';

// Session creation answering one of these means this process is not inside an active agent run
// (board key, wrong or finished run, unknown agent, bad JWT). The process lives inside a single
// run, so retrying can never succeed and would only spam the API.
const NO_RUN_STATUSES = new Set([400, 401, 403, 404]);
const RECREATE_SESSION_CODES = new Set(['session_expired', 'session_revoked', 'session_invalid']);
const RUN_ENDED_CODE = 'session_run_inactive';

// Only short code-like strings are ever surfaced from error bodies, so a body (or a stack trace, or
// an HTML error page) cannot reach the model through a code field.
const CODE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** `PAPERCLIP_API_URL` has no `/api` suffix in agent runs; tolerate one so both spellings work. */
function gatewayRoot(apiBase) {
  return `${apiBase.replace(/\/+$/, '').replace(/\/api$/, '')}/api/tool-gateway`;
}

/** Distinct code-like strings found in the fields the gateway uses for machine-readable reasons. */
function extractCodes(body) {
  if (!isRecord(body)) return [];
  const codes = [];
  for (const value of [body.reasonCode, body.code, body.error]) {
    if (typeof value === 'string' && CODE_RE.test(value) && !codes.includes(value)) codes.push(value);
  }
  return codes;
}

/**
 * Turn a non-2xx answer into a neutral outcome:
 * - `refused`: the gateway understood the request and said no (4xx). Only `error`, `instructions`
 *   and code-like strings are kept; nothing else from the body survives.
 * - `failed`: upstream or transport trouble (5xx, anything unexpected). Carries at most one code,
 *   never a body, because 502/504 bodies hold execution details that must not reach the model.
 */
function classifyFailure(status, body) {
  const codes = extractCodes(body);
  if (status >= 400 && status < 500 && status !== 401) {
    return {
      kind: 'refused',
      httpStatus: status,
      codes,
      error: isRecord(body) && typeof body.error === 'string' ? body.error : undefined,
      instructions: isRecord(body) && typeof body.instructions === 'string' ? body.instructions : undefined,
    };
  }
  return { kind: 'failed', httpStatus: status, reasonCode: codes[0] };
}

/**
 * Session lifecycle and REST access to the Paperclip tool gateway for ONE agent run. It knows
 * nothing about MCP: callers get neutral outcomes (`ok`, `refused`, `failed`, `unavailable`) and
 * decide how to present them.
 *
 * The agent key (`PAPERCLIP_API_KEY`) is only ever sent to the session endpoints; tool traffic uses
 * the short-lived gateway token. Neither value is stored anywhere but private fields, nor logged.
 */
export class GatewayClient {
  #root;
  #apiKey;
  #fetch;
  #now;
  #session = null;
  #creating = null;
  #unavailable = false;
  #closed = false;
  #inflight = new Set();

  constructor({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    this.#fetch = fetchImpl;
    this.#now = now;
    const apiKey = env.PAPERCLIP_API_KEY;
    // Outside a run (a human starting the agent CLI) the environment simply has no credentials:
    // that is "not available here", not a misconfiguration. A malformed URL still throws below.
    if (!env.PAPERCLIP_API_URL || !apiKey) {
      this.#unavailable = true;
      return;
    }
    this.#root = gatewayRoot(parseApiBase(env));
    this.#apiKey = apiKey;
  }

  /** True once this process is known to be outside an active agent run. It never flips back. */
  get unavailable() { return this.#unavailable; }

  /** Tools the agent may use right now: `{ kind: 'ok', tools }` with raw gateway descriptors. */
  async listTools() {
    const response = await this.#authorized((token) => this.#exchange('/tools', {
      method: 'GET', headers: { [TOKEN_HEADER]: token }, timeoutMs: LIST_TIMEOUT_MS,
    }));
    if (response.kind !== 'response') return response;
    // The gateway answers a bare JSON array; anything else is not a catalog we can trust.
    if (!Array.isArray(response.json)) return { kind: 'failed', httpStatus: response.status };
    return { kind: 'ok', tools: response.json.filter((entry) => isRecord(entry) && typeof entry.name === 'string' && entry.name) };
  }

  /** Run one tool: `{ kind: 'ok', envelope }` for any HTTP 200, otherwise a refusal or failure. */
  async callTool(tool, parameters) {
    const body = JSON.stringify({ tool, parameters, timeoutMs: CALL_BUDGET_MS });
    const response = await this.#authorized((token) => this.#exchange('/tools/call', {
      method: 'POST', headers: { [TOKEN_HEADER]: token }, body, timeoutMs: CALL_HTTP_TIMEOUT_MS,
    }));
    if (response.kind !== 'response') return response;
    if (!isRecord(response.json)) return { kind: 'failed', httpStatus: response.status };
    return { kind: 'ok', envelope: response.json };
  }

  /**
   * Stop in-flight tool traffic and revoke the session, best effort: the process is exiting, the run
   * may already be over, and the session expires on its own anyway, so no failure here matters.
   *
   * A session creation that is still running is not aborted but awaited: the gateway may already
   * have opened the session, and only its answer carries the id needed to revoke it. Aborting would
   * leave a valid session behind for up to an hour. The creation's own 15 s timeout bounds the wait.
   */
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const controller of this.#inflight) controller.abort();
    const creating = this.#creating;
    if (creating) await creating;
    const session = this.#session;
    this.#session = null;
    if (!session || this.#unavailable) return;
    await this.#exchange(`/sessions/${encodeURIComponent(session.sessionId)}/revoke`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.#apiKey}` },
      body: '{}',
      timeoutMs: REVOKE_TIMEOUT_MS,
      track: false,
    });
  }

  /**
   * Send one gateway request with a live session. A 401 saying the session itself is gone gets one
   * fresh session and one repeat: the gateway authenticates before it runs anything, so a repeat
   * after that 401 cannot execute a tool twice. A 401 saying the run ended makes the client
   * unavailable for good.
   */
  async #authorized(send) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const ensured = await this.#ensureSession();
      if (ensured.kind !== 'session') return ensured;
      // close() may have run while this request waited for the session; its revoke is already
      // underway, so the token must not be used for new traffic.
      if (this.#closed) return { kind: 'unavailable' };
      const response = await send(ensured.session.token);
      if (response.kind !== 'response') return response;
      if (response.status === 401) {
        const codes = extractCodes(response.json);
        if (codes.includes(RUN_ENDED_CODE)) return this.#markUnavailable();
        if (attempt === 0 && codes.some((code) => RECREATE_SESSION_CODES.has(code))) {
          // Compare by identity so a concurrent request that already renewed keeps its fresh session.
          if (this.#session === ensured.session) this.#session = null;
          continue;
        }
      }
      if (response.status >= 200 && response.status < 300) return response;
      return classifyFailure(response.status, response.json);
    }
    return { kind: 'failed', httpStatus: 401 };
  }

  #markUnavailable() {
    this.#unavailable = true;
    this.#session = null;
    return { kind: 'unavailable' };
  }

  #sessionIsFresh() {
    return this.#session !== null && this.#session.expiresAt - this.#now() > RENEW_MARGIN_MS;
  }

  /** At most one session creation runs at a time; concurrent callers share its result. */
  async #ensureSession() {
    if (this.#unavailable || this.#closed) return { kind: 'unavailable' };
    if (this.#sessionIsFresh()) return { kind: 'session', session: this.#session };
    // #createSession never rejects, so the shared promise cannot leave an unhandled rejection behind.
    this.#creating ??= this.#createSession().finally(() => { this.#creating = null; });
    return this.#creating;
  }

  async #createSession() {
    const response = await this.#exchange('/sessions', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.#apiKey}` },
      body: JSON.stringify({ ttlMs: SESSION_TTL_MS }),
      timeoutMs: SESSION_TIMEOUT_MS,
      // Untracked so close() cannot abort it: see close().
      track: false,
    });
    if (response.kind !== 'response') return response;
    if (NO_RUN_STATUSES.has(response.status)) return this.#markUnavailable();
    const created = response.json;
    if (response.status < 200 || response.status >= 300 || !isRecord(created)
      || typeof created.token !== 'string' || !created.token
      || typeof created.sessionId !== 'string' || !created.sessionId) {
      return classifyFailure(response.status, response.json);
    }
    const expiresAt = typeof created.expiresAt === 'number' ? created.expiresAt : Date.parse(created.expiresAt);
    // Without a usable expiry assume the requested lifetime; renewal then stays conservative.
    this.#session = {
      sessionId: created.sessionId,
      token: created.token,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : this.#now() + SESSION_TTL_MS,
    };
    return { kind: 'session', session: this.#session };
  }

  /**
   * One bounded HTTP exchange. Redirects are rejected so a credential is never forwarded to a
   * different host. Transport errors, timeouts and oversized bodies collapse into a `failed`
   * outcome; a body that is not JSON arrives as `json: undefined`.
   */
  async #exchange(path, { method, headers, body, timeoutMs, track = true }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (track) this.#inflight.add(controller);
    try {
      const response = await this.#fetch(`${this.#root}${path}`, {
        method,
        headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        ...(body === undefined ? {} : { body }),
        redirect: 'error',
        signal: controller.signal,
      });
      const text = await readBounded(response, MAX_BODY_BYTES);
      let json;
      try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
      return { kind: 'response', status: response.status, json };
    } catch {
      return { kind: 'failed' };
    } finally {
      clearTimeout(timer);
      this.#inflight.delete(controller);
    }
  }
}
