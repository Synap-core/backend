/**
 * D4 — a relation edge INHERITS the lens of its endpoints (it is not stamped
 * with the ambient workspace of whoever happened to draw it). Placement, not
 * governance: the caller still gates the write on the ambient workspace.
 *
 *   both endpoints pod-wide (NULL)      → pod-wide edge (NULL)
 *   exactly one endpoint workspace-scoped → that endpoint's lens
 *   both scoped & equal                 → that shared lens
 *   both scoped & DIFFERENT             → the ambient fallback (open edge case:
 *                                          there is no single endpoint lens to
 *                                          inherit; we keep prior behaviour)
 *   endpoints not both loaded           → ambient fallback (can't safely infer)
 */
export function inheritRelationWorkspaceId(
  endpointWorkspaceIds: Array<string | null>,
  ambientFallback: string
): string | null {
  if (endpointWorkspaceIds.length !== 2) return ambientFallback;
  const [a, b] = endpointWorkspaceIds;
  if (a == null && b == null) return null;
  if (a != null && b != null) return a === b ? a : ambientFallback;
  return (a ?? b) as string;
}
