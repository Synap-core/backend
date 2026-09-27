/**
 * The user's DEFAULT workspace — the ONE fallback. Lives in @synap/database
 * (`utils/user-default-workspace.ts`) so the pod bootstrap uses the same
 * ordered lookup; re-exported here for the api's existing callers.
 */
export { findUserDefaultWorkspaceId } from "@synap/database";
