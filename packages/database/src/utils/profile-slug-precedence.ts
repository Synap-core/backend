/**
 * Profile slug precedence + the kind-twin refusal — ONE rule for "which row
 * does this slug mean", and ONE floor that stops a second row being minted
 * for a KIND's slug.
 *
 * Why both live together: a kind twin (a system/shared `knowledge` row plus a
 * workspace-scoped `knowledge` row) is only harmful because slug resolution
 * then has to PICK one, and with no workspace lens there is no non-arbitrary
 * pick among workspace rows. The precedence below makes the pod-wide row win
 * that pick; the refusal stops new twins being minted at all.
 *
 * Entity reads are row-blind (`entities.type = slug`), but schema is not:
 * `getEffectiveProperties(profileId, …)` reads by profile ID, so every write
 * that resolved onto a twin got the twin's fields, renderers and validation
 * instead of the canonical row's (SCHEMA-CONVERGENCE-PLAN.md, Defect A — 822
 * `knowledge` entities on a Pod Admin twin).
 */
import { ConflictError } from "@synap-core/core";
import { ProfileScope } from "../schema/profiles.js";

/** The fields the precedence rule reads — a full `Profile` satisfies it. */
export interface SlugPrecedenceRow {
  scope: string;
  profileKind?: string | null;
  entityScope?: string | null;
  createdAt: Date;
}

/**
 * The lens a slug is resolved under:
 *  - `workspace` — resolved INSIDE one workspace (`getBySlugForWorkspace`).
 *    That workspace's own row wins: it is the lens the caller is standing in.
 *  - `pod` — no workspace lens (`getBySlug` with no workspaceId).
 */
export type SlugLens = "workspace" | "pod";

/**
 * Rank a candidate row for a slug lookup. LOWER wins; `createdAt` ASC breaks
 * ties (see {@link compareForSlug}).
 *
 * Workspace lens: workspace > shared > system (unchanged).
 *
 * Pod lens (no workspace):
 *  - `user` first, for kinds AND roles. A user-scope row is the caller's own
 *    PERSONAL lens — the query only ever fetches the caller's own, and
 *    `profiles_slug_user_uniq` allows one per (slug, user) — so it is a
 *    deliberate, unique answer, never an arbitrary one.
 *  - KIND: system/shared beat a workspace row. Several workspaces can each
 *    hold a row for the slug and none of them is the caller's lens, so a
 *    workspace pick is arbitrary (it was "oldest twin", which routed every
 *    pod-wide `knowledge` write onto a Pod Admin twin). The pod-wide row is the
 *    only non-arbitrary answer for a pod-wide write. (system vs shared is moot:
 *    `profiles_slug_system_shared_uniq` admits one of them per slug.)
 *  - KIND, workspace rows only (no pod-wide row): the one whose `entityScope`
 *    is `pod` beats one whose `entityScope` is `workspace`. With no lens the
 *    write files pod-wide, and only a pod-entityScope kind is MEANT to hold
 *    pod-wide rows. "Oldest twin" was arbitrary here too: the live pod has a
 *    Research `finding` (2026-07, a validated fact, entityScope workspace) and
 *    a Builder `finding` (2026-10, a product problem, entityScope pod), and
 *    every pod-wide `finding` write landed on the Research kind — product gaps
 *    filed as research facts, without a severity (ticket 5c3879d4).
 *  - ROLE: workspace > shared > system, unchanged. Per-workspace roles are a
 *    legitimate model (founder decision 3, SCHEMA-CONVERGENCE-PLAN.md), not
 *    twins, so this rule does not re-rank them.
 */
export function slugPrecedenceRank(
  row: SlugPrecedenceRow,
  lens: SlugLens
): number {
  if (lens === "workspace") {
    if (row.scope === ProfileScope.WORKSPACE) return 0;
    if (row.scope === ProfileScope.SHARED) return 1;
    return 2;
  }
  if (row.scope === ProfileScope.USER) return 0;
  const isRole = row.profileKind === "role";
  if (row.scope === ProfileScope.WORKSPACE) {
    if (isRole) return 1;
    return row.entityScope === "workspace" ? 4 : 3;
  }
  if (row.scope === ProfileScope.SHARED) return 2;
  return isRole ? 3 : 2; // system
}

/** Sort comparator: precedence, then oldest first. */
export function compareForSlug(
  lens: SlugLens
): (a: SlugPrecedenceRow, b: SlugPrecedenceRow) => number {
  return (a, b) =>
    slugPrecedenceRank(a, lens) - slugPrecedenceRank(b, lens) ||
    a.createdAt.getTime() - b.createdAt.getTime();
}

// ── The kind-twin refusal ────────────────────────────────────────────────────

/** Machine code on the refusal (`error.context` / `reasonCode`). */
export const PROFILE_KIND_TWIN = "PROFILE_KIND_TWIN" as const;

/**
 * Refusal: a workspace- or user-scoped KIND row was about to be minted for a
 * slug an ACTIVE system/shared kind already holds. Names the holder so a door
 * can reuse it (grant a shared holder to its workspace) instead of failing.
 */
export class ProfileKindTwinError extends ConflictError {
  readonly reasonCode = PROFILE_KIND_TWIN;
  constructor(
    public readonly slug: string,
    public readonly holder: { id: string; scope: string }
  ) {
    super(
      `The kind '${slug}' already exists pod-wide (${holder.scope} profile ${holder.id}). ` +
        `A kind is one row per slug — use the existing kind (add workspace-specific ` +
        `fields as an overlay) instead of creating a second '${slug}'.`,
      { slug, holderId: holder.id, holderScope: holder.scope }
    );
    this.name = "ProfileKindTwinError";
  }
}

export function isProfileKindTwinError(
  err: unknown
): err is ProfileKindTwinError {
  return (
    !!err &&
    typeof err === "object" &&
    (err as { reasonCode?: unknown }).reasonCode === PROFILE_KIND_TWIN
  );
}

/**
 * Does creating this row mint a kind twin? Only a workspace- or user-scoped
 * KIND can: a system/shared create competes for `profiles_slug_system_shared_uniq`
 * instead, and seeding a pod-wide row over historical workspace twins is the
 * convergence direction (the manifest's dedupe ops then drain them). Roles are
 * exempt — per-workspace roles are legitimate.
 */
export function createCanMintKindTwin(input: {
  scope?: string | null;
  profileKind?: string | null;
}): boolean {
  const scope = input.scope || ProfileScope.WORKSPACE;
  const kind = input.profileKind ?? "kind";
  return (
    kind === "kind" &&
    (scope === ProfileScope.WORKSPACE || scope === ProfileScope.USER)
  );
}
