import { performance } from "node:perf_hooks";

const SECRET_CACHE_TTL_MS = 30_000;
const SECRET_CACHE_MAX_ENTRIES = 128;
const cachesByContext = new WeakMap();

/** Keep cache identity aligned with both secret binding scope and config-path authorization. */
function cacheKey(companyId, configPath, ref) {
  return JSON.stringify([companyId, configPath, ref.type, ref.secretId, ref.version ?? "latest"]);
}

/** Remove values whose short rotation window elapsed; unresolved requests stay deduplicated. */
function pruneExpired(secretCache, now) {
  for (const [key, entry] of secretCache) {
    if (entry.expiresAt !== null && entry.expiresAt <= now) secretCache.delete(key);
  }
}

/** Evict the least recently used resolved value without abandoning in-flight work. */
function evictOldestResolved(secretCache) {
  for (const [key, entry] of secretCache) {
    if (entry.expiresAt !== null) {
      secretCache.delete(key);
      return true;
    }
  }
  return false;
}

/** Reject missing or malformed provider credentials before they can reach the SDK. */
function resolveValidatedSecret(secrets, ref, companyId, configPath) {
  return Promise.resolve(secrets.resolve(ref, { companyId, configPath })).then((value) => {
    if (typeof value !== "string" || value.length === 0) throw new Error("secret value unavailable");
    return value;
  });
}

/** Resolve one company-scoped secret reference with short-lived, bounded deduplication. */
export async function resolveCachedSecret(ctx, companyId, configPath, ref) {
  const secrets = ctx?.secrets;
  if (!secrets || typeof secrets.resolve !== "function") throw new Error("secret resolver unavailable");
  let secretCache = cachesByContext.get(ctx);
  if (!secretCache) {
    secretCache = new Map();
    cachesByContext.set(ctx, secretCache);
  }
  const now = performance.now();
  pruneExpired(secretCache, now);
  const key = cacheKey(companyId, configPath, ref);
  const existing = secretCache.get(key);
  if (existing) {
    secretCache.delete(key);
    secretCache.set(key, existing);
    return existing.promise;
  }

  // Never let a burst of distinct refs grow memory without bound. If all slots
  // are already resolving, resolve this request without retaining its result.
  while (secretCache.size >= SECRET_CACHE_MAX_ENTRIES && evictOldestResolved(secretCache)) {}
  if (secretCache.size >= SECRET_CACHE_MAX_ENTRIES) {
    return resolveValidatedSecret(secrets, ref, companyId, configPath);
  }

  const entry = { expiresAt: null, promise: null };
  entry.promise = Promise.resolve()
    .then(() => resolveValidatedSecret(secrets, ref, companyId, configPath))
    .then((value) => {
      entry.expiresAt = performance.now() + SECRET_CACHE_TTL_MS;
      return value;
    })
    .catch((error) => {
      if (secretCache.get(key) === entry) secretCache.delete(key);
      throw error;
    });
  secretCache.set(key, entry);
  return entry.promise;
}
