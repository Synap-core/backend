import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../types/context.js";

/**
 * Profile SCHEMA writes are gated on the LOADED profile's owner.
 *
 * Drives the real procedures through the real gate (`assertProfileSchemaWrite`
 * → `assertWorkspaceWrite` / `assertPodAdmin`) and the real `workspaceProcedure`
 * middleware. Only the database is fake: a membership table the three
 * membership reads consult, and repositories that RECORD writes so every
 * refusal can assert the write never happened.
 *
 * The resolver is stubbed to hand back foreign profiles on purpose. The read
 * floor (`resolveProfile` by id) is tested in the database package; these
 * tests prove the WRITE gate holds on its own, including for the rows a correct
 * floor still returns (system profiles, shared profiles granted in).
 */

const WS_A = "00000000-0000-4000-8000-00000000000a";
const WS_B = "00000000-0000-4000-8000-00000000000b";
const WS_POD_ADMIN = "00000000-0000-4000-8000-0000000000ad";

const P_B = "10000000-0000-4000-8000-00000000000b"; // workspace-scoped, home WS_B
const P_SYS = "10000000-0000-4000-8000-000000000005"; // system kind
const P_SHARED = "10000000-0000-4000-8000-0000000000sh".replace("sh", "5e"); // shared, home WS_B
const DEF = "20000000-0000-4000-8000-000000000001";
const DEF_LINKED = "20000000-0000-4000-8000-000000000002";
const REL_DEF = "30000000-0000-4000-8000-000000000001";

const h = vi.hoisted(() => {
  const members: Array<{ workspaceId: string; userId: string; role: string }> =
    [];
  const writes: Array<{ op: string; args: unknown[] }> = [];
  const profiles = new Map<string, Record<string, unknown>>();
  const links: Array<{ profileId: string; propertyDefId: string }> = [];
  return { members, writes, profiles, links, db: null as unknown };
});

// Built inside the (hoisted) module factory, which is why it is a function.
async function makeFakeDb(members: typeof h.members) {
  const { PgDialect } = await import("drizzle-orm/pg-core");
  const dialect = new PgDialect();
  const findMember = (
    workspaceId: unknown,
    userId: unknown,
    roles?: unknown[]
  ) =>
    members.find(
      (m) =>
        m.workspaceId === workspaceId &&
        m.userId === userId &&
        (!roles || roles.includes(m.role))
    ) ?? undefined;

  // One fake db serves `db` (trpc middleware, assertPodAdmin) and `getDb()`
  // (routers → getWorkspaceMembership). Drizzle `where` objects are rendered to
  // their bound params; the callback form used by `getMembership` is evaluated
  // against column-name stand-ins.
  return {
    query: {
      workspaceMembers: {
        findFirst: vi.fn(async ({ where }: { where: unknown }) => {
          if (typeof where === "function") {
            const cond = where(
              { workspaceId: "workspaceId", userId: "userId" },
              {
                eq: (col: string, val: unknown) => ({ [col]: val }),
                and: (...parts: object[]) => Object.assign({}, ...parts),
              }
            ) as { workspaceId: string; userId: string };
            return findMember(cond.workspaceId, cond.userId);
          }
          const [workspaceId, userId, ...roles] = dialect.sqlToQuery(
            where as never
          ).params;
          return findMember(
            workspaceId,
            userId,
            roles.length ? roles : undefined
          );
        }),
      },
      workspaces: {
        findFirst: vi.fn(async ({ where }: { where: unknown }) => {
          const params = dialect.sqlToQuery(where as never).params;
          return params.includes("pod-admin")
            ? { id: WS_POD_ADMIN }
            : { archivedAt: null };
        }),
      },
    },
  };
}

vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn(async () => false),
}));
vi.mock("../utils/audit-log.js", () => ({ auditLog: vi.fn(async () => null) }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const fakeDb = await makeFakeDb(h.members);
  h.db = fakeDb;
  const record =
    (op: string, result: unknown = {}) =>
    async (...args: unknown[]) => {
      h.writes.push({ op, args });
      return result;
    };
  return {
    ...actual,
    db: fakeDb,
    getDb: vi.fn(async () => fakeDb),
    ProfileResolutionService: class {
      async resolveProfile(identifier: string) {
        return h.profiles.get(identifier) ?? null;
      }
      async getProfileHierarchy() {
        return [];
      }
      static invalidateEntityScopeCache() {}
      static invalidateAiPostureCache() {}
    },
    ProfileRepository: class {
      delete = record("profile.delete");
      update = record("profile.update", { id: "updated", scope: "workspace" });
      grantAccess = record("profile.grantAccess");
      revokeAccess = record("profile.revokeAccess");
      async getGrantedWorkspaces() {
        return [];
      }
    },
    ProfilePropertyRepository: class {
      link = record("property.link", { linked: true });
      unlink = record("property.unlink");
      update = record("property.update", { updated: true });
      async getByProfile(profileId: string) {
        return h.links.filter((l) => l.profileId === profileId);
      }
    },
    PropertyDefRepository: class {
      async getById(id: string) {
        return { id };
      }
    },
    ProfileRelationRepository: class {
      link = record("relation.link", { linked: true });
      unlink = record("relation.unlink");
      async getByProfile() {
        return [];
      }
    },
    RelationDefRepository: class {
      async getById(id: string) {
        return { id };
      }
    },
  };
});

import { profilesRouter } from "./profiles.js";
import { profilePropertiesRouter } from "./profile-properties.js";
import { profileRelationsRouter } from "./profile-relations.js";

function ctx(userId: string, workspaceId: string): Context {
  return { db: h.db, authenticated: true, userId, workspaceId } as Context;
}

const writesOf = (op: string) => h.writes.filter((w) => w.op === op);

beforeEach(() => {
  h.writes.length = 0;
  h.members.length = 0;
  h.members.push(
    { workspaceId: WS_A, userId: "editor-a", role: "editor" },
    { workspaceId: WS_A, userId: "viewer-a", role: "viewer" },
    { workspaceId: WS_B, userId: "editor-b", role: "editor" },
    { workspaceId: WS_B, userId: "admin-b", role: "admin" },
    { workspaceId: WS_A, userId: "pod-admin", role: "editor" },
    { workspaceId: WS_POD_ADMIN, userId: "pod-admin", role: "owner" }
  );
  h.profiles.clear();
  h.profiles.set(P_B, {
    id: P_B,
    slug: "deal",
    scope: "workspace",
    workspaceId: WS_B,
    userId: null,
  });
  h.profiles.set(P_SYS, {
    id: P_SYS,
    slug: "task",
    scope: "system",
    workspaceId: null,
    userId: null,
  });
  h.profiles.set(P_SHARED, {
    id: P_SHARED,
    slug: "lead",
    scope: "shared",
    workspaceId: WS_B,
    userId: null,
  });
  h.links.length = 0;
  h.links.push({ profileId: P_SYS, propertyDefId: DEF_LINKED });
});

describe("cross-workspace writes are refused on the row's workspace", () => {
  it("profiles.delete: a member of A cannot delete B's profile", async () => {
    await expect(
      profilesRouter.createCaller(ctx("editor-a", WS_A)).delete({ id: P_B })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(writesOf("profile.delete")).toHaveLength(0);
  });

  it("profiles.delete: an editor of B can", async () => {
    await profilesRouter
      .createCaller(ctx("editor-b", WS_B))
      .delete({ id: P_B });
    expect(writesOf("profile.delete")).toHaveLength(1);
  });

  it("profileProperties.link: a member of A cannot link onto B's profile", async () => {
    await expect(
      profilePropertiesRouter
        .createCaller(ctx("editor-a", WS_A))
        .link({ profileId: P_B, propertyDefId: DEF })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(writesOf("property.link")).toHaveLength(0);
  });

  it("profiles.update: a member of A cannot rename B's profile", async () => {
    await expect(
      profilesRouter
        .createCaller(ctx("editor-a", WS_A))
        .update({ id: P_B, displayName: "Mine now" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(writesOf("profile.update")).toHaveLength(0);
  });

  it("profileRelations.link: a member of A cannot link from B's profile", async () => {
    await expect(
      profileRelationsRouter.createCaller(ctx("editor-a", WS_A)).link({
        sourceProfileId: P_B,
        targetProfileId: P_SYS,
        relationDefId: REL_DEF,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(writesOf("relation.link")).toHaveLength(0);
  });

  it("profileProperties.unlink: an editor of B is below the owner/admin bar; an admin of B passes", async () => {
    await expect(
      profilePropertiesRouter
        .createCaller(ctx("editor-b", WS_B))
        .unlink({ profileId: P_B, propertyDefId: DEF })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(writesOf("property.unlink")).toHaveLength(0);

    await profilePropertiesRouter
      .createCaller(ctx("admin-b", WS_B))
      .unlink({ profileId: P_B, propertyDefId: DEF });
    expect(writesOf("property.unlink")).toHaveLength(1);
  });
});

describe("system kinds: optional extension stays open, everything else is pod admin", () => {
  it("an editor may link a NEW optional field onto a system kind", async () => {
    await profilePropertiesRouter
      .createCaller(ctx("editor-a", WS_A))
      .link({ profileId: P_SYS, propertyDefId: DEF });
    expect(writesOf("property.link")).toHaveLength(1);
  });

  it("an editor may NOT link a required field onto a system kind", async () => {
    await expect(
      profilePropertiesRouter
        .createCaller(ctx("editor-a", WS_A))
        .link({ profileId: P_SYS, propertyDefId: DEF, required: true })
    ).rejects.toThrow("Pod admin access required");
    expect(writesOf("property.link")).toHaveLength(0);
  });

  it("an editor may NOT set a default on a system kind's field", async () => {
    await expect(
      profilePropertiesRouter
        .createCaller(ctx("editor-a", WS_A))
        .link({ profileId: P_SYS, propertyDefId: DEF, defaultValue: "x" })
    ).rejects.toThrow("Pod admin access required");
    expect(writesOf("property.link")).toHaveLength(0);
  });

  it("re-linking an EXISTING pair is not additive (the repository upserts required/default/order)", async () => {
    await expect(
      profilePropertiesRouter
        .createCaller(ctx("editor-a", WS_A))
        .link({ profileId: P_SYS, propertyDefId: DEF_LINKED })
    ).rejects.toThrow("Pod admin access required");
    expect(writesOf("property.link")).toHaveLength(0);
  });

  it("a viewer may not extend a system kind at all", async () => {
    await expect(
      profilePropertiesRouter
        .createCaller(ctx("viewer-a", WS_A))
        .link({ profileId: P_SYS, propertyDefId: DEF })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(writesOf("property.link")).toHaveLength(0);
  });

  it("the pod admin may link a required field onto a system kind", async () => {
    await profilePropertiesRouter
      .createCaller(ctx("pod-admin", WS_A))
      .link({ profileId: P_SYS, propertyDefId: DEF, required: true });
    expect(writesOf("property.link")).toHaveLength(1);
  });

  it("profileProperties.update flipping required on a system kind is pod admin only", async () => {
    await expect(
      profilePropertiesRouter
        .createCaller(ctx("editor-a", WS_A))
        .update({ profileId: P_SYS, propertyDefId: DEF_LINKED, required: true })
    ).rejects.toThrow("Pod admin access required");
    expect(writesOf("property.update")).toHaveLength(0);

    await profilePropertiesRouter
      .createCaller(ctx("pod-admin", WS_A))
      .update({ profileId: P_SYS, propertyDefId: DEF_LINKED, required: false });
    expect(writesOf("property.update")).toHaveLength(1);
  });

  it("profiles.reorderProperties on a system kind is pod admin only", async () => {
    await expect(
      profilesRouter
        .createCaller(ctx("editor-a", WS_A))
        .reorderProperties({ profileId: P_SYS, orderedPropertyDefIds: [DEF] })
    ).rejects.toThrow("Pod admin access required");
    expect(writesOf("property.link")).toHaveLength(0);
  });
});

describe("shared profiles: grants belong to the home workspace", () => {
  it("a member of a GRANTED workspace cannot grant access onward", async () => {
    await expect(
      profilesRouter
        .createCaller(ctx("editor-a", WS_A))
        .grantAccess({ profileId: P_SHARED, targetWorkspaceId: WS_A })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(writesOf("profile.grantAccess")).toHaveLength(0);
  });

  it("an editor of the home workspace can grant and revoke", async () => {
    const caller = profilesRouter.createCaller(ctx("editor-b", WS_B));
    await caller.grantAccess({ profileId: P_SHARED, targetWorkspaceId: WS_A });
    await caller.revokeAccess({ profileId: P_SHARED, targetWorkspaceId: WS_A });
    expect(writesOf("profile.grantAccess")).toHaveLength(1);
    expect(writesOf("profile.revokeAccess")).toHaveLength(1);
  });
});
