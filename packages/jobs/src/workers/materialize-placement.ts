/**
 * Read-back of the RESOLVED workspace placement a create/attach door already
 * computed and persisted into a proposal's `data` (invariant I3:
 * resolve-early-and-persist). The materializer must land a proposal-gated write
 * EXACTLY where an auto-approved one would — so it reads the persisted value
 * verbatim rather than re-deriving from the ambient governance workspace (the
 * "four-door" bug: same capture lands pod-wide if auto-approved, workspace-pinned
 * if reviewed).
 *
 * Backward compat: proposals created before `resolvedWorkspaceId` existed lack
 * the key → fall back to the historical derivation. A present-but-null value is
 * meaningful (a pod-scope kind resolved to NULL) and MUST win over the fallback,
 * so both helpers branch on KEY PRESENCE, never on `??`.
 */

/** Entity-create read-back. Legacy fallback: `data.global ? null : ambient`. */
export function resolveMaterializedEntityWorkspaceId(
  data: Record<string, unknown>,
  ambientWorkspaceId: string | null | undefined
): string | null {
  if ("resolvedWorkspaceId" in data) {
    return (data.resolvedWorkspaceId as string | null) ?? null;
  }
  return data.global ? null : (ambientWorkspaceId ?? null);
}

/**
 * Facet-attach read-back. Legacy fallback: `data.workspaceId ?? ambient` (the
 * facet lens the door persisted, else the ambient governance workspace).
 */
export function resolveMaterializedFacetWorkspaceId(
  data: Record<string, unknown>,
  ambientWorkspaceId: string | null | undefined
): string | null {
  if ("resolvedWorkspaceId" in data) {
    return (data.resolvedWorkspaceId as string | null) ?? null;
  }
  return (data.workspaceId as string | undefined) ?? ambientWorkspaceId ?? null;
}
