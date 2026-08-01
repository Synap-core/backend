/**
 * resolveProfileForApply — the ONE door that decides, for a template/definition
 * profile being applied to a workspace, whether to REUSE-AND-SHARE an existing
 * profile or CREATE a fresh one.
 *
 * This is the keystone dedup rule shared by BOTH provisioning doors
 * (`createWorkspaceFromDefinition` and `reconcileWorkspaceFromDefinition`) so
 * they can never drift. Ratified principles it encodes:
 *
 *   • Kinds are pod-wide / shared. A template that declares a slug which already
 *     exists must REUSE + share it, never mint a duplicate row.
 *   • A declared slug that matches an existing profile of a DIFFERENT
 *     `profileKind` (kind vs role) is a structural CONFLICT — never silently
 *     overlaid onto, never mutated. The caller SKIPS it and records the conflict.
 *   • The pod is MULTI-USER: promoting one user's private (workspace-scoped)
 *     profile to shared because ANOTHER user's template references the same slug
 *     would hijack their schema. Promotion is therefore restricted to the actor's
 *     OWN workspace-scoped profiles; a cross-user match is DEFERRED (the caller
 *     creates a fresh workspace-scoped profile — no hijack).
 *
 * The helper performs the grant/promote writes itself (unless `dryRun`) and
 * returns the resolved profile plus observability flags for the caller's report.
 */

import type { ProfileRepository } from "../repositories/profile-repository.js";
import { ProfileScope, type Profile } from "../schema/profiles.js";

export interface ProfileApplyResolution {
  /**
   * Existing profile to reuse (already granted / promoted as needed), or `null`
   * → the caller must CREATE the profile itself (unless `conflict` is set, in
   * which case the caller must SKIP entirely).
   */
  profile: Profile | null;
  /** An existing profile was resolved and shared into this workspace. */
  reused: boolean;
  /** An existing workspace-scoped profile was PROMOTED to shared to share it. */
  promoted: boolean;
  /**
   * The declared slug matched an existing profile of a DIFFERENT `profileKind`.
   * The caller MUST skip this profile completely — no reuse, no create, no
   * property overlay. The existing row is NEVER mutated.
   */
  conflict: { slug: string; existingKind: string; declaredKind: string } | null;
  /**
   * ADVISORY divergence (unlike the structural `conflict` above). On a REUSE,
   * the template declared a `scope`/`entityScope` that differs from the live
   * row. Placement/visibility is owned by the FIRST creator — a later template
   * must not silently flip it — but this is NOT structural like a kind mismatch,
   * so the apply still REUSES the row and merely REPORTS the divergence. The
   * live row is NEVER mutated on account of this (the promote branch's own
   * same-user scope flip is a separate, legitimate write). `declaredEntityScope`
   * is `null` when the template did not declare one (no opinion → not compared).
   */
  scopeConflict: {
    slug: string;
    existingScope: string;
    declaredScope: string;
    existingEntityScope: string;
    declaredEntityScope: "pod" | "workspace" | null;
  } | null;
  /**
   * A same-slug profile was found but could NOT be promoted to shared. The
   * caller creates a fresh profile at `createScope` (forced to `workspace`)
   * instead. This is the ONE branch where the dedup keystone knowingly FAILS to
   * dedup and mints a duplicate — callers MUST report it (see `deferredReason`).
   */
  promotionDeferred: boolean;
  /**
   * Why the promotion was deferred:
   *   • `cross-user`     — the match is ANOTHER user's private (workspace/user)
   *                        row; promoting it would hijack their schema.
   *   • `not-promotable` — the match is not eligible for promotion for a reason
   *                        that is NOT a cross-user hijack. Today that is the
   *                        actor's OWN `user`-scoped row: only `workspace`-scoped
   *                        rows can be flipped to `shared`, so an actor-owned
   *                        `user` row is un-promotable even though nobody else's
   *                        schema is at stake. Reporting this as `cross-user`
   *                        made the operator log claim the actor was hijacking
   *                        themselves.
   *   • `slug-taken-pod-wide` — a soft-deleted `shared`/`system` row still holds
   *                        the `profiles_slug_system_shared_uniq` index for this
   *                        slug, so no row can be flipped to `shared`.
   */
  deferredReason:
    "cross-user" | "not-promotable" | "slug-taken-pod-wide" | null;
  /**
   * The scope the caller MUST use if it creates the profile (i.e. when
   * `profile` and `conflict` are both null). Normally the template's declared
   * scope — but on a DEFERRED promotion it is forced to `workspace`: the whole
   * point of deferring is that the slug's pod-wide seat is unavailable, so a
   * `shared` create would hit the very unique index we just stepped around.
   */
  createScope: string;
}

/** Postgres unique_violation — the `profiles_slug_*_uniq` partial indexes. */
const isUniqueViolation = (err: unknown): boolean =>
  !!err &&
  typeof err === "object" &&
  (err as { code?: string }).code === "23505";

const normalizeKind = (k?: string | null): "kind" | "role" =>
  k === "role" ? "role" : "kind";

export async function resolveProfileForApply(
  profileRepo: ProfileRepository,
  opts: {
    slug: string;
    /**
     * Normalized lowercase declared scope: system | shared | workspace | user.
     * Returned as `createScope` for the caller's create — downgraded to
     * `workspace` when a promotion is deferred (the slug's pod-wide seat is
     * unavailable, so a `shared` create would hit the unique index).
     */
    declaredScope: string;
    /**
     * Whether the template AUTHOR explicitly declared `scope` (vs it being
     * defaulted to `workspace` by normalization). Only an explicitly-declared
     * scope that diverges is reported as a `scopeConflict` — a defaulted scope
     * carries no authorial intent and must NOT raise advisory noise on every
     * reuse of a system profile. Mirrors the `declaredEntityScope !== undefined`
     * gate for the placement axis.
     */
    declaredScopeExplicit?: boolean;
    /**
     * Declared entity visibility from the template. `undefined`/omitted means
     * the template has NO opinion on entity scope — it is then NOT compared for
     * divergence on reuse (only `scope` is). Never mutates the live row.
     */
    declaredEntityScope?: "pod" | "workspace";
    /** Declared kind from the template. `undefined`/omitted means 'kind'. */
    declaredKind?: "kind" | "role";
    workspaceId: string;
    /** The user performing the apply (owner floor for multi-user promotion safety). */
    actorUserId: string;
    dryRun?: boolean;
  }
): Promise<ProfileApplyResolution> {
  const base: ProfileApplyResolution = {
    profile: null,
    reused: false,
    promoted: false,
    conflict: null,
    scopeConflict: null,
    promotionDeferred: false,
    deferredReason: null,
    createScope: opts.declaredScope,
  };
  /**
   * A deferred promotion means the caller CREATES — and it must create at
   * `workspace` scope, never at the declared `shared`/`system` scope: the slug's
   * pod-wide seat is exactly what we could not take.
   */
  const declaredKind = opts.declaredKind;
  const conflictWith = (existing: Profile): ProfileApplyResolution => ({
    ...base,
    conflict: {
      slug: opts.slug,
      existingKind: normalizeKind(existing.profileKind),
      declaredKind: normalizeKind(declaredKind),
    },
  });

  /**
   * ADVISORY scope/entityScope divergence for a REUSE — the resolved row differs
   * from what the template declared. Reused-and-reported, never mutated. Returns
   * `null` when neither axis diverges. `entityScope` is only compared when the
   * template actually declared one (`undefined` ⇒ no opinion on that axis).
   */
  const scopeDivergence = (
    resolved: Profile
  ): ProfileApplyResolution["scopeConflict"] => {
    // `entity_scope` is NOT NULL, so this fallback is unreachable — but it must
    // not encode the pre-doctrine default. Kind ⇒ pod is the rule now.
    const existingEntityScope = resolved.entityScope ?? "pod";
    const scopeDiffers =
      opts.declaredScopeExplicit === true &&
      opts.declaredScope !== resolved.scope;
    const entityScopeDiffers =
      opts.declaredEntityScope !== undefined &&
      opts.declaredEntityScope !== existingEntityScope;
    if (!scopeDiffers && !entityScopeDiffers) return null;
    return {
      slug: opts.slug,
      existingScope: resolved.scope,
      declaredScope: opts.declaredScope,
      existingEntityScope,
      declaredEntityScope: opts.declaredEntityScope ?? null,
    };
  };

  /**
   * THE WORKSPACE-SEAT PROBE — the is_active-blind sibling of the pod-wide one.
   *
   * `profiles_slug_workspace_uniq` is `ON (slug, workspace_id) WHERE
   * scope = 'workspace'` with NO `is_active` predicate
   * (`migrations/0000_baseline_schema.sql:273-275`), and `delete()` is a SOFT
   * delete. So a soft-deleted workspace-scoped row is invisible to every active-
   * only probe in this resolver yet STILL HOLDS the seat — and `create()` is a
   * plain insert, so a workspace-scoped create for that slug raises 23505 and
   * aborts the WHOLE apply.
   *
   * Every path that ends in a workspace-scoped create must run this first: the
   * plain create-path below, AND every `defer()` (which forces
   * `createScope: "workspace"` by design). Returns:
   *   • a CONFLICT if the seat-holder is a different `profileKind` — never
   *     revive across identities;
   *   • a REUSE of the revived row if the kind matches — it is the same slug in
   *     the same workspace, i.e. the row this apply is asking for, merely
   *     soft-deleted. Reviving is the only outcome that is neither a crash nor a
   *     duplicate;
   *   • `null` if the seat is free (caller proceeds normally).
   */
  const probeWorkspaceSeat =
    async (): Promise<ProfileApplyResolution | null> => {
      const seatHolders =
        await profileRepo.findWorkspaceScopedBySlugIncludingInactive(
          opts.slug,
          opts.workspaceId
        );
      const holder = seatHolders.find((p) => !p.isActive);
      if (!holder) return null;
      if (kindMismatch(holder)) return conflictWith(holder);
      const revived = opts.dryRun
        ? { ...holder, isActive: true }
        : await profileRepo.reactivate(holder.id);
      return { ...base, profile: revived, reused: true };
    };

  const defer = async (
    reason: NonNullable<ProfileApplyResolution["deferredReason"]>
  ): Promise<ProfileApplyResolution> => {
    // A deferral ALWAYS means "the caller creates at workspace scope" — so it
    // walks straight into the workspace-seat trap above. Probe before promising
    // the caller a create that would raise 23505.
    const seat = await probeWorkspaceSeat();
    if (seat) return seat;
    return {
      ...base,
      promotionDeferred: true,
      deferredReason: reason,
      createScope: "workspace",
    };
  };
  // ABSENCE IS NOT CONSENT. The `!!declaredKind &&` short-circuit that used to
  // lead this predicate made an OMITTED `profileKind` skip the conflict check
  // entirely and reuse whatever row it found — including a `role` row for a
  // template that meant `kind`. That is precisely the silent-overlay this guard
  // exists to stop, and it was reachable by simply not declaring the field.
  // `normalizeKind` already collapses `undefined → "kind"`, which is the
  // documented default — so an omitted kind means "kind", and a mismatch
  // against a `role` row is a real conflict.
  const kindMismatch = (existing: Profile): boolean =>
    normalizeKind(existing.profileKind) !== normalizeKind(declaredKind);

  // 1. Already accessible in this workspace's lens (owned / shared+grant / system)?
  const accessible = await profileRepo.getBySlugForWorkspace(
    opts.slug,
    opts.workspaceId
  );
  if (accessible) {
    if (kindMismatch(accessible)) return conflictWith(accessible);
    if (accessible.scope === ProfileScope.SHARED && !opts.dryRun) {
      // JUSTIFIED SWALLOW (unlike the reuse branch below, which must NOT).
      // The row is ALREADY accessible from this workspace — that is what
      // `getBySlugForWorkspace` just proved — so the grant here is a redundant
      // re-affirmation, not the thing that makes the profile reachable. If it
      // fails, the workspace still resolves the profile. Un-swallowing would
      // turn a harmless no-op into an apply-aborting error with no safety gain.
      await profileRepo
        .grantAccess(accessible.id, opts.workspaceId)
        .catch(() => {});
    }
    return {
      ...base,
      profile: accessible,
      reused: true,
      scopeConflict: scopeDivergence(accessible),
    };
  }

  // 2. Not accessible here — look pod-wide for ANY existing row with this slug
  //    so we RESOLVE-AND-SHARE instead of minting a duplicate.
  const candidates = await profileRepo.findActiveBySlugAnyScope(opts.slug);
  if (candidates.length === 0) {
    // Nothing active anywhere → the caller creates. But a template that declares
    // a POD-WIDE scope hits the SAME trap as the promote branch below: the slug's
    // seat in `profiles_slug_system_shared_uniq` can still be held by a
    // SOFT-DELETED shared/system row (the index has no is_active predicate), which
    // this active-only probe cannot see. Creating at `shared` would then raise a
    // unique violation and fail the whole apply. Downgrade to a workspace-scoped
    // create and report it, rather than abort.
    if (opts.declaredScope === "shared" || opts.declaredScope === "system") {
      const holders = await profileRepo.findPodWideBySlugIncludingInactive(
        opts.slug
      );
      if (holders.length > 0) return defer("slug-taken-pod-wide");
    }
    // The pod-wide probe above has an equally is_active-blind SIBLING index:
    // `profiles_slug_workspace_uniq ON (slug, workspace_id) WHERE scope='workspace'`
    // (migrations/0000_baseline_schema.sql:273-275). A SOFT-DELETED
    // workspace-scoped row holds that seat invisibly — `findActiveBySlugAnyScope`
    // cannot see it, so we land here and create, and the insert raises 23505 and
    // aborts the ENTIRE apply. This is the most-travelled create path (every
    // deferral above forces `createScope: "workspace"` into it), so leaving it
    // unprobed made the rarest bug the loudest one.
    //
    // Reviving the row is the only outcome that is neither a crash nor a
    // duplicate: it is the SAME slug in the SAME workspace: the row this apply
    // is asking for already exists and is merely soft-deleted. Returning it as
    // `reused` lets the caller overlay properties additively, exactly as for any
    // other reuse.
    const seat = await probeWorkspaceSeat();
    if (seat) return seat;
    return base; // caller creates at the declared scope
  }

  // Prefer pod-wide (shared/system) → workspace → user. WITHIN a rank, prefer a
  // row the ACTOR owns, and only then fall back to oldest-first.
  //
  // The actor tie-break is load-bearing, not cosmetic: only an actor-owned
  // workspace row is promotable (see the promote branch below). Ranking purely
  // by age let ANOTHER user's older same-slug row win the pick, which deferred
  // the promotion and minted a duplicate — even though the actor's OWN
  // promotable row was sitting right there in `candidates`.
  const rank = (p: Profile) =>
    p.scope === ProfileScope.SHARED || p.scope === ProfileScope.SYSTEM
      ? 0
      : p.scope === ProfileScope.WORKSPACE
        ? 1
        : 2;
  const actorRank = (p: Profile) => (p.userId === opts.actorUserId ? 0 : 1);
  candidates.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      actorRank(a) - actorRank(b) ||
      a.createdAt.getTime() - b.createdAt.getTime()
  );
  const existing = candidates[0];

  // Kind-mismatch guard — never overlay onto a different identity, never mutate.
  if (kindMismatch(existing)) return conflictWith(existing);

  // Existing pod-wide (shared/system) → just grant. Fully safe, no mutation.
  if (
    existing.scope === ProfileScope.SHARED ||
    existing.scope === ProfileScope.SYSTEM
  ) {
    if (!opts.dryRun) {
      // NOT SWALLOWED — this grant is the whole reuse. We reached here because
      // step 1 proved the profile is NOT accessible from this workspace, and a
      // `shared` row is reachable ONLY through the `profile_workspace_access`
      // join. So this insert is the single thing that makes the resolved profile
      // resolvable here. Swallowing it reported `reused: true` and a successful
      // provision while leaving the workspace holding a profile it cannot see —
      // its entities would come up schema-less. Let it throw, exactly as the
      // promote branch below already does for the same reason.
      //
      // (A `system` row needs no grant, but `grantAccess` is
      // onConflictDoNothing and harmless; the failure mode we care about is the
      // `shared` one.)
      await profileRepo.grantAccess(existing.id, opts.workspaceId);
    }
    return {
      ...base,
      profile: existing,
      reused: true,
      scopeConflict: scopeDivergence(existing),
    };
  }

  // Existing workspace-scoped, owned by the SAME actor → promote to shared so the
  // slug becomes a single pod-wide kind, then grant BOTH the owner ws (so the
  // owner keeps access after the scope flip) and this ws.
  if (
    existing.scope === ProfileScope.WORKSPACE &&
    existing.workspaceId &&
    existing.userId === opts.actorUserId
  ) {
    // Can the slug's pod-wide seat actually be taken? `profiles_slug_system_shared_uniq`
    // is `(slug) WHERE scope IN ('system','shared')` with NO `is_active` predicate,
    // and `delete()` is a SOFT delete — so a soft-deleted shared row is invisible
    // to `findActiveBySlugAnyScope` above yet STILL HOLDS the index. Probe with
    // the index's exact predicate BEFORE writing: if the seat is taken by any
    // other row, the flip would raise a unique violation, so defer instead.
    const podWideHolders = await profileRepo.findPodWideBySlugIncludingInactive(
      opts.slug
    );
    if (podWideHolders.some((p) => p.id !== existing.id)) {
      return defer("slug-taken-pod-wide");
    }

    if (!opts.dryRun) {
      // ORDER IS LOAD-BEARING: a `shared` row is only reachable through the
      // `profile_workspace_access` join, so the grants MUST land before the scope
      // flip. Flipping first and then failing to grant would leave the owner
      // workspace with a profile it can no longer resolve — its entities would go
      // schema-less. `grantAccess` is onConflictDoNothing, so granting a row that
      // is still workspace-scoped is a harmless no-op. These two are NOT
      // swallowed: if the owner cannot be granted, we must not flip the scope.
      await profileRepo.grantAccess(existing.id, existing.workspaceId);
      await profileRepo.grantAccess(existing.id, opts.workspaceId);
      // The probe above closes the known race, but the seat can still be taken
      // concurrently. A unique violation here is NOT an abort: the row is simply
      // un-promotable, which is the deferral case. Degrade instead of throwing —
      // the grants already written are harmless no-ops on a workspace-scoped row
      // (it resolves by `workspace_id`, not by the access join).
      try {
        await profileRepo.update(existing.id, { scope: ProfileScope.SHARED });
      } catch (err) {
        if (isUniqueViolation(err)) return defer("slug-taken-pod-wide");
        throw err;
      }
    }
    const promotedProfile = { ...existing, scope: ProfileScope.SHARED };
    return {
      ...base,
      profile: promotedProfile,
      reused: true,
      promoted: true,
      // Advisory divergence vs the RESOLVED (post-flip) row — the same-user
      // scope flip above is legitimate; entityScope is NOT changed by it, so a
      // template declaring a different entityScope is reported-and-ignored here.
      scopeConflict: scopeDivergence(promotedProfile),
    };
  }

  // Un-promotable match → caller creates a fresh workspace-scoped profile.
  //
  // TWO DISTINCT REASONS live here, and conflating them made the operator log
  // lie. `cross-user` is a real refusal: promoting ANOTHER user's private row
  // would hijack their schema. But an ACTOR-OWNED `user`-scoped row also lands
  // here — only `workspace`-scoped rows are promotable — and reporting that as
  // `cross-user` told the operator the actor was hijacking themselves. Same
  // outcome (create fresh), different truth.
  const ownedByActor = existing.userId === opts.actorUserId;
  return defer(ownedByActor ? "not-promotable" : "cross-user");
}
