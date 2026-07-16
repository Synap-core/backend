/**
 * normalizeProfileScope — the ONE door that turns a template/definition's
 * declared `scope` token into the DB's `profiles.scope` vocabulary.
 *
 * WHY THIS EXISTS (the bug it closes):
 * -----------------------------------
 * Both provisioning doors (`createWorkspaceFromDefinition` and
 * `reconcileWorkspaceFromDefinition`) each carried their OWN copy of:
 *
 *     const scopeMap: Record<string, string> =
 *       { SYSTEM: "system", SHARED: "shared", WORKSPACE: "workspace", USER: "user" };
 *     const scope = profile.scope ? (scopeMap[profile.scope] ?? "workspace") : "workspace";
 *
 * Template sources declare scope in MIXED case — `@synap-core/workspace-templates`
 * currently ships 55 × `"WORKSPACE"` and 17 × `"shared"`. The UPPERCASE-keyed
 * lookup therefore resolved `"shared"` to `undefined`, and the `?? "workspace"`
 * fallback silently demoted every one of those 17 pod-wide shared roles to a
 * private per-workspace duplicate — forking the identity the shared scope exists
 * to unify, and turning the apply layer's pod-wide branches into dead code.
 *
 * `Record<string, string>` is what made this survivable: it accepts ANY key and
 * returns `string | undefined` with no complaint, so the compiler had nothing to
 * say and `tsc` stayed green. This module fixes both halves:
 *
 *   • CASE — the lookup is case-insensitive, so either vocabulary resolves.
 *   • TYPE — the map is `Record<ProfileScope, ProfileScope>`, which is TOTAL over
 *     the DB enum. Add a member to `ProfileScope` and this file stops compiling
 *     until the new scope is mapped. That is the guard the old type erased.
 *
 * The same trap was already fixed on the frontend seam — see
 * `synap-app/packages/features/onboarding/src/utils/package-to-proposal.ts`,
 * which maps the inverse direction (registry lowercase → proposal UPPERCASE)
 * against a typed, total map for exactly this reason.
 */

import { ProfileScope } from "../schema/profiles.js";

/**
 * Total map over the DB scope vocabulary, keyed by the enum's own (lowercase)
 * values. `Record<ProfileScope, ProfileScope>` is the load-bearing type: it is
 * exhaustive, so a new `ProfileScope` member breaks the build here rather than
 * silently falling through to the default at runtime.
 */
const SCOPE_BY_TOKEN: Record<ProfileScope, ProfileScope> = {
  [ProfileScope.SYSTEM]: ProfileScope.SYSTEM,
  [ProfileScope.SHARED]: ProfileScope.SHARED,
  [ProfileScope.WORKSPACE]: ProfileScope.WORKSPACE,
  [ProfileScope.USER]: ProfileScope.USER,
};

/**
 * Normalize a declared template scope token to the DB `profiles.scope` value.
 *
 * Accepts any casing (`"SHARED"`, `"shared"`, `"Shared"` all resolve). An
 * omitted or unrecognized token falls back to `workspace` — the safe, private
 * default: a wrong `workspace` scope forks one extra row, whereas a wrong
 * pod-wide scope would hand a template write access to a shared identity.
 */
export function normalizeProfileScope(scope?: string | null): ProfileScope {
  if (!scope) return ProfileScope.WORKSPACE;
  return (
    SCOPE_BY_TOKEN[scope.trim().toLowerCase() as ProfileScope] ??
    ProfileScope.WORKSPACE
  );
}
