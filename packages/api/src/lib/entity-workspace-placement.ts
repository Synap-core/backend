/**
 * Entity workspace-placement precedence (rung 6 / K1) — thin re-export.
 *
 * The implementation MOVED to @synap/database in Wave 1, absorbed into the
 * `WorkspaceResolutionService` door so there is ONE implementation of the K1
 * precedence. Existing importers/tests keep pulling it from here unchanged.
 */
export {
  resolveEntityWorkspacePlacement,
  resolveKindWritePin,
  normalizeEntityScope,
  DEFAULT_ENTITY_SCOPE,
} from "@synap/database";
