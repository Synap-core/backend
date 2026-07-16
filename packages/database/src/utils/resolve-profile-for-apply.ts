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
   * A same-slug profile was found but could NOT be promoted to shared. The
   * caller creates a fresh profile at `createScope` (forced to `workspace`)
   * instead. This is the ONE branch where the dedup keystone knowingly FAILS to
   * dedup and mints a duplicate — callers MUST report it (see `deferredReason`).
   */
  promotionDeferred: boolean;
  /**
   * Why the promotion was deferred:
   *   • `cross-user`     — the match is another user's private (workspace/user)
   *                        row; promoting it would hijack their schema.
   *   • `slug-taken-pod-wide` — a soft-deleted `shared`/`system` row still holds
   *                        the `profiles_slug_system_shared_uniq` index for this
   *                        slug, so no row can be flipped to `shared`.
   */
  deferredReason: "cross-user" | "slug-taken-pod-wide" | null;
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
    promotionDeferred: false,
    deferredReason: null,
    createScope: opts.declaredScope,
  };
  /**
   * A deferred promotion means the caller CREATES — and it must create at
   * `workspace` scope, never at the declared `shared`/`system` scope: the slug's
   * pod-wide seat is exactly what we could not take.
   */
  const defer = (
    reason: "cross-user" | "slug-taken-pod-wide"
  ): ProfileApplyResolution => ({
    ...base,
    promotionDeferred: true,
    deferredReason: reason,
    createScope: "workspace",
  });
  const declaredKind = opts.declaredKind;
  const conflictWith = (existing: Profile): ProfileApplyResolution => ({
    ...base,
    conflict: {
      slug: opts.slug,
      existingKind: normalizeKind(existing.profileKind),
      declaredKind: normalizeKind(declaredKind),
    },
  });
  const kindMismatch = (existing: Profile): boolean =>
    !!declaredKind &&
    normalizeKind(existing.profileKind) !== normalizeKind(declaredKind);

  // 1. Already accessible in this workspace's lens (owned / shared+grant / system)?
  const accessible = await profileRepo.getBySlugForWorkspace(
    opts.slug,
    opts.workspaceId
  );
  if (accessible) {
    if (kindMismatch(accessible)) return conflictWith(accessible);
    if (accessible.scope === ProfileScope.SHARED && !opts.dryRun) {
      await profileRepo
        .grantAccess(accessible.id, opts.workspaceId)
        .catch(() => {});
    }
    return { ...base, profile: accessible, reused: true };
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
      await profileRepo
        .grantAccess(existing.id, opts.workspaceId)
        .catch(() => {});
    }
    return { ...base, profile: existing, reused: true };
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
    return {
      ...base,
      profile: { ...existing, scope: ProfileScope.SHARED },
      reused: true,
      promoted: true,
    };
  }

  // Cross-user or user-scoped match → NEVER hijack another user's private schema.
  // Caller creates a fresh workspace-scoped profile.
  return defer("cross-user");
}
