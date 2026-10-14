import type { PluginApiRequestInput, PluginApiResponse, PluginContext } from "@paperclipai/plugin-sdk";
import { addEntry, listChangelog, updateEntry } from "./changelog.js";
import { importDoneIssues } from "./changelog-issues.js";
import { InvalidEntryError, parseEntryPatch, parseNewEntry } from "./changelog-input.js";
import type { Actor, ApiSummary, DashboardRecord, DashboardSummary, DatasetStatus } from "./contracts.js";
import {
  InvalidSpecError,
  ProjectError,
  SpecTooLargeError,
  getDashboard,
  listDashboards,
  setDashboardProject,
  slugOf,
  updateDataset,
  upsertDashboard,
  validateDashboardSpec,
} from "./dashboards.js";
import { DashboardError, NotFoundError } from "./errors.js";
import type { LinkResolver } from "./links.js";
import { computeFreshness, computeStatus } from "./status.js";
import { GUID, getSettings, uuid, type companySerialQueue } from "./store-util.js";

type Serial = ReturnType<typeof companySerialQueue>;
type Body = Record<string, unknown>;

const MAX_DETAILS = 50;
const MAX_DETAIL_LENGTH = 300;

function isRecord(value: unknown): value is Body {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cappedDetails(details: string[]): string[] {
  return details.slice(0, MAX_DETAILS).map((detail) => detail.slice(0, MAX_DETAIL_LENGTH));
}

function reply(companyId: string, status: number, body: Body): PluginApiResponse {
  return { status, headers: { "cache-control": "no-store" }, body: { companyId, ...body } };
}

function ok(companyId: string, body: Body): PluginApiResponse {
  return reply(companyId, 200, body);
}

/** Request-shape problem: maps to 400. */
class BadRequest extends DashboardError {}

function requireBody(body: unknown): Body {
  if (!isRecord(body)) {
    throw new BadRequest("body must be a JSON object");
  }
  return body;
}

function actorOf(input: PluginApiRequestInput): Actor {
  return { kind: "user", id: input.actor.userId ?? input.actor.actorId };
}

function oneParam(value: string | string[] | undefined, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    throw new BadRequest(`${label} must be given once`);
  }
  return value;
}

function datasetIdOf(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw new BadRequest("datasetId must match [A-Za-z0-9_-]{1,64}");
  }
  return value;
}

function optionalString(body: Body, key: string): string | undefined {
  const value = body[key];
  if (value !== undefined && typeof value !== "string") {
    throw new BadRequest(`${key} must be a string`);
  }
  return value;
}

export function createApi(ctx: PluginContext, serial: Serial, links: LinkResolver) {
  async function summary(companyId: string, record: DashboardSummary): Promise<ApiSummary> {
    return {
      id: record.id,
      slug: record.slug,
      title: record.title,
      projectId: record.projectId,
      projectName: record.projectName,
      revision: record.revision,
      updatedAt: record.updatedAt,
      updatedBy: record.updatedBy,
      viewPath: await links.viewPath(companyId, record.slug),
    };
  }

  async function required(companyId: string, slug: string): Promise<DashboardRecord> {
    const record = await getDashboard(ctx, { companyId, slug: slugOf(slug) });
    if (!record) {
      throw new NotFoundError("not_found");
    }
    return record;
  }

  function datasetStatus(record: DashboardRecord, datasetId: string, settings: Awaited<ReturnType<typeof getSettings>>): DatasetStatus {
    const found = computeFreshness(record.spec, settings, new Date()).datasets.find((dataset) => dataset.id === datasetId);
    if (!found) {
      throw new NotFoundError("not_found");
    }
    return found;
  }

  async function route(input: PluginApiRequestInput, companyId: string): Promise<PluginApiResponse> {
    switch (input.routeKey) {
      case "dashboards-list": {
        const projectId = oneParam(input.query.projectId, "projectId");
        const items = await listDashboards(ctx, { companyId, projectId });
        return ok(companyId, { dashboards: await Promise.all(items.map((item) => summary(companyId, item))) });
      }
      case "dashboard-get": {
        const record = await required(companyId, input.params.slug ?? "");
        return ok(companyId, { dashboard: { ...(await summary(companyId, record)), spec: record.spec } });
      }
      case "dashboard-status": {
        const record = await required(companyId, input.params.slug ?? "");
        const settings = await getSettings(ctx, companyId);
        const viewPath = await links.viewPath(companyId, record.slug);
        return ok(companyId, { status: computeStatus(record, settings, new Date(), viewPath) });
      }
      case "dashboard-upsert": {
        const body = requireBody(input.body);
        const slug = body.slug;
        if (typeof slug !== "string") {
          throw new BadRequest("slug is required");
        }
        if (body.spec === undefined) {
          throw new BadRequest("spec is required");
        }
        let projectId: string | undefined;
        if (body.projectId !== undefined) {
          if (typeof body.projectId !== "string") {
            throw new BadRequest("projectId must be a project UUID string (null is not accepted)");
          }
          projectId = uuid(body.projectId, "projectId");
        }
        const result = await serial(companyId, async () =>
          upsertDashboard(ctx, {
            companyId,
            slug,
            title: optionalString(body, "title"),
            // Required for a new dashboard; omitted keeps an existing dashboard's project (or lack of one).
            projectId,
            spec: body.spec,
            actor: actorOf(input),
            settings: await getSettings(ctx, companyId),
          }),
        );
        return ok(companyId, { created: result.created, dashboard: await summary(companyId, result.record) });
      }
      case "dataset-update": {
        const body = requireBody(input.body);
        const datasetId = datasetIdOf(input.params.datasetId);
        const slug = slugOf(input.params.slug);
        if (!Array.isArray(body.rows)) {
          throw new BadRequest("rows must be an array");
        }
        const settings = await getSettings(ctx, companyId);
        const { record } = await serial(companyId, () =>
          updateDataset(ctx, {
            companyId,
            slug,
            datasetId,
            rows: body.rows,
            columns: body.columns,
            description: body.description,
            source: body.source,
            updatedAt: body.updatedAt,
            actor: actorOf(input),
            settings,
          }),
        );
        return ok(companyId, { dashboard: await summary(companyId, record), dataset: datasetStatus(record, datasetId, settings) });
      }
      case "dashboard-move": {
        // Same logic as the dashboard.setProject board action. The contract answers every missing,
        // null or malformed projectId with project_required, so it is checked before the dashboard lookup.
        const projectId = isRecord(input.body) ? input.body.projectId : undefined;
        if (typeof projectId !== "string" || !GUID.test(projectId)) {
          throw new ProjectError("project_required", "projectId must be a project UUID of this company");
        }
        const result = await serial(companyId, async () => {
          const before = await required(companyId, input.params.slug ?? "");
          const record = await setDashboardProject(ctx, {
            companyId,
            id: before.id,
            projectId,
            actor: actorOf(input),
            settings: await getSettings(ctx, companyId),
          });
          return { moved: record.projectId !== before.projectId, record };
        });
        return ok(companyId, { moved: result.moved, dashboard: await summary(companyId, result.record) });
      }
      case "spec-validate": {
        const body = requireBody(input.body);
        if (body.spec === undefined) {
          throw new BadRequest("spec is required");
        }
        const spec = validateDashboardSpec(body.spec, await getSettings(ctx, companyId));
        return ok(companyId, {
          valid: true,
          datasets: Object.keys(spec.datasets).length,
          sections: spec.sections.length,
        });
      }
      case "changelog-list": {
        const { query } = input;
        const page = await listChangelog(ctx, companyId, {
          projectId: oneParam(query.projectId, "projectId"),
          kinds: oneParam(query.kind, "kind"),
          includeIssues: oneParam(query.includeIssues, "includeIssues"),
          before: oneParam(query.before, "before"),
          limit: oneParam(query.limit, "limit"),
        });
        return ok(companyId, { entries: page.entries, nextCursor: page.nextCursor });
      }
      case "changelog-add": {
        const body = requireBody(input.body);
        const projectId = uuid(body.projectId, "projectId");
        const fields = parseNewEntry(body, ["projectId"], new Date());
        const entry = await serial(companyId, () => addEntry(ctx, { companyId, projectId, fields, actor: actorOf(input) }));
        return ok(companyId, { entry });
      }
      case "changelog-import": {
        const body = requireBody(input.body);
        const settings = await getSettings(ctx, companyId);
        const result = await serial(companyId, () =>
          importDoneIssues(ctx, { companyId, projectId: body.projectId, settings, actor: actorOf(input) }),
        );
        return ok(companyId, { ...result });
      }
      case "changelog-update": {
        const patch = parseEntryPatch(requireBody(input.body), []);
        const entry = await serial(companyId, () =>
          updateEntry(ctx, { companyId, entryId: input.params.entryId, patch, actor: actorOf(input) }),
        );
        return ok(companyId, { entry });
      }
      default:
        throw new NotFoundError("not_found");
    }
  }

  return async function onApiRequest(input: PluginApiRequestInput): Promise<PluginApiResponse> {
    const companyId = input.companyId;
    try {
      uuid(companyId, "companyId");
      return await route(input, companyId);
    } catch (error) {
      if (error instanceof SpecTooLargeError) {
        return reply(companyId, 413, { error: "spec_too_large", limitBytes: error.limitBytes });
      }
      if (error instanceof InvalidSpecError) {
        return reply(companyId, 422, { error: "invalid_spec", details: cappedDetails(error.details) });
      }
      if (error instanceof InvalidEntryError) {
        return reply(companyId, 422, { error: "invalid_entry", details: cappedDetails(error.details) });
      }
      if (error instanceof NotFoundError) {
        return reply(companyId, 404, { error: "not_found" });
      }
      if (error instanceof ProjectError) {
        return reply(companyId, 400, { error: error.code });
      }
      if (error instanceof DashboardError) {
        return reply(companyId, 400, { error: error.message });
      }
      ctx.logger.error("project-dashboards API request failed", {
        routeKey: input.routeKey,
        error: error instanceof Error ? error.message : String(error),
      });
      return reply(companyId, 500, { error: "internal_error" });
    }
  };
}
