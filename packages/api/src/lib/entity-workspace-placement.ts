/**
 * Entity workspace-placement precedence — the ONE resolver for "where does this
 * entity land" on the create path. Pure (no DB/IO) so it runs identically at
 * proposal-creation time (persist the result) and on the auto-approved inline
 * write, guaranteeing invariant I3: the SAME input resolves to the SAME
 * placement regardless of governance (auto-approved vs proposal-gated).
 *
 * Precedence (unchanged from the historical K1 inline block):
 *   1. `global` flag              → null (visible everywhere)
 *   2. explicit `targetWorkspaceId` → that workspace (wins for ALL profiles,
 *      including pod-default ones)
 *   3. `workspaceScoped` flag     → the ambient workspace (explicit isolation
 *      request, e.g. imports — overrides a profile's pod-default)
 *   4. otherwise                  → profile pod-default (entityScope "pod" →
 *      null) else the ambient workspace (today's interactive behavior)
 */
export function resolveEntityWorkspacePlacement(input: {
  global: boolean;
  targetWorkspaceId?: string | null;
  workspaceScoped: boolean;
  /** The profile's `entityScope` ("pod" | "workspace"); defaults to "workspace". */
  profileEntityScope?: string | null;
  /** The governance/ambient workspace (targetWorkspaceId ?? ctx.workspaceId ?? null). */
  ambientWorkspaceId: string | null;
}): string | null {
  if (input.global) return null;
  if (input.targetWorkspaceId) return input.targetWorkspaceId;
  if (input.workspaceScoped) return input.ambientWorkspaceId;
  const scope = input.profileEntityScope ?? "workspace";
  return scope === "pod" ? null : input.ambientWorkspaceId;
}
