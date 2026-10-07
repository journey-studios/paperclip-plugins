export function isRevisionProducingActivity(action: string): boolean;
export function revisionReferenceFromActivity(payload: Record<string, unknown>): string | null;
export function agentActivitySnapshot(
  agentSnapshot: Record<string, unknown>,
  action: string,
  details: unknown,
  currentStateReadAt: string,
  currentStateUpdatedAt: string | null,
): Record<string, unknown>;
export function skillActivitySnapshot(
  skillSnapshot: Record<string, unknown>,
  action: string,
  details: unknown,
  currentStateReadAt: string,
  currentStateUpdatedAt: string | null,
): Record<string, unknown>;
export function captureTimestamp(value: unknown): string | null;
export function sourceItemExists(
  db: { query: (sql: string, params: unknown[]) => Promise<unknown[]> },
  companyId: string,
  sourceType: string,
  sourceRef: string | null | undefined,
): Promise<boolean>;
export function sourceSnapshotId(
  db: { query: (sql: string, params: unknown[]) => Promise<Array<{ id: string }>> },
  companyId: string,
  entityType: string,
  entityId: string,
  sourceType: string,
  sourceRef: string,
): Promise<string | null>;
export const RUN_METRIC_AGGREGATION_SQL: string;
