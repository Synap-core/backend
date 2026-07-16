/**
 * Unit tests for the template-apply profile dedup door (resolveProfileForApply).
 * Pure logic — driven by a fake ProfileRepository, no DB. Proves:
 *   • resolve-and-share (grant an existing pod-wide profile) instead of duplicate
 *   • promote a SAME-USER workspace profile to shared (+ keep owner access)
 *   • NEVER hijack another user's private schema (cross-user → deferred, no write)
 *   • profileKind mismatch → CONFLICT, existing row never mutated, no create
 *   • an OMITTED profileKind means 'kind' — absence is not consent
 *   • a load-bearing grant on a pod-wide reuse is NOT swallowed
 *   • the is_active-blind WORKSPACE slug seat is probed before any create
 *     (soft-deleted holder → revive, never a 23505 that aborts the whole apply)
 *   • deferredReason distinguishes a real `cross-user` hijack refusal from an
 *     actor-owned `not-promotable` row
 *   • dryRun computes the decision but performs no write
 */

import { describe, expect, it } from "vitest";
import { resolveProfileForApply } from "./resolve-profile-for-apply.js";
import { ProfileScope } from "../schema/profiles.js";

function mkProfile(over: Record<string, unknown>): any {
  return {
    id: "p1",
    slug: "client",
    displayName: "X",
    scope: ProfileScope.WORKSPACE,
    workspaceId: null,
    userId: null,
    profileKind: "kind",
    isActive: true,
    createdAt: new Date("2024-01-01"),
    ...over,
  };
}

function fakeRepo(opts: {
  accessible?: any;
  anyScope?: any[];
  /**
   * Rows holding the slug at pod-wide scope INCLUDING soft-deleted ones — the
   * `profiles_slug_system_shared_uniq` index has no is_active predicate, so a
   * soft-deleted shared row still blocks a promote.
   */
  podWideIncludingInactive?: any[];
  /**
   * Rows holding the slug at WORKSPACE scope in the target workspace INCLUDING
   * soft-deleted ones — `profiles_slug_workspace_uniq` is equally is_active-blind,
   * so a soft-deleted workspace row still blocks a workspace-scoped create.
   */
  workspaceScopedIncludingInactive?: any[];
  /** Make the promote scope-flip raise a Postgres unique_violation. */
  updateThrowsUniqueViolation?: boolean;
  /** Make grantAccess fail (proves a load-bearing grant is not swallowed). */
  grantThrows?: boolean;
}) {
  const calls = {
    grant: [] as any[],
    update: [] as any[],
    reactivate: [] as any[],
  };
  const repo = {
    calls,
    async getBySlugForWorkspace() {
      return opts.accessible ?? null;
    },
    async findActiveBySlugAnyScope() {
      return opts.anyScope ?? [];
    },
    async findPodWideBySlugIncludingInactive() {
      return opts.podWideIncludingInactive ?? [];
    },
    async findWorkspaceScopedBySlugIncludingInactive() {
      return opts.workspaceScopedIncludingInactive ?? [];
    },
    async reactivate(id: string) {
      calls.reactivate.push(id);
      const row = (opts.workspaceScopedIncludingInactive ?? []).find(
        (p) => p.id === id
      );
      return { ...row, isActive: true };
    },
    async grantAccess(id: string, ws: string) {
      calls.grant.push([id, ws]);
      if (opts.grantThrows) {
        throw new Error("grant failed");
      }
    },
    async update(id: string, patch: any) {
      calls.update.push([id, patch]);
      if (opts.updateThrowsUniqueViolation) {
        throw Object.assign(new Error("duplicate key value"), {
          code: "23505",
        });
      }
    },
  };
  return repo as any;
}

const baseOpts = {
  slug: "client",
  declaredScope: "workspace",
  declaredKind: "role" as const,
  workspaceId: "wsB",
  actorUserId: "u1",
};

describe("resolveProfileForApply — template dedup + guard", () => {
  it("reuses + grants an accessible shared profile (no duplicate)", async () => {
    const repo = fakeRepo({
      accessible: mkProfile({
        id: "s1",
        scope: ProfileScope.SHARED,
        profileKind: "role",
      }),
    });
    const r = await resolveProfileForApply(repo, {
      ...baseOpts,
      declaredScope: "shared",
    });
    expect(r.reused).toBe(true);
    expect(r.profile?.id).toBe("s1");
    expect(r.promoted).toBe(false);
    expect(repo.calls.grant).toContainEqual(["s1", "wsB"]);
  });

  it("shares a pod-wide shared profile even when the template declares workspace scope", async () => {
    const repo = fakeRepo({
      anyScope: [
        mkProfile({
          id: "s2",
          scope: ProfileScope.SHARED,
          profileKind: "role",
        }),
      ],
    });
    const r = await resolveProfileForApply(repo, baseOpts);
    expect(r.reused).toBe(true);
    expect(r.profile?.id).toBe("s2");
    expect(r.promoted).toBe(false);
    expect(repo.calls.update).toHaveLength(0);
    expect(repo.calls.grant).toContainEqual(["s2", "wsB"]);
  });

  it("promotes a SAME-USER workspace profile to shared and grants both workspaces", async () => {
    const repo = fakeRepo({
      anyScope: [
        mkProfile({
          id: "w3",
          scope: ProfileScope.WORKSPACE,
          workspaceId: "wsA",
          userId: "u1",
          profileKind: "role",
        }),
      ],
    });
    const r = await resolveProfileForApply(repo, baseOpts);
    expect(r.reused).toBe(true);
    expect(r.promoted).toBe(true);
    expect(r.profile?.scope).toBe(ProfileScope.SHARED);
    expect(repo.calls.update).toContainEqual([
      "w3",
      { scope: ProfileScope.SHARED },
    ]);
    expect(repo.calls.grant.map((g: any[]) => g[1])).toEqual(
      expect.arrayContaining(["wsA", "wsB"])
    );
  });

  it("NEVER hijacks another user's private workspace profile (cross-user → deferred, no write)", async () => {
    const repo = fakeRepo({
      anyScope: [
        mkProfile({
          id: "w4",
          scope: ProfileScope.WORKSPACE,
          workspaceId: "wsA",
          userId: "uX",
          profileKind: "role",
        }),
      ],
    });
    const r = await resolveProfileForApply(repo, baseOpts);
    expect(r.promotionDeferred).toBe(true);
    expect(r.profile).toBeNull();
    expect(r.reused).toBe(false);
    expect(repo.calls.update).toHaveLength(0);
    expect(repo.calls.grant).toHaveLength(0);
  });

  it("reports an ACTOR-OWNED user-scoped row as 'not-promotable', NOT 'cross-user'", async () => {
    // Fix 8 — `deferredReason` used to lie. Only WORKSPACE-scoped rows are
    // promotable, so the actor's OWN `user`-scoped row also lands in the defer
    // branch — and reporting that as `cross-user` told the operator log the actor
    // was hijacking themselves. Same outcome (create fresh), different truth.
    const repo = fakeRepo({
      anyScope: [
        mkProfile({
          id: "u9",
          scope: ProfileScope.USER,
          workspaceId: null,
          userId: "u1", // the ACTOR
          profileKind: "role",
        }),
      ],
    });
    const r = await resolveProfileForApply(repo, baseOpts);
    expect(r.promotionDeferred).toBe(true);
    expect(r.deferredReason).toBe("not-promotable");
    expect(r.deferredReason).not.toBe("cross-user");
    expect(r.createScope).toBe("workspace");
    expect(repo.calls.update).toHaveLength(0);
  });

  it("still reports ANOTHER user's row as 'cross-user' (the real hijack refusal)", async () => {
    const repo = fakeRepo({
      anyScope: [
        mkProfile({
          id: "u10",
          scope: ProfileScope.USER,
          workspaceId: null,
          userId: "uX", // NOT the actor
          profileKind: "role",
        }),
      ],
    });
    const r = await resolveProfileForApply(repo, baseOpts);
    expect(r.deferredReason).toBe("cross-user");
  });

  it("treats an OMITTED profileKind as 'kind' — absence is not consent (no reuse of a role row)", async () => {
    // Fix 6 — `kindMismatch` used to lead with `!!declaredKind &&`, so simply
    // OMITTING profileKind skipped the conflict guard entirely and reused
    // whatever row it found. That made the guard opt-out by omission: the exact
    // silent overlay it exists to prevent. `normalizeKind` already documents
    // `undefined → "kind"`, so an omitted kind vs an existing `role` row IS a
    // conflict.
    const repo = fakeRepo({
      accessible: mkProfile({
        id: "r7",
        scope: ProfileScope.SHARED,
        profileKind: "role",
      }),
    });
    const r = await resolveProfileForApply(repo, {
      ...baseOpts,
      declaredKind: undefined,
      declaredScope: "shared",
    });
    expect(r.conflict).toEqual({
      slug: "client",
      existingKind: "role",
      declaredKind: "kind",
    });
    expect(r.profile).toBeNull();
    expect(r.reused).toBe(false);
    expect(repo.calls.update).toHaveLength(0);
  });

  it("does NOT swallow the load-bearing grant on a pod-wide reuse", async () => {
    // Fix 4 — this branch is reached only because the profile is NOT accessible
    // here, and a `shared` row is reachable ONLY via profile_workspace_access. So
    // this grant IS the reuse. Swallowing it reported `reused: true` and a
    // successful provision while leaving the workspace holding a profile it
    // cannot resolve — its entities would come up schema-less.
    const repo = fakeRepo({
      anyScope: [
        mkProfile({
          id: "s8",
          scope: ProfileScope.SHARED,
          profileKind: "role",
        }),
      ],
      grantThrows: true,
    });
    await expect(resolveProfileForApply(repo, baseOpts)).rejects.toThrow(
      "grant failed"
    );
  });

  it("REVIVES a soft-deleted workspace row holding the slug seat instead of aborting the create", async () => {
    // Fix 5 — `profiles_slug_workspace_uniq ON (slug, workspace_id) WHERE
    // scope='workspace'` is as is_active-blind as its pod-wide sibling, and
    // `delete()` is a SOFT delete. The row is invisible to every active-only
    // probe yet still holds the seat, so `create()` (a plain insert) raises 23505
    // and aborts the WHOLE apply. This is the most-travelled create path.
    const dead = mkProfile({
      id: "d1",
      scope: ProfileScope.WORKSPACE,
      workspaceId: "wsB",
      userId: "u1",
      profileKind: "role",
      isActive: false,
    });
    const repo = fakeRepo({
      anyScope: [], // soft-deleted → invisible to the active-only probe
      workspaceScopedIncludingInactive: [dead],
    });
    const r = await resolveProfileForApply(repo, baseOpts);
    expect(r.profile?.id).toBe("d1");
    expect(r.profile?.isActive).toBe(true);
    expect(r.reused).toBe(true);
    expect(r.conflict).toBeNull();
    expect(repo.calls.reactivate).toEqual(["d1"]);
  });

  it("does NOT revive a seat-holder of a DIFFERENT kind — that is a CONFLICT", async () => {
    const dead = mkProfile({
      id: "d2",
      scope: ProfileScope.WORKSPACE,
      workspaceId: "wsB",
      userId: "u1",
      profileKind: "kind", // declared is 'role'
      isActive: false,
    });
    const repo = fakeRepo({
      anyScope: [],
      workspaceScopedIncludingInactive: [dead],
    });
    const r = await resolveProfileForApply(repo, baseOpts);
    expect(r.conflict).toEqual({
      slug: "client",
      existingKind: "kind",
      declaredKind: "role",
    });
    expect(r.profile).toBeNull();
    expect(repo.calls.reactivate).toHaveLength(0);
  });

  it("probes the workspace seat on the DEFER path too (every defer forces a workspace create)", async () => {
    // A deferral always hands the caller `createScope: "workspace"` — straight
    // into the same trap. Probing only the plain create path would leave the
    // most common route unguarded.
    const dead = mkProfile({
      id: "d3",
      scope: ProfileScope.WORKSPACE,
      workspaceId: "wsB",
      userId: "u1",
      profileKind: "role",
      isActive: false,
    });
    const repo = fakeRepo({
      // another user's row → would otherwise defer("cross-user") and create
      anyScope: [
        mkProfile({
          id: "wX",
          scope: ProfileScope.WORKSPACE,
          workspaceId: "wsA",
          userId: "uX",
          profileKind: "role",
        }),
      ],
      workspaceScopedIncludingInactive: [dead],
    });
    const r = await resolveProfileForApply(repo, baseOpts);
    expect(r.profile?.id).toBe("d3");
    expect(r.reused).toBe(true);
    expect(r.promotionDeferred).toBe(false);
    expect(repo.calls.reactivate).toEqual(["d3"]);
  });

  it("dryRun revives NOTHING (decision only, no write)", async () => {
    const dead = mkProfile({
      id: "d4",
      scope: ProfileScope.WORKSPACE,
      workspaceId: "wsB",
      userId: "u1",
      profileKind: "role",
      isActive: false,
    });
    const repo = fakeRepo({
      anyScope: [],
      workspaceScopedIncludingInactive: [dead],
    });
    const r = await resolveProfileForApply(repo, { ...baseOpts, dryRun: true });
    expect(r.profile?.id).toBe("d4");
    expect(r.reused).toBe(true);
    expect(repo.calls.reactivate).toHaveLength(0);
  });

  it("ignores an ACTIVE workspace row in the seat probe (it is not a revival case)", async () => {
    // The seat probe must only fire on SOFT-DELETED holders. An active row is
    // resolved by the normal candidate path, not revived.
    const alive = mkProfile({
      id: "a1",
      scope: ProfileScope.WORKSPACE,
      workspaceId: "wsB",
      userId: "u1",
      profileKind: "role",
      isActive: true,
    });
    const repo = fakeRepo({
      anyScope: [],
      workspaceScopedIncludingInactive: [alive],
    });
    const r = await resolveProfileForApply(repo, {
      ...baseOpts,
      slug: "podcast",
    });
    expect(r.profile).toBeNull();
    expect(r.conflict).toBeNull();
    expect(repo.calls.reactivate).toHaveLength(0);
  });

  it("flags a profileKind mismatch as a CONFLICT and never mutates the existing row", async () => {
    const repo = fakeRepo({
      accessible: mkProfile({
        id: "k5",
        scope: ProfileScope.SYSTEM,
        profileKind: "kind",
      }),
    });
    const r = await resolveProfileForApply(repo, {
      ...baseOpts,
      declaredScope: "shared",
    });
    expect(r.conflict).toEqual({
      slug: "client",
      existingKind: "kind",
      declaredKind: "role",
    });
    expect(r.profile).toBeNull();
    expect(r.reused).toBe(false);
    expect(repo.calls.update).toHaveLength(0);
  });

  it("returns profile null (caller creates) when nothing matches", async () => {
    const repo = fakeRepo({ anyScope: [] });
    const r = await resolveProfileForApply(repo, {
      ...baseOpts,
      slug: "podcast",
      declaredKind: "kind",
    });
    expect(r.profile).toBeNull();
    expect(r.reused).toBe(false);
    expect(r.conflict).toBeNull();
    expect(r.promotionDeferred).toBe(false);
  });

  it("prefers the ACTOR's own promotable row over another user's OLDER same-slug row", async () => {
    // Regression: rank was scope-then-oldest with no actor preference, so the
    // older cross-user row won the pick → promotionDeferred → duplicate minted,
    // even though the actor's OWN promotable row was right there.
    const repo = fakeRepo({
      anyScope: [
        mkProfile({
          id: "other-old",
          scope: ProfileScope.WORKSPACE,
          workspaceId: "wsX",
          userId: "uX",
          profileKind: "role",
          createdAt: new Date("2023-01-01"),
        }),
        mkProfile({
          id: "mine-new",
          scope: ProfileScope.WORKSPACE,
          workspaceId: "wsA",
          userId: "u1",
          profileKind: "role",
          createdAt: new Date("2025-01-01"),
        }),
      ],
    });
    const r = await resolveProfileForApply(repo, baseOpts);
    expect(r.promotionDeferred).toBe(false);
    expect(r.promoted).toBe(true);
    expect(r.reused).toBe(true);
    expect(r.profile?.id).toBe("mine-new");
    expect(repo.calls.update).toContainEqual([
      "mine-new",
      { scope: ProfileScope.SHARED },
    ]);
  });

  it("a SOFT-DELETED shared row still holds the pod-wide slug index → defer, never attempt the flip", async () => {
    // profiles_slug_system_shared_uniq is `(slug) WHERE scope IN ('system','shared')`
    // with NO is_active predicate, and delete() is a soft delete — so this row is
    // invisible to findActiveBySlugAnyScope yet still owns the seat.
    const repo = fakeRepo({
      anyScope: [
        mkProfile({
          id: "w9",
          scope: ProfileScope.WORKSPACE,
          workspaceId: "wsA",
          userId: "u1",
          profileKind: "role",
        }),
      ],
      podWideIncludingInactive: [
        mkProfile({
          id: "dead",
          scope: ProfileScope.SHARED,
          isActive: false,
          profileKind: "role",
        }),
      ],
    });
    const r = await resolveProfileForApply(repo, {
      ...baseOpts,
      declaredScope: "shared",
    });
    expect(r.promotionDeferred).toBe(true);
    expect(r.deferredReason).toBe("slug-taken-pod-wide");
    expect(r.promoted).toBe(false);
    expect(repo.calls.update).toHaveLength(0);
  });

  it("degrades a promote unique-violation to a deferral instead of aborting the whole apply", async () => {
    const repo = fakeRepo({
      anyScope: [
        mkProfile({
          id: "w10",
          scope: ProfileScope.WORKSPACE,
          workspaceId: "wsA",
          userId: "u1",
          profileKind: "role",
        }),
      ],
      updateThrowsUniqueViolation: true,
    });
    const r = await resolveProfileForApply(repo, baseOpts);
    expect(r.promotionDeferred).toBe(true);
    expect(r.deferredReason).toBe("slug-taken-pod-wide");
    expect(r.createScope).toBe("workspace");
  });

  it("a NON-unique-violation error from the promote still propagates (never silently deferred)", async () => {
    const repo = fakeRepo({
      anyScope: [
        mkProfile({
          id: "w11",
          scope: ProfileScope.WORKSPACE,
          workspaceId: "wsA",
          userId: "u1",
          profileKind: "role",
        }),
      ],
    });
    repo.update = async () => {
      throw new Error("connection reset");
    };
    await expect(resolveProfileForApply(repo, baseOpts)).rejects.toThrow(
      "connection reset"
    );
  });

  it("a DEFERRED promotion forces the caller's create to WORKSPACE scope (never the declared shared)", async () => {
    // The declared scope is `shared`, but the slug's pod-wide seat is held by
    // another user's row — creating at `shared` would hit the unique index.
    const repo = fakeRepo({
      anyScope: [
        mkProfile({
          id: "w12",
          scope: ProfileScope.WORKSPACE,
          workspaceId: "wsA",
          userId: "uX",
          profileKind: "role",
        }),
      ],
    });
    const r = await resolveProfileForApply(repo, {
      ...baseOpts,
      declaredScope: "shared",
    });
    expect(r.promotionDeferred).toBe(true);
    expect(r.deferredReason).toBe("cross-user");
    expect(r.createScope).toBe("workspace");
  });

  it("downgrades a declared SHARED create when a soft-deleted shared row still holds the slug seat", async () => {
    // Same trap as the promote branch, on the create path: no ACTIVE row exists,
    // so the dedup probe sees nothing — but a soft-deleted shared row still owns
    // the unique index, and a `shared` create would abort the whole apply.
    const repo = fakeRepo({
      anyScope: [],
      podWideIncludingInactive: [
        mkProfile({ id: "dead2", scope: ProfileScope.SHARED, isActive: false }),
      ],
    });
    const r = await resolveProfileForApply(repo, {
      ...baseOpts,
      declaredScope: "shared",
      declaredKind: "kind",
    });
    expect(r.createScope).toBe("workspace");
    expect(r.promotionDeferred).toBe(true);
    expect(r.deferredReason).toBe("slug-taken-pod-wide");
    expect(r.profile).toBeNull();
  });

  it("does NOT probe pod-wide holders for a plain workspace-scoped declare", async () => {
    // The extra probe is gated to pod-wide declares — the common path stays 1 query.
    const repo = fakeRepo({ anyScope: [] });
    let probed = false;
    repo.findPodWideBySlugIncludingInactive = async () => {
      probed = true;
      return [];
    };
    const r = await resolveProfileForApply(repo, {
      ...baseOpts,
      declaredScope: "workspace",
    });
    expect(probed).toBe(false);
    expect(r.createScope).toBe("workspace");
  });

  it("passes the DECLARED scope through as createScope when nothing matches", async () => {
    const repo = fakeRepo({ anyScope: [] });
    const r = await resolveProfileForApply(repo, {
      ...baseOpts,
      slug: "podcast",
      declaredScope: "shared",
      declaredKind: "kind",
    });
    expect(r.createScope).toBe("shared");
    expect(r.promotionDeferred).toBe(false);
  });

  it("dryRun computes a promote decision but performs no write", async () => {
    const repo = fakeRepo({
      anyScope: [
        mkProfile({
          id: "w7",
          scope: ProfileScope.WORKSPACE,
          workspaceId: "wsA",
          userId: "u1",
          profileKind: "role",
        }),
      ],
    });
    const r = await resolveProfileForApply(repo, { ...baseOpts, dryRun: true });
    expect(r.promoted).toBe(true);
    expect(repo.calls.update).toHaveLength(0);
    expect(repo.calls.grant).toHaveLength(0);
  });
});
