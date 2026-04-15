/**
 * Search index workspace scope helpers.
 *
 * Typesense does not accept null for string fields. We normalize pod-wide
 * records (workspaceId = null) to a stable sentinel string.
 */
export const POD_WIDE_WORKSPACE_SCOPE = "__pod_wide__";

export function toSearchWorkspaceScope(
  workspaceId: string | null | undefined
): string {
  return workspaceId ?? POD_WIDE_WORKSPACE_SCOPE;
}
