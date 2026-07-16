/**
 * Unit tests for the template-apply profile dedup door (resolveProfileForApply).
 * Pure logic — driven by a fake ProfileRepository, no DB. Proves:
 *   • resolve-and-share (grant an existing pod-wide profile) instead of duplicate
 *   • promote a SAME-USER workspace profile to shared (+ keep owner access)
 *   • NEVER hijack another user's private schema (cross-user → deferred, no write)
 *   • profileKind mismatch → CONFLICT, existing row never mutated, no create
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
  /** Make the promote scope-flip raise a Postgres unique_violation. */
  updateThrowsUniqueViolation?: boolean;
}) {
  const calls = { grant: [] as any[], update: [] as any[] };
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
    async grantAccess(id: string, ws: string) {
      calls.grant.push([id, ws]);
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
