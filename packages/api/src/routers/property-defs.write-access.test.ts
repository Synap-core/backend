import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../types/context.js";

/**
 * Property-def writes are gated on ownership of the LOADED row.
 *
 *   • create with a profileId → the target PROFILE's owner decides
 *     (`assertProfileSchemaWrite`, additive): never a def minted for a profile
 *     the caller cannot write.
 *   • update → the DEF's owner: an overlay def's workspace; a base def's
 *     profile owner (a system kind ⇒ pod admin); a global def ⇒ pod admin.
 *     Constraints / enum / valueType apply to every entity of every profile
 *     that links the def, so a member of any workspace must not edit them.
 *
 * Same seam as profile-schema-write-access.test.ts: real procedures, real
 * middleware, real gates; the database is a fake membership table plus
 * repositories that record writes.
 */

const WS_A = "00000000-0000-4000-8000-00000000000a";
const WS_B = "00000000-0000-4000-8000-00000000000b";
const WS_POD_ADMIN = "00000000-0000-4000-8000-0000000000ad";
const P_B = "10000000-0000-4000-8000-00000000000b";
const P_SYS = "10000000-0000-4000-8000-000000000005";
const DEF_SYS = "20000000-0000-4000-8000-000000000005"; // base def, no workspace
const DEF_OVERLAY_B = "20000000-0000-4000-8000-00000000000b"; // overlay owned by WS_B
const DEF_BASE_ON_B = "20000000-0000-4000-8000-0000000000bb"; // base def on B's profile
const DEF_GLOBAL = "20000000-0000-4000-8000-000000000009"; // no profile, no workspace

const h = vi.hoisted(() => ({
  members: [] as Array<{ workspaceId: string; userId: string; role: string }>,
  writes: [] as string[],
  profiles: new Map<string, Record<string, unknown>>(),
  defs: new Map<string, Record<string, unknown>>(),
  db: null as unknown,
}));

async function makeFakeDb(members: typeof h.members) {
  const { PgDialect } = await import("drizzle-orm/pg-core");
  const dialect = new PgDialect();
  const findMember = (ws: unknown, user: unknown, roles?: unknown[]) =>
    members.find(
      (m) =>
        m.workspaceId === ws &&
        m.userId === user &&
        (!roles || roles.includes(m.role))
    ) ?? undefined;
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
          const [ws, user, ...roles] = dialect.sqlToQuery(
            where as never
          ).params;
          return findMember(ws, user, roles.length ? roles : undefined);
        }),
      },
      workspaces: {
        findFirst: vi.fn(async ({ where }: { where: unknown }) =>
          dialect.sqlToQuery(where as never).params.includes("pod-admin")
            ? { id: WS_POD_ADMIN }
            : { archivedAt: null }
        ),
      },
    },
  };
}

vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn(async () => false),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const fakeDb = await makeFakeDb(h.members);
  h.db = fakeDb;
  return {
    ...actual,
    db: fakeDb,
    getDb: vi.fn(async () => fakeDb),
    ProfileResolutionService: class {
      async resolveProfile(identifier: string) {
        return h.profiles.get(identifier) ?? null;
      }
    },
    ProfileRepository: class {
      async getById(id: string) {
        return h.profiles.get(id) ?? null;
      }
    },
    PropertyDefRepository: class {
      async getById(id: string) {
        return h.defs.get(id) ?? null;
      }
      async getBySlug() {
        return null;
      }
      async create(input: Record<string, unknown>) {
        h.writes.push("create");
        return { id: "new-def", ...input };
      }
      async update(id: string) {
        h.writes.push("update");
        return { id };
      }
    },
  };
});

import { propertyDefsRouter } from "./property-defs.js";

const ctx = (userId: string, workspaceId: string) =>
  ({ db: h.db, authenticated: true, userId, workspaceId }) as Context;

beforeEach(() => {
  h.writes.length = 0;
  h.members.length = 0;
  h.members.push(
    { workspaceId: WS_A, userId: "editor-a", role: "editor" },
    { workspaceId: WS_A, userId: "viewer-a", role: "viewer" },
    { workspaceId: WS_B, userId: "editor-b", role: "editor" },
    { workspaceId: WS_A, userId: "pod-admin", role: "editor" },
    { workspaceId: WS_POD_ADMIN, userId: "pod-admin", role: "owner" }
  );
  h.profiles.clear();
  h.profiles.set(P_B, {
    id: P_B,
    scope: "workspace",
    workspaceId: WS_B,
    userId: null,
  });
  h.profiles.set(P_SYS, {
    id: P_SYS,
    scope: "system",
    workspaceId: null,
    userId: null,
  });
  h.defs.clear();
  h.defs.set(DEF_SYS, {
    id: DEF_SYS,
    slug: "status",
    profileId: P_SYS,
    workspaceId: null,
  });
  h.defs.set(DEF_OVERLAY_B, {
    id: DEF_OVERLAY_B,
    slug: "stage",
    profileId: P_SYS,
    workspaceId: WS_B,
  });
  h.defs.set(DEF_BASE_ON_B, {
    id: DEF_BASE_ON_B,
    slug: "budget",
    profileId: P_B,
    workspaceId: null,
  });
  h.defs.set(DEF_GLOBAL, {
    id: DEF_GLOBAL,
    slug: "notes",
    profileId: null,
    workspaceId: null,
  });
});

describe("propertyDefs.create is gated on the target profile's owner", () => {
  it("a member of A cannot mint a def for B's profile", async () => {
    await expect(
      propertyDefsRouter
        .createCaller(ctx("editor-a", WS_A))
        .create({ slug: "budget", valueType: "number", profileId: P_B })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.writes).toEqual([]);
  });

  it("an editor of B can", async () => {
    await propertyDefsRouter
      .createCaller(ctx("editor-b", WS_B))
      .create({ slug: "budget", valueType: "number", profileId: P_B });
    expect(h.writes).toEqual(["create"]);
  });

  it("an editor may add a def to a system kind; a viewer may not", async () => {
    await propertyDefsRouter
      .createCaller(ctx("editor-a", WS_A))
      .create({ slug: "mood", valueType: "string", profileId: P_SYS });
    expect(h.writes).toEqual(["create"]);

    await expect(
      propertyDefsRouter
        .createCaller(ctx("viewer-a", WS_A))
        .create({ slug: "mood", valueType: "string", profileId: P_SYS })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.writes).toEqual(["create"]);
  });
});

describe("propertyDefs.update is gated on the def row", () => {
  it("a system kind's base def is pod admin only", async () => {
    await expect(
      propertyDefsRouter
        .createCaller(ctx("editor-a", WS_A))
        .update({ id: DEF_SYS, constraints: { options: ["x"] } })
    ).rejects.toThrow("Pod admin access required");
    expect(h.writes).toEqual([]);

    await propertyDefsRouter
      .createCaller(ctx("pod-admin", WS_A))
      .update({ id: DEF_SYS, constraints: { options: ["x"] } });
    expect(h.writes).toEqual(["update"]);
  });

  it("a global def (no profile) is pod admin only", async () => {
    await expect(
      propertyDefsRouter
        .createCaller(ctx("editor-b", WS_B))
        .update({ id: DEF_GLOBAL, valueType: "number" })
    ).rejects.toThrow("Pod admin access required");
    expect(h.writes).toEqual([]);
  });

  it("a base def on a workspace-owned profile belongs to that workspace: B edits it, A cannot", async () => {
    await expect(
      propertyDefsRouter
        .createCaller(ctx("editor-a", WS_A))
        .update({ id: DEF_BASE_ON_B, valueType: "number" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.writes).toEqual([]);

    await propertyDefsRouter
      .createCaller(ctx("editor-b", WS_B))
      .update({ id: DEF_BASE_ON_B, valueType: "number" });
    expect(h.writes).toEqual(["update"]);
  });

  it("an overlay def belongs to its workspace: B edits it, A cannot", async () => {
    await expect(
      propertyDefsRouter
        .createCaller(ctx("editor-a", WS_A))
        .update({ id: DEF_OVERLAY_B, valueType: "number" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.writes).toEqual([]);

    await propertyDefsRouter
      .createCaller(ctx("editor-b", WS_B))
      .update({ id: DEF_OVERLAY_B, valueType: "number" });
    expect(h.writes).toEqual(["update"]);
  });
});
