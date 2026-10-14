/** A user-correctable failure whose message is safe to show to agents and board users. */
export class HierarchyError extends Error {
  constructor(
    readonly code: HierarchyErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type HierarchyErrorCode =
  | "invalid_input"
  | "project_not_found"
  | "parent_not_found"
  | "parent_archived"
  | "self_parent"
  | "cycle";
