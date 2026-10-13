import type { PluginContext } from "@paperclipai/plugin-sdk";

const TTL_MS = 5 * 60_000;

/** Resolves the company URL prefix (uppercase issue prefix) with a small TTL cache. */
export function createLinkResolver(ctx: PluginContext, now: () => number = Date.now) {
  const cache = new Map<string, { prefix: string | null; at: number }>();
  const prefixOf = async (companyId: string): Promise<string | null> => {
    const hit = cache.get(companyId);
    if (hit && now() - hit.at < TTL_MS) {
      return hit.prefix;
    }
    let prefix: string | null = null;
    try {
      const company = await ctx.companies.get(companyId);
      prefix = company?.issuePrefix ? company.issuePrefix.trim().toUpperCase() : null;
    } catch {
      prefix = hit?.prefix ?? null;
    }
    cache.set(companyId, { prefix, at: now() });
    return prefix;
  };
  return {
    /** Path relative to the web origin, e.g. "/ACME/dashboards?d=my-slug". */
    async viewPath(companyId: string, slug: string): Promise<string> {
      const prefix = await prefixOf(companyId);
      return `${prefix ? `/${prefix}` : ""}/dashboards?d=${encodeURIComponent(slug)}`;
    },
  };
}

export type LinkResolver = ReturnType<typeof createLinkResolver>;
