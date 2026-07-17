/**
 * normalizeProfileScope — the ONE door that turns a template/definition's
 * declared `scope` token into the DB's `profiles.scope` vocabulary.
 *
 * Templates declare scope in MIXED case (`@synap-core/workspace-templates` ships
 * 55 × `"WORKSPACE"` and 17 × `"shared"`), so the lookup MUST be
 * case-insensitive: the UPPERCASE-keyed `Record<string, string>` copies this
 * replaces resolved `"shared"` to `undefined` and demoted all 17 pod-wide shared
 * roles to per-workspace duplicates.
 *
 * The full bug-class writeup lives in the tripwire that guards it —
 * `packages/api/src/__tripwires__/vocabulary-map-typing.test.ts`.
 */

import { ProfileScope } from "../schema/profiles.js";

/**
 * TOTAL over the DB scope vocabulary — `Record<ProfileScope, ProfileScope>` is
 * the load-bearing type: a new `ProfileScope` member breaks the build here
 * instead of falling through to the default at runtime.
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
