/**
 * Which workspace TYPES may be offered as AUTO-routing candidates for captured
 * user data. Excludes:
 *   • `operational` — system/admin surfaces (e.g. pod-admin); user data must
 *     never land there.
 *   • `agent` (ratified decision D2) — agent workspaces are never AUTO-routing
 *     candidates. Explicit `workspaceId` targeting elsewhere is unaffected.
 *
 * Archival is orthogonal and enforced at the query level (`archivedAt IS NULL`)
 * — an archived workspace of ANY type is never a candidate.
 */
export function isRoutableWorkspaceType(
  workspaceType: string | null | undefined
): boolean {
  return workspaceType !== "operational" && workspaceType !== "agent";
}
