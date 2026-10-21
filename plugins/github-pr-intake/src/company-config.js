import { mergeCompanyConfigs, normalizeConfig } from "./config.js";

const MAX_COMPANIES = 200;

/**
 * Plugin configuration lives per company in the host (`ctx.config.get` refuses calls without one),
 * and a webhook does not say which company it is for. So every company's configuration is read and
 * merged; the company is then recovered from the repository (and from the webhook secret that verified).
 */
export async function loadConfig(ctx) {
  const companies = await ctx.companies.list({ limit: MAX_COMPANIES });
  // Read in parallel, but keep the company order: it decides who keeps a repository listed twice.
  const raws = await Promise.all(companies.map((company) => ctx.config.get(company.id)));
  const configs = [];
  companies.forEach((company, index) => {
    const raw = raws[index];
    if (raw && typeof raw === "object" && Object.keys(raw).length > 0) configs.push(normalizeConfig(raw, company.id));
  });
  const merged = mergeCompanyConfigs(configs);
  if (merged.duplicates.length) {
    ctx.logger.warn("github-pr-intake: repository configured in more than one company; the first one is used", {
      repositories: merged.duplicates,
    });
  }
  return merged;
}
