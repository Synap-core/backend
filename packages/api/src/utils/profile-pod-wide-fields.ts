/**
 * Which `profiles.update` fields are POD-WIDE, and who is allowed to change
 * them.
 *
 * THE HOLE THIS CLOSES. `profiles.update` already gated `scope` on ownership
 * ("Only the owning workspace can change a profile's scope") but then wrote
 * `entityScope`, `aiPosture` and the three `default*Renderer` fields with no
 * gate at all. Those are not workspace-local: a profile row is shared across
 * the pod, so any member of any workspace that could merely SEE a system or
 * shared profile could flip them for EVERYONE — `entityScope` feeds
 * `getEntityScope` → `resolveWorkspacePlacement` and so decides where FUTURE
 * entities of that kind land, and `aiPosture` changes agent behaviour for that
 * kind pod-wide.
 *
 * WHERE THE LINE IS DRAWN.
 *
 * GATED — changing the value changes behaviour in every other workspace, and
 * a workspace that wants a local answer already has a local door:
 *   • `scope`        — who may see/use the profile at all (pre-existing gate).
 *   • `entityScope`  — pod-wide vs workspace placement of future entities.
 *   • `aiPosture`    — pod-wide agent behaviour; a workspace-local override
 *                      already exists at `workspaces.settings.profileAiPosture`.
 *   • `defaultListRenderer` / `defaultDetailRenderer` /
 *     `defaultDashboardRenderer` — the pod-wide DEFAULT renderer for a slot;
 *     the workspace-local override lives at
 *     `workspaces.settings.profileRenderers` and is reached through the
 *     separate, permission-checked `setProfileRendererOverride` door. Leaving
 *     the base ungated while the overlay is governed was the same asymmetry.
 *
 * NOT GATED — vocabulary/presentation metadata with no authorization or
 * placement consequence, and (unlike the above) NO workspace-local alternative,
 * so gating would remove the only door rather than redirect to a better one:
 *   • `displayName`, `uiHints`, `defaultValues`, `parentProfileId`.
 * `defaultValues` and `parentProfileId` are the weakest members of this set —
 * they do affect new entities and descendant expansion pod-wide. They are left
 * ungated deliberately (no local override exists today) and flagged here as
 * the next candidates if a per-workspace overlay is ever added for them.
 *
 * CHANGE, NOT PRESENCE. The gate fires only when a field's value actually
 * DIFFERS from the stored one — mirroring the original `scope` gate
 * (`input.scope !== existing.scope`). A client that PATCHes the whole object
 * back unchanged must not start getting 403s.
 *
 * ⚠️ SCOPE OF THIS GATE — READ BEFORE RELYING ON IT. This is a PROCEDURE-level
 * gate on `profiles.update`, NOT a repository-level invariant. `profileRepo.
 * update` remains callable without it, and three other doors still write the
 * renderer columns with no ownership check:
 *   • `services/profiles/set-profile-renderer.ts` (~:83) — reached from MCP
 *     `synap_promote_cell_to_renderer` and `hub-protocol/rest/profiles.ts`.
 *     It IS `checkPermissionOrPropose`-governed, so an AI agent gets a
 *     proposal — but a human operator in any workspace auto-applies.
 *   • `profiles.resolveDashboard` (routers/profiles.ts ~:1331)
 *   • `profiles.saveDashboard`   (routers/profiles.ts ~:1431)
 * So `defaultDashboardRenderer` in particular is still writable pod-wide by a
 * non-owner through those paths. Closing them means routing each through
 * `profileOwnershipRequirement` (or moving the check into the repository).
 * Until then, do NOT treat "these six fields require ownership" as true of the
 * system — it is true of THIS procedure only.
 *
 * Seeding and reconcile are deliberately unaffected by the same property:
 * `ensure-system-profiles.ts` and `resolve-profile-for-apply.ts` write these
 * columns through the repository, never through this procedure, so template
 * apply / boot reconcile / runConversions cannot 403.
 */

/** The pod-wide-affecting subset of `profiles.update`'s input. */
export const POD_WIDE_PROFILE_FIELDS = [
  "scope",
  "entityScope",
  "aiPosture",
  "defaultListRenderer",
  "defaultDetailRenderer",
  "defaultDashboardRenderer",
] as const;

export type PodWideProfileField = (typeof POD_WIDE_PROFILE_FIELDS)[number];

/**
 * The pod-wide fields this update actually CHANGES. A field absent from the
 * input (`undefined`) is not a change; a field present with a value equal to
 * the stored one is not a change either. Object-valued fields (`aiPosture`,
 * the renderer refs) are compared structurally, with KEY ORDER NORMALISED:
 * these values round-trip through jsonb, and Postgres stores jsonb keys in its
 * own canonical order — not the order a client sends. A plain `JSON.stringify`
 * compare is therefore key-order sensitive and would report a no-op PATCH as a
 * change, producing exactly the spurious 403 this "change, not presence" rule
 * exists to prevent.
 */
export function changedPodWideProfileFields(
  input: Partial<Record<PodWideProfileField, unknown>>,
  existing: Partial<Record<PodWideProfileField, unknown>>
): PodWideProfileField[] {
  return POD_WIDE_PROFILE_FIELDS.filter((field) => {
    const next = input[field];
    if (next === undefined) return false;
    return !sameValue(next, existing[field]);
  });
}

/** Structural equality for the small JSON-shaped values these fields hold. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // `null` (explicit clear) vs `undefined`/absent (never set) are the same
  // stored state for every nullable field here — clearing an already-clear
  // field is not a change.
  if ((a ?? null) === null && (b ?? null) === null) return true;
  if (a === null || b === null || a === undefined || b === undefined) {
    return false;
  }
  if (typeof a !== "object" || typeof b !== "object") return false;
  return stableJson(a) === stableJson(b);
}

/**
 * `JSON.stringify` with keys sorted at every level, so two structurally equal
 * records compare equal regardless of the order jsonb or a client hands them
 * back. Deliberately local: the only alternative in-tree lives in a package
 * this module does not depend on, and inlining six lines beats a new edge.
 */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val === null || typeof val !== "object" || Array.isArray(val))
      return val;
    return Object.fromEntries(
      Object.entries(val as Record<string, unknown>).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0
      )
    );
  });
}

/**
 * Who owns this profile — i.e. who is allowed to change its pod-wide fields.
 *
 * The `workspaceId`/`userId` columns ARE the ownership record (schema:
 * "Ownership (based on scope)" — `userId` set when scope is "user",
 * `workspaceId` set when scope is "workspace"):
 *
 *   • `workspaceId` set   → owned by that workspace  → the caller's ACTIVE
 *                           workspace must be it (the original `scope` rule).
 *   • `userId` set        → a user-scoped profile owned by that user → that
 *                           user may change it. The original inline `scope`
 *                           check missed this case and compared a NULL
 *                           `workspaceId` against the caller's, locking a user
 *                           out of their OWN profile; routing every pod-wide
 *                           field through here fixes that too.
 *   • neither set         → a system/shared profile owned by nobody in
 *                           particular and visible to the whole pod → require
 *                           POD ADMIN. This is the case that must not become a
 *                           blanket lockout: the fields stay changeable, but
 *                           only by the pod's administrator, not by any member
 *                           of any workspace that can see the row.
 *
 * Cosmetic fields are untouched by this in every case, so a system profile can
 * still be renamed/re-hinted by ordinary members.
 */
export type ProfileOwnershipRequirement =
  | { kind: "owning-workspace"; workspaceId: string }
  | { kind: "owning-user"; userId: string }
  | { kind: "pod-admin" };

export function profileOwnershipRequirement(existing: {
  workspaceId?: string | null;
  userId?: string | null;
}): ProfileOwnershipRequirement {
  if (existing.workspaceId) {
    return { kind: "owning-workspace", workspaceId: existing.workspaceId };
  }
  if (existing.userId) {
    return { kind: "owning-user", userId: existing.userId };
  }
  return { kind: "pod-admin" };
}
