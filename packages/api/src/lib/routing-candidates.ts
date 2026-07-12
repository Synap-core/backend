/**
 * Routable workspace-type predicate — thin re-export.
 *
 * The implementation MOVED to @synap/database in Wave 1 so the door and this
 * api-side candidate-list builder share ONE definition. Existing importers keep
 * pulling `isRoutableWorkspaceType` from here unchanged.
 */
export { isRoutableWorkspaceType } from "@synap/database";
