/**
 * THE access door (`access/door.ts`) on a real Postgres (PGlite), through the
 * real floors it wraps: `scopedDb` + `grantReadPredicate` for rows and rooms,
 * the space read, `assertWorkspaceWrite` + `grantWriteDenial` for writes, and
 * key principals built by the real `resolveKeyIdentity` from `grants` rows.
 *
 * OWNER is an editor of A and of B, so every narrower answer for a key below
 * is the key's grant or binding at work, not the people's floor (each block
 * carries its control).
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return { ...actual, db, getDb: async () => db };
});

import { entities } from "@synap/database/schema";
import { pgliteAllTablesDdl } from "../__tests__/pglite-ddl.js";
import { resolveKeyIdentity } from "./key-identity.js";
import {
  assertCanWrite,
  canJoinRoom,
  canRead,
  principalFromKey,
  userPrincipal,
  type Principal,
} from "./door.js";

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

beforeAll(async () => {
  await h.client!.exec(pgliteAllTablesDdl());
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    `delete from entities; delete from channel_members; delete from channels;
     delete from views; delete from grants; delete from workspace_members;
     delete from workspaces; delete from users;`
  );
});

const OWNER = randomUUID();
const ROSTER_OUTSIDER = randomUUID(); // on a room's roster, NOT in its space
const WS_MEMBER = randomUUID(); // in the space, NOT on the roster
const VIEWER = randomUUID();
const AGENT = randomUUID(); // a key's own (agent) user, acting for OWNER

async function user(id: string, type = "human") {
  await q(`insert into users (id, email, user_type) values ($1, $2, $3)`, [
    id,
    `${id}@t`,
    type,
  ]);
}

async function space(
  ownerId: string,
  members: Array<[string, string]>,
  settings: Record<string, unknown> = {}
) {
  const ws = randomUUID();
  await q(
    `insert into workspaces (id, owner_id, name, settings) values ($1, $2, 'space', $3::jsonb)`,
    [ws, ownerId, JSON.stringify(settings)]
  );
  for (const [u, role] of members) {
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role)
       values (gen_random_uuid(), $1, $2, $3)`,
      [ws, u, role]
    );
  }
  return ws;
}

async function world() {
  for (const u of [OWNER, ROSTER_OUTSIDER, WS_MEMBER, VIEWER]) await user(u);
  await user(AGENT, "agent");
  const a = await space(OWNER, [
    [OWNER, "editor"],
    [WS_MEMBER, "editor"],
    [VIEWER, "viewer"],
  ]);
  const b = await space(OWNER, [[OWNER, "editor"]]);
  return { a, b };
}

async function channel(args: {
  ws: string;
  type: "group" | "thread";
  session?: boolean;
  roster?: string[];
}) {
  const id = randomUUID();
  await q(
    `insert into channels (id, user_id, workspace_id, channel_type, scope, status, title, context_object_type, context_object_id)
     values ($1, $2, $3, $4, 'workspace', 'active', 'room', $5, $6)`,
    [
      id,
      OWNER,
      args.ws,
      args.type,
      args.session ? "focus_session" : null,
      args.session ? randomUUID() : null,
    ]
  );
  for (const m of args.roster ?? []) {
    await q(
      `insert into channel_members (channel_id, member_id, member_kind, role)
       values ($1, $2, 'human', 'member')`,
      [id, m]
    );
  }
  return id;
}

/** An agent key acting for OWNER, resolved by the ONE key identity door. */
async function key(args: {
  grants: Array<{ permissions: string[]; workspaceIds?: string[] }>;
  bound?: string;
}): Promise<Principal> {
  const apiKeyId = randomUUID();
  for (const g of args.grants) {
    await q(
      `insert into grants (api_key_id, principal_user_id, on_behalf_of, permissions, workspace_ids, created_by)
       values ($1, $2, $3, $4::text[], $5::uuid[], $3)`,
      [
        apiKeyId,
        AGENT,
        OWNER,
        `{${g.permissions.join(",")}}`,
        g.workspaceIds ? `{${g.workspaceIds.join(",")}}` : null,
      ]
    );
  }
  const identity = await resolveKeyIdentity({
    id: apiKeyId,
    userId: AGENT,
    linkedUserId: OWNER,
  });
  return principalFromKey(
    { userId: AGENT, workspaceId: args.bound ?? null },
    identity
  );
}

describe("canJoinRoom — a person: the read of what the room streams", () => {
  it("session room: a roster outsider joins; a space member off the roster does not", async () => {
    const { a } = await world();
    const room = await channel({
      ws: a,
      type: "group",
      session: true,
      roster: [OWNER, ROSTER_OUTSIDER],
    });
    expect(await canJoinRoom(userPrincipal(OWNER), `channel:${room}`)).toBe(
      true
    );
    expect(
      await canJoinRoom(userPrincipal(ROSTER_OUTSIDER), `channel:${room}`)
    ).toBe(true);
    expect(await canJoinRoom(userPrincipal(WS_MEMBER), `channel:${room}`)).toBe(
      false
    );
  });

  it("workspace room: a member (a viewer too) and a pod reader of a pod-visible space; not an outsider", async () => {
    const { a, b } = await world();
    const open = await space(ROSTER_OUTSIDER, [], {
      workspaceVisibility: "pod_visible",
    });
    expect(await canJoinRoom(userPrincipal(VIEWER), `workspace:${a}`)).toBe(
      true
    );
    expect(await canJoinRoom(userPrincipal(WS_MEMBER), `workspace:${b}`)).toBe(
      false
    );
    expect(
      await canJoinRoom(userPrincipal(WS_MEMBER), `workspace:${open}`)
    ).toBe(true);
  });

  it("workspace room: its owner joins with no member row", async () => {
    await world();
    const owned = await space(WS_MEMBER, []);
    expect(
      await canJoinRoom(userPrincipal(WS_MEMBER), `workspace:${owned}`)
    ).toBe(true);
    expect(await canJoinRoom(userPrincipal(VIEWER), `workspace:${owned}`)).toBe(
      false
    );
  });

  it("user room: one's own only", async () => {
    await world();
    expect(await canJoinRoom(userPrincipal(OWNER), `user:${OWNER}`)).toBe(true);
    expect(await canJoinRoom(userPrincipal(OWNER), `user:${VIEWER}`)).toBe(
      false
    );
  });

  it("a room it cannot parse, or of an unknown prefix, is never readable", async () => {
    await world();
    const p = userPrincipal(OWNER);
    for (const room of ["garbage", `:${OWNER}`, "user:", `document:${OWNER}`]) {
      expect(await canRead(p, { room })).toBe(false);
      expect(await canJoinRoom(p, room)).toBe(false);
    }
  });

  it("a failed read throws from canRead and is denied by canJoinRoom", async () => {
    await world();
    const p = userPrincipal(OWNER);
    await expect(canRead(p, { room: "channel:not-a-uuid" })).rejects.toThrow();
    expect(await canJoinRoom(p, "channel:not-a-uuid")).toBe(false);
  });
});

describe("canJoinRoom — an API key: its human's read, narrowed by its binding and grant", () => {
  it("control: OWNER alone joins every room of B", async () => {
    const { b } = await world();
    const chanB = await channel({ ws: b, type: "group" });
    expect(await canJoinRoom(userPrincipal(OWNER), `workspace:${b}`)).toBe(
      true
    );
    expect(await canJoinRoom(userPrincipal(OWNER), `channel:${chanB}`)).toBe(
      true
    );
  });

  it("a grant pinned to A joins A's space and channels, none of B's", async () => {
    const { a, b } = await world();
    const k = await key({
      grants: [{ permissions: ["*"], workspaceIds: [a] }],
    });
    const chanA = await channel({ ws: a, type: "group" });
    const chanB = await channel({ ws: b, type: "group" });
    expect(await canJoinRoom(k, `workspace:${a}`)).toBe(true);
    expect(await canJoinRoom(k, `channel:${chanA}`)).toBe(true);
    expect(await canJoinRoom(k, `workspace:${b}`)).toBe(false);
    expect(await canJoinRoom(k, `channel:${chanB}`)).toBe(false);
  });

  it("a key BOUND to A with a pod-wide grant joins A only", async () => {
    const { a, b } = await world();
    const k = await key({ grants: [{ permissions: ["*"] }], bound: a });
    const chanA = await channel({ ws: a, type: "group" });
    const chanB = await channel({ ws: b, type: "group" });
    expect(await canJoinRoom(k, `workspace:${a}`)).toBe(true);
    expect(await canJoinRoom(k, `channel:${chanA}`)).toBe(true);
    expect(await canJoinRoom(k, `workspace:${b}`)).toBe(false);
    expect(await canJoinRoom(k, `channel:${chanB}`)).toBe(false);
  });

  it("a key with no live grant joins only its own user room, never its human's", async () => {
    const { a } = await world();
    const k = await key({ grants: [] });
    expect(await canJoinRoom(k, `workspace:${a}`)).toBe(false);
    expect(await canJoinRoom(k, `user:${AGENT}`)).toBe(true);
    expect(await canJoinRoom(k, `user:${OWNER}`)).toBe(false);
  });

  it("a channel-only grant reads channels, not the space's event feed", async () => {
    const { a } = await world();
    const k = await key({ grants: [{ permissions: ["channel.read"] }] });
    const chanA = await channel({ ws: a, type: "group" });
    expect(await canJoinRoom(k, `channel:${chanA}`)).toBe(true);
    expect(await canJoinRoom(k, `workspace:${a}`)).toBe(false);
  });
});

describe("canRead({table, id}) — the promoted row read (was webhooks' ownerReadsRow)", () => {
  it("the row's floor for a person; the key's grant narrows it", async () => {
    const { a, b } = await world();
    const id = randomUUID();
    await q(
      `insert into entities (id, type, user_id, workspace_id) values ($1, 'note', $2, $3)`,
      [id, OWNER, a]
    );
    expect(await canRead(userPrincipal(OWNER), { table: entities, id })).toBe(
      true
    );
    expect(
      await canRead(userPrincipal(ROSTER_OUTSIDER), { table: entities, id })
    ).toBe(false);
    const pinnedToB = await key({
      grants: [{ permissions: ["*"], workspaceIds: [b] }],
    });
    expect(await canRead(pinnedToB, { table: entities, id })).toBe(false);
    const pinnedToA = await key({
      grants: [{ permissions: ["*"], workspaceIds: [a] }],
    });
    expect(await canRead(pinnedToA, { table: entities, id })).toBe(true);
  });
});

describe("assertCanWrite — the write floor on the stored workspace, then the grant", () => {
  const create = (workspaceId: string) => ({
    workspaceId,
    subjectType: "entity",
    action: "create",
    data: { type: "note" },
  });

  it("an editor writes; a viewer and an outsider are refused", async () => {
    const { a } = await world();
    await expect(
      assertCanWrite(userPrincipal(WS_MEMBER), create(a))
    ).resolves.toBeUndefined();
    await expect(
      assertCanWrite(userPrincipal(VIEWER), create(a))
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      assertCanWrite(userPrincipal(ROSTER_OUTSIDER), create(a))
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("Q-A1: the workspace OWNER writes with no member row; a member row, a viewer's, is the authority", async () => {
    await world();
    const noRow = await space(VIEWER, []);
    const demoted = await space(VIEWER, [[VIEWER, "viewer"]]);
    await expect(
      assertCanWrite(userPrincipal(VIEWER), create(noRow))
    ).resolves.toBeUndefined();
    await expect(
      assertCanWrite(userPrincipal(VIEWER), create(demoted))
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("a key's grant must permit the write; a bound key writes only in its space", async () => {
    const { a, b } = await world();
    const readOnly = await key({ grants: [{ permissions: ["entity.read"] }] });
    await expect(assertCanWrite(readOnly, create(a))).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const full = await key({ grants: [{ permissions: ["*"] }] });
    await expect(assertCanWrite(full, create(a))).resolves.toBeUndefined();
    const boundToA = await key({ grants: [{ permissions: ["*"] }], bound: a });
    await expect(assertCanWrite(boundToA, create(b))).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});
