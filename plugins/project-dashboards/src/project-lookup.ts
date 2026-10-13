import type { PluginContext } from "@paperclipai/plugin-sdk";

const TTL_MS = 60_000;
const caches = new WeakMap<PluginContext, Map<string, { urlKey: string | null; at: number }>>();

/**
 * URL keys (the host's project route segment) for the given projects, cached
 * briefly because lists poll. A failed lookup yields null and is not cached.
 */
export async function projectUrlKeys(
  ctx: PluginContext,
  companyId: string,
  projectIds: readonly (string | null)[],
  now: () => number = Date.now,
): Promise<Map<string, string | null>> {
  let cache = caches.get(ctx);
  if (!cache) {
    cache = new Map();
    caches.set(ctx, cache);
  }
  const store = cache;
  const keys = new Map<string, string | null>();
  const ids = [...new Set(projectIds.filter((id): id is string => id !== null))];
  await Promise.all(
    ids.map(async (id) => {
      const cacheKey = `${companyId}:${id}`;
      const hit = store.get(cacheKey);
      if (hit && now() - hit.at < TTL_MS) {
        keys.set(id, hit.urlKey);
        return;
      }
      try {
        const project = await ctx.projects.get(id, companyId);
        const urlKey = project && typeof project.urlKey === "string" && project.urlKey ? project.urlKey : null;
        store.set(cacheKey, { urlKey, at: now() });
        keys.set(id, urlKey);
      } catch {
        keys.set(id, null);
      }
    }),
  );
  return keys;
}
