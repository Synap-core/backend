/**
 * Slug-idempotent DESCRIBE — `profiles.create` on an EXISTING slug (the door
 * `synap_define_role` / `synap_define_kind` / Hub `POST /profiles` all ride)
 * honours a CHANGED name / description / icon / default values as a GOVERNED
 * update, instead of silently ignoring them (observed 2026-09-28: the
 * grp-interrogation role kept "Growth Research Positioning" with no agent door
 * to fix it).
 *
 * Drives the real router; governance and the repo are stubbed, so the
 * assertions are on WHAT reaches the gate and the repo. The approve replay is
 * the same door re-entered as the approver (no agentUserId) — the
 * `profile/create` executor — modelled here as the auto-approved branch.
 * The summary the reviewer reads is pinned in `profile-descriptive-update.test.ts`.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  createCalls: [] as Array<Record<string, unknown>>,
  /** What the POD-WIDE slug probe finds — the twin-slug suite sets this. */
  slugElsewhere: [] as Array<Record<string, unknown>>,
  /** W2b role share: grants + updates the resolver writes through the repo. */
  grants: [] as Array<[string, string]>,
  updates: [] as Array<[string, Record<string, unknown>]>,
  /** The profile `getBySlug` finds — the slug-idempotent branch under test. */
  existing: null as null | Record<string, unknown>,
  schemaWriteChecks: 0,
}));

vi.mock("../utils/profile-schema-write-access.js", () => ({
  assertProfileSchemaWrite: vi.fn(async () => {
    h.schemaWriteChecks += 1;
  }),
}));

// The caller is a participant. Guest containment probes the caller's audience
// for every served mutation; it has its own tests
// (access/guest-containment.pglite.test.ts), so the probe answers "member" here.
vi.mock("../access/context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../access/context.js")>();
  actual.AccessContext.prototype.audience = async () => "member";
  return actual;
});
vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn(async () => false),
}));

// PARTIAL (importOriginal): only the gate is replaced, so the router's other
// imports from this module stay real — a total mock is ratcheted
// (`database-mock-total-ratchet`, `total-mock-missing-export-ratchet`).
vi.mock("../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/permission-check.js")>()),
  // Auto-approved: no `denied`, no `proposalId` → materialize inline.
  checkPermissionOrPropose: vi.fn(async () => ({})),
}));

vi.mock("../utils/audit-log.js", () => ({
  auditLog: vi.fn(async () => ({ id: "audit-1" })),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
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
      if (h.existing) return h.existing;
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
      const row = h.slugElsewhere.find((p) => p.id === id) ??
        h.existing ?? { id };
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
    ...actual,
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

vi.mock("@synap/database/schema", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database/schema")>()),
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

const ROLE = {
  id: "role-1",
  slug: "grp-interrogation",
  displayName: "GRP interrogation",
  profileKind: "role",
  applicableKinds: ["question"],
  scope: "workspace",
  workspaceId: "ws-1",
  userId: "user-1",
  uiHints: { icon: "help", description: "Growth Research Positioning" },
  defaultValues: { grp_domain: "Growth", other: "kept" },
};
const NEW_DESC = "GRP = Génération · Rémunération · Partage";

describe("profiles.create on an EXISTING slug — descriptive fields", () => {
  beforeEach(() => {
    h.createCalls.length = 0;
    h.updates.length = 0;
    h.schemaWriteChecks = 0;
    h.existing = { ...ROLE };
    vi.mocked(checkPermissionOrPropose).mockClear();
  });

  it("an AGENT's changed description + defaults file ONE governed update proposal", async () => {
    vi.mocked(checkPermissionOrPropose).mockResolvedValueOnce({
      proposalId: "proposal-1",
    } as never);
    const caller = profilesRouter.createCaller(await callerCtx());
    const result = (await caller.create({
      slug: "grp-interrogation",
      displayName: "GRP interrogation",
      profileKind: "role",
      uiHints: { description: NEW_DESC },
      defaultValues: { grp_domain: "Génération" },
      agentUserId: "00000000-0000-4000-8000-000000000001",
    })) as Record<string, unknown>;

    expect(result.status).toBe("proposed");
    expect(result.changedFields).toEqual(["description", "defaultValues"]);
    expect(h.updates).toHaveLength(0);
    expect(h.createCalls).toHaveLength(0);
    expect(h.schemaWriteChecks).toBe(1);
    const gate = vi.mocked(checkPermissionOrPropose).mock.calls[0]![0] as {
      subjectType: string;
      action: string;
      data: Record<string, unknown>;
    };
    expect(gate.subjectType).toBe("profile");
    expect(gate.action).toBe("create");
    expect(gate.data).toMatchObject({
      id: "role-1",
      slug: "grp-interrogation",
      updateExistingProfile: true,
      changedFields: ["description", "defaultValues"],
      uiHints: { icon: "help", description: NEW_DESC },
      defaultValues: { grp_domain: "Génération" },
    });
  });

  it("the approver's replay writes the MERGED patch (no key dropped)", async () => {
    const caller = profilesRouter.createCaller(await callerCtx());
    await caller.create({
      slug: "grp-interrogation",
      displayName: "GRP interrogation",
      profileKind: "role",
      uiHints: { icon: "help", description: NEW_DESC },
      defaultValues: { grp_domain: "Génération" },
    });
    expect(h.updates).toEqual([
      [
        "role-1",
        {
          uiHints: { icon: "help", description: NEW_DESC },
          defaultValues: { grp_domain: "Génération", other: "kept" },
        },
      ],
    ]);
  });

  it("a re-declare that changes nothing files nothing and writes nothing", async () => {
    const caller = profilesRouter.createCaller(await callerCtx());
    const result = (await caller.create({
      slug: "grp-interrogation",
      displayName: "GRP interrogation",
      profileKind: "role",
      uiHints: { description: "Growth Research Positioning" },
      defaultValues: { grp_domain: "Growth" },
    })) as Record<string, unknown>;
    expect(result).toMatchObject({ existing: true });
    expect(result.status).toBeUndefined();
    expect(checkPermissionOrPropose).not.toHaveBeenCalled();
    expect(h.updates).toHaveLength(0);
  });

  it("a widen and a description change ride ONE gated write", async () => {
    const caller = profilesRouter.createCaller(await callerCtx());
    await caller.create({
      slug: "grp-interrogation",
      displayName: "GRP interrogation",
      profileKind: "role",
      applicableKinds: ["decision"],
      uiHints: { description: NEW_DESC },
    });
    expect(checkPermissionOrPropose).toHaveBeenCalledTimes(1);
    expect(h.updates).toEqual([
      [
        "role-1",
        {
          applicableKinds: ["question", "decision"],
          uiHints: { icon: "help", description: NEW_DESC },
        },
      ],
    ]);
  });
});
