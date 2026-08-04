/**
 * Re-exports I3 placement read-back helpers from `@synap/database` (canonical
 * home next to `resolveEntityWorkspacePlacement`). Kept so jobs materializer
 * import paths stay stable; approve executors import from `@synap/database`
 * directly.
 */
export {
  resolveMaterializedEntityWorkspaceId,
  resolveMaterializedFacetWorkspaceId,
  resolveMaterializedRelationWorkspaceId,
} from "@synap/database";
