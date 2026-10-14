/**
 * Validate `PAPERCLIP_API_URL` and return it without a trailing slash.
 *
 * Both stdio servers send a bearer credential to this URL, so it must be HTTPS. Plain HTTP is only
 * accepted for loopback (local development) or when the operator opts in explicitly with
 * `PAPERCLIP_ALLOW_INSECURE_HTTP=1` on a network they trust. Credentials embedded in the URL are
 * refused so they can never end up in a request line or a log.
 *
 * Errors are deliberately generic: callers print them, and the URL may be sensitive.
 */
export function parseApiBase(env) {
  const apiUrl = env.PAPERCLIP_API_URL;
  if (!apiUrl) throw new Error('bridge configuration is incomplete');
  let parsed;
  try { parsed = new URL(apiUrl); } catch { throw new Error('bridge configuration is invalid'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  const insecureHttpAllowed = parsed.protocol === 'http:' && (loopback || env.PAPERCLIP_ALLOW_INSECURE_HTTP === '1');
  if (!(parsed.protocol === 'https:' || insecureHttpAllowed) || parsed.username || parsed.password) {
    throw new Error('bridge configuration is invalid');
  }
  return parsed.toString().replace(/\/$/, '');
}
