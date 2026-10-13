/** A user-correctable failure whose message is safe to show to agents and board users. */
export class DashboardError extends Error {}

/** The dashboard, dataset, revision or changelog entry does not exist in this company. */
export class NotFoundError extends DashboardError {}
