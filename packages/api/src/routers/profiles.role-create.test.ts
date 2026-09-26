/**
 * Profiles Router — role (facet type) creation
 *
 * Proves the tRPC `profiles.create` door now threads Kind + Facets role-ness:
 *   - a role profile is created with profileKind='role' + applicableKinds
 *   - omitting profileKind still yields a plain 'kind' (behavior-preserving)
 *   - a role WITHOUT applicableKinds is rejected (a facet that could never attach)
 *
 * The repo/DB layer is stubbed — the assertion is on what the router forwards to
 * ProfileRepository.create (the threading) and on the validation guard.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const h = vi.hoisted(() => ({
  createCalls: [] as Array<Record<string, unknown>>,
  /** What the POD-WIDE slug probe finds — the twin-slug suite sets this. */
  slugElsewhere: [] as Array<Record<string, unknown>>,
  /** W2b role share: grants + updates the resolver writes through the repo. */
  grants: [] as Array<[string, string]>,
  updates: [] as Array<[string, Record<string, unknown>]>,
}));

vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn(async () => false),
}));

// FALLBACK, deliberately NOT `importOriginal`: loading the real
// `permission-check.js` here transitively pulls `@synap/jobs`
// (automation-run-reaper -> post-run-summary), which reads `isNull` off this
// file's intentional `@synap/database` class-stub and dies with
// `No "isNull" export is defined on the "@synap/database" mock`. So the export
// list is named by hand. `proposedMessageFor` is stubbed to IDENTITY, which
// matches the real function on every non-join-gate path; do NOT assert
// join-gate prose through this mock — it would assert the stub, not the source.
vi.mock("../utils/permission-check.js", () => ({
  // Auto-approved: no `denied`, no `proposalId` → materialize inline.
  checkPermissionOrPropose: vi.fn(async () => ({})),
  proposedMessageFor: (_type: unknown, message: string) => message,
}));

vi.mock("../utils/audit-log.js", () => ({
  auditLog: vi.fn(async () => ({ id: "audit-1" })),
}));

vi.mock("@synap/database", async () => {
  const drizzle =
    await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  // The REAL reservation, not a stub: the router refuses reserved profile
  // slugs before governance, and a stubbed second implementation here would
  // let the two drift.
  const reserved = await vi.importActual<
    typeof import("../../../database/src/utils/reserved-profile-slugs.js")
  >("../../../database/src/utils/reserved-profile-slugs.js");
  // The REAL share/reuse resolver (W2b) — driven against the stub repo below.
  const resolver = await vi.importActual<
    typeof import("../../../database/src/utils/resolve-profile-for-apply.js")
  >("../../../database/src/utils/resolve-profile-for-apply.js");

  class ProfileRepository {
    async getBySlug() {
      // Nothing visible from the CALLING workspace — which is also the blind
      // spot the twin-slug suite below exercises: a profile with this slug
      // owned by ANOTHER workspace is invisible to this lookup.
      return null;
    }
    async findActiveBySlugAnyScope() {
      return h.slugElsewhere;
    }
    async getById() {
      return null;
    }
    async create(input: Record<string, unknown>) {
      h.createCalls.push(input);
      return {
        id: "profile-1",
        slug: input.slug,
        displayName: input.displayName,
        profileKind: input.profileKind ?? "kind",
      };
    }
    async grantAccess(profileId: string, workspaceId: string) {
      h.grants.push([profileId, workspaceId]);
    }
    async getBySlugForWorkspace() {
      return null;
    }
    async findPodWideBySlugIncludingInactive() {
      return [];
    }
    async findWorkspaceScopedBySlugIncludingInactive() {
      return [];
    }
    async update(id: string, patch: Record<string, unknown>) {
      h.updates.push([id, patch]);
      const row = h.slugElsewhere.find((p) => p.id === id) ?? { id };
      return { ...row, ...patch };
    }
  }
  class ProfilePropertyRepository {}
  class ProfileResolutionService {
    static invalidateEntityScopeCache() {}
    async getProfileHierarchy() {
      return [];
    }
  }
  class ViewRepository {
    async create() {
      return { id: "view-1" };
    }
  }
  class WorkspaceRepository {
    async mergeSettings() {}
  }

  return {
    eq: drizzle.eq,
    and: drizzle.and,
    inArray: drizzle.inArray,
    reservedProfileSlugReason: reserved.reservedProfileSlugReason,
    resolveProfileForApply: resolver.resolveProfileForApply,
    // The AMBIENT acting-agent read (AsyncLocalStorage, set at every key-auth
    // entry point). These tests drive the router directly, outside any request
    // scope, so the real function would return undefined here too — the stub
    // matches that, and the AI signal under test comes from `agentUserId` /
    // `source` on the input, which is what each case varies.
    getActingAgentUserId: () => undefined,
    getDb: vi.fn(async () => ({})),
    db: {
      query: {
        syncGeneration: {
          findFirst: vi.fn(async () => ({
            role: "primary",
            splitBrainDetected: false,
          })),
        },
        workspaceMembers: {
          findFirst: vi.fn(async () => ({ role: "owner" })),
        },
        workspaces: {
          findFirst: vi.fn(async () => ({ archivedAt: null, settings: {} })),
        },
      },
    },
    ProfileRepository,
    ProfilePropertyRepository,
    ProfileResolutionService,
    ViewRepository,
    WorkspaceRepository,
    eventRepository: {},
    ProfileScope: {
      SYSTEM: "system",
      SHARED: "shared",
      WORKSPACE: "workspace",
      USER: "user",
    },
    workspaces: { id: "id" },
  };
});

vi.mock("@synap/database/schema", () => ({
  workspaceMembers: { workspaceId: "workspaceId", userId: "userId" },
  workspaces: { id: "id" },
}));

import { profilesRouter } from "./profiles.js";
import { createContext } from "../context.js";
import { checkPermissionOrPropose } from "../utils/permission-check.js";

async function callerCtx() {
  const ctx = await createContext(new Request("http://localhost:3000"));
  ctx.authenticated = true;
  ctx.userId = "user-1";
  ctx.workspaceId = "ws-1";
  return ctx;
}

describe("profiles.create — role (facet type) minting", () => {
  beforeEach(() => {
    h.createCalls.length = 0;
  });

  it("creates a role profile with profileKind='role' + applicableKinds", async () => {
    const caller = profilesRouter.createCaller(await callerCtx());

    const result = await caller.create({
      slug: "market-maker",
      displayName: "Market Maker",
      scope: "user",
      profileKind: "role",
      applicableKinds: ["company", "person"],
    });

    expect(h.createCalls).toHaveLength(1);
    expect(h.createCalls[0]).toMatchObject({
      slug: "market-maker",
      profileKind: "role",
      applicableKinds: ["company", "person"],
    });
    expect((result.profile as { profileKind: string }).profileKind).toBe(
      "role"
    );
  });

  it("still yields a plain 'kind' when profileKind is omitted", async () => {
    const caller = profilesRouter.createCaller(await callerCtx());

    await caller.create({
      slug: "podcast",
      displayName: "Podcast",
      scope: "user",
    });

    expect(h.createCalls).toHaveLength(1);
    // profileKind/applicableKinds are NOT forwarded → DB default ('kind') applies.
    expect(h.createCalls[0].profileKind).toBeUndefined();
    expect(h.createCalls[0].applicableKinds).toBeUndefined();
  });

  it("rejects a role with empty applicableKinds", async () => {
    const caller = profilesRouter.createCaller(await callerCtx());

    await expect(
      caller.create({
        slug: "orphan-role",
        displayName: "Orphan Role",
        scope: "user",
        profileKind: "role",
        applicableKinds: [],
      })
    ).rejects.toThrow(TRPCError);

    expect(h.createCalls).toHaveLength(0);
  });

  it("preserves role semantics when profile creation becomes a proposal", async () => {
    vi.mocked(checkPermissionOrPropose).mockResolvedValueOnce({
      proposalId: "proposal-1",
    } as never);
    const caller = profilesRouter.createCaller(await callerCtx());

    const result = await caller.create({
      slug: "advisor",
      displayName: "Advisor",
      scope: "workspace",
      entityScope: "workspace",
      profileKind: "role",
      applicableKinds: ["person"],
    });

    expect(result).toMatchObject({
      status: "proposed",
      proposalId: "proposal-1",
    });
    expect(checkPermissionOrPropose).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          profileKind: "role",
          applicableKinds: ["person"],
          entityScope: "workspace",
        }),
      })
    );
    expect(h.createCalls).toHaveLength(0);
  });
});

/**
 * A kind may not be minted by an AGENT when the slug already exists elsewhere
 * on the pod.
 *
 * MEASURED DEFECT (live, 2026-09-21). `profiles.create` checks
 * `getBySlug(slug, ctx.workspaceId)`, which only sees profiles VISIBLE FROM
 * THE CALLING WORKSPACE. A profile with the same slug owned by a DIFFERENT
 * workspace is invisible there, so the create proceeds and the pod ends up
 * with two profiles carrying one slug.
 *
 * That is how this pod acquired two `finding` kinds — Research (2026-07-22,
 * "a validated fact") and Builder (2026-09-20, a defect report). Different
 * concepts, one slug. Resolution then depends on the lens, and 44 rows split
 * across two schemas.
 *
 * WHY REFUSE AND NOT SILENTLY REUSE: they are genuinely different concepts.
 * Returning the Research profile would file defect reports against a research
 * kind — worse than either alternative.
 *
 * WHAT THIS DOES NOT COVER, measured: the repository is stubbed, so this
 * proves the DOOR's control flow (probe consulted, refusal raised, escape
 * honoured), not that `findActiveBySlugAnyScope` returns the right rows —
 * that is its own contract and it is the pre-existing probe the template-apply
 * resolver already relies on.
 */

const AGENT = "44444444-4444-4444-8444-444444444444";
const TWIN = {
  id: "bc633e0d-32ae-4431-be9f-0363517c3f01",
  displayName: "Finding",
  slug: "finding",
  scope: "workspace",
  workspaceId: "86a87213-9df5-445f-b2fa-3675b15ff4c5",
};

function caller() {
  return profilesRouter.createCaller({
    authenticated: true,
    userId: "user-1",
    workspaceId: "808939d1-86b3-4c52-a153-ae06ece2c54e",
  } as never);
}

const base = {
  slug: "finding",
  displayName: "Finding",
  agentUserId: AGENT,
};

/** This suite owns `h.slugElsewhere`; the host suite leaves it empty. */
beforeEach(() => {
  h.createCalls.length = 0;
  h.slugElsewhere = [];
  h.grants.length = 0;
  h.updates.length = 0;
});

describe("profiles.create refuses a cross-workspace twin slug", () => {
  it("NON-VACUITY: with no twin on the pod, the SAME create succeeds", () => {
    // Without this, a create failing for any unrelated reason would satisfy
    // every rejection assertion below while proving nothing.
    return expect(caller().create({ ...base } as never)).resolves.toBeTruthy();
  });

  it("THE LIVE CASE: a twin owned by ANOTHER workspace is refused, naming it", async () => {
    h.slugElsewhere = [TWIN];
    await expect(caller().create({ ...base } as never)).rejects.toThrow(
      /already exists on this pod/
    );
    expect(h.createCalls, "a twin profile was minted anyway").toHaveLength(0);
  });

  it("the refusal names the existing profile so the agent can act on it", async () => {
    h.slugElsewhere = [TWIN];
    const err = await caller()
      .create({ ...base } as never)
      .catch((e: TRPCError) => e);
    expect((err as TRPCError).message).toContain(TWIN.id);
    expect((err as TRPCError).message).toContain("forceCreate");
  });

  it("forceCreate escapes it — a separate concept sharing a name is allowed", async () => {
    h.slugElsewhere = [TWIN];
    await expect(
      caller().create({ ...base, forceCreate: true } as never)
    ).resolves.toBeTruthy();
    expect(h.createCalls).toHaveLength(1);
  });

  it("a HUMAN caller is never second-guessed", async () => {
    // Two workspaces each owning their own `deal` or `report` is normal
    // multi-tenancy; only the AI branch runs the probe.
    h.slugElsewhere = [TWIN];
    await expect(
      caller().create({ slug: "finding", displayName: "Finding" } as never)
    ).resolves.toBeTruthy();
  });
});

/**
 * W2b ROLE PRINCIPLE — one role per name, pod-wide; never a twin. A ROLE whose
 * slug already exists elsewhere is REUSED + SHARED into the calling workspace
 * (the same `resolveProfileForApply` decision template apply makes), for every
 * caller, `forceCreate` included. Drives the REAL resolver against the stub repo.
 */
const CALLER_WS = "808939d1-86b3-4c52-a153-ae06ece2c54e";
const CRM_WS = "f73f40f0-c023-4f2e-b55a-10d3f7539b1f";
const sharedPartner = {
  id: "7c7679aa-0000-4000-8000-000000000001",
  slug: "partner",
  displayName: "Partner",
  scope: "shared",
  profileKind: "role",
  applicableKinds: ["company"],
  workspaceId: CRM_WS,
  userId: "someone-else",
  isActive: true,
  uiHints: {},
  createdAt: new Date("2026-08-01"),
};
const roleCall = {
  slug: "partner",
  displayName: "Partner",
  profileKind: "role" as const,
  applicableKinds: ["company", "person"],
};

describe("profiles.create — a role slug that exists elsewhere is SHARED, never twinned (W2b)", () => {
  it("an AGENT with forceCreate reuses the shared role: grant + widen, no second row", async () => {
    h.slugElsewhere = [sharedPartner];
    const result = (await caller().create({
      ...roleCall,
      agentUserId: AGENT,
      forceCreate: true,
    } as never)) as Record<string, unknown>;
    expect(h.createCalls, "a twin role was minted").toHaveLength(0);
    expect(h.grants).toContainEqual([sharedPartner.id, CALLER_WS]);
    expect(h.updates).toContainEqual([
      sharedPartner.id,
      { applicableKinds: ["company", "person"] },
    ]);
    expect(result).toMatchObject({
      existing: true,
      shared: true,
      widened: true,
    });
  });

  it("a HUMAN re-declaring their own workspace-private role PROMOTES it to shared (both lenses granted)", async () => {
    h.slugElsewhere = [
      { ...sharedPartner, scope: "workspace", userId: "user-1" },
    ];
    const result = (await caller().create({
      ...roleCall,
    } as never)) as Record<string, unknown>;
    expect(h.createCalls).toHaveLength(0);
    expect(h.grants).toEqual(
      expect.arrayContaining([
        [sharedPartner.id, CRM_WS],
        [sharedPartner.id, CALLER_WS],
      ])
    );
    expect(h.updates).toContainEqual([sharedPartner.id, { scope: "shared" }]);
    expect(result).toMatchObject({ shared: true, promoted: true });
  });

  it("a KIND already holding the slug refuses the role (forceCreate included) — never a twin name", async () => {
    h.slugElsewhere = [{ ...sharedPartner, profileKind: "kind" }];
    await expect(
      caller().create({ ...roleCall, forceCreate: true } as never)
    ).rejects.toThrow(/cannot be created/);
    expect(h.createCalls).toHaveLength(0);
  });

  it("governed: a proposed share writes NOTHING until approval", async () => {
    h.slugElsewhere = [sharedPartner];
    vi.mocked(checkPermissionOrPropose).mockResolvedValueOnce({
      proposalId: "proposal-share",
    } as never);
    const result = await caller().create({
      ...roleCall,
      agentUserId: AGENT,
    } as never);
    expect(result).toMatchObject({ status: "proposed", shared: true });
    expect(h.grants).toHaveLength(0);
    expect(h.updates).toHaveLength(0);
    expect(h.createCalls).toHaveLength(0);
  });

  it("NON-VACUITY: a role slug found nowhere is still created", async () => {
    await caller().create({ ...roleCall, slug: "brand-new-role" } as never);
    expect(h.createCalls).toHaveLength(1);
  });
});
