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
}));

vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn(async () => false),
}));

vi.mock("../utils/permission-check.js", () => ({
  // Auto-approved: no `denied`, no `proposalId` → materialize inline.
  checkPermissionOrPropose: vi.fn(async () => ({})),
}));

vi.mock("../utils/audit-log.js", () => ({
  auditLog: vi.fn(async () => ({ id: "audit-1" })),
}));

vi.mock("@synap/database", async () => {
  const drizzle =
    await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");

  class ProfileRepository {
    async getBySlug() {
      return null; // no slug conflict
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
    async grantAccess() {}
  }
  class ProfilePropertyRepository {}
  class ProfileResolutionService {
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
});
