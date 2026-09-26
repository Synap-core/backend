/**
 * "Add person" / "Remove" on a session room — the REAL `chat.addRoomMember` /
 * `chat.removeRoomMember` / `chat.listRoomMembers` procedures on PGlite (real
 * access rule, real `canUserSeeChannel`, real `enrollRoomMember`).
 *
 * A session room is roster-only, so a roster row IS a share: every refusal
 * below is an access decision (rules: `services/messaging/room-people.ts`).
 *
 * Mocked: the tRPC auth middleware (ctx is handed in), the realtime bridge and
 * the notification write (observed, not executed — the registry row it names
 * is asserted to exist and render).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const holder = vi.hoisted(() => ({
  db: undefined as unknown,
  notified: [] as Array<Record<string, unknown>>,
  events: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../trpc.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../trpc.js")>();
  return { ...actual, protectedProcedure: actual.t.procedure };
});
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = { ...actual };
  Object.defineProperty(mocked, "db", {
    get: () => holder.db,
    enumerable: true,
  });
  return mocked;
});
vi.mock("../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: (e: Record<string, unknown>) => holder.events.push(e),
}));
vi.mock("../../notifications/NotificationService.js", () => ({
  NotificationService: {
    create: async (n: Record<string, unknown>) => {
      holder.notified.push(n);
      return "notif-1";
    },
  },
}));

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import {
  channels,
  channelMembers,
  focusSessions,
  users,
  workspaceMembers,
  workspaces,
} from "@synap/database";
import { router } from "../../trpc.js";
import { membershipProcedures } from "./membership.js";
import { getNotificationDef } from "../../notifications/registry.js";

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const columns = cfg.columns.map((c) => {
    let type = c.getSQLType();
    if (/vector/.test(type) || c.columnType === "PgEnumColumn") type = "text";
    let def = "";
    const d = c.default as unknown;
    if (d !== undefined && !(d instanceof SQL)) {
      if (typeof d === "string") def = ` default '${d.replace(/'/g, "''")}'`;
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
      else if (type.endsWith("[]")) def = ` default '{}'`;
      else def = ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
    } else if (type.startsWith("timestamp") && c.hasDefault) {
      def = " default now()";
    } else if (c.primary && type === "uuid") {
      def = " default gen_random_uuid()";
    }
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${columns.join(", ")});`;
}

const WS = "11111111-1111-4111-8111-111111111111";
const OTHER_WS = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";

let client: PGlite;

const caller = (userId: string) =>
  router({
    add: membershipProcedures.addRoomMember,
    remove: membershipProcedures.removeRoomMember,
    list: membershipProcedures.listRoomMembers,
    candidates: membershipProcedures.listRoomMemberCandidates,
  }).createCaller({ userId, authenticated: true, workspaceId: null } as never);

async function roster(channelId: string): Promise<string[]> {
  const { rows } = await client.query<{ member_id: string }>(
    `select member_id from channel_members where channel_id = $1 order by member_id`,
    [channelId]
  );
  return rows.map((r) => r.member_id);
}

async function sessionRoom(workspaceId: string | null): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into channels (user_id, workspace_id, channel_type, scope, status, title, context_object_type, context_object_id)
     values ('owner', $1, 'group', 'workspace', 'active', 'Budget review', 'focus_session', $2) returning id`,
    [workspaceId, SESSION]
  );
  const id = rows[0]!.id;
  await client.query(
    `insert into channel_members (channel_id, member_id, member_kind, role) values ($1, 'owner', 'human', 'owner')`,
    [id]
  );
  // The session's OWN room: `ensureSessionChannel` writes the FK with the stamp.
  await client.query(
    `update focus_sessions set channel_id = $1 where id = $2`,
    [id, SESSION]
  );
  return id;
}

/** A thread `teammate` minted, stamped with the owner's session — no FK. */
async function forgedRoom(): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into channels (user_id, workspace_id, channel_type, scope, status, title, context_object_type, context_object_id)
     values ('teammate', $1, 'thread', 'workspace', 'active', 'Forged', 'focus_session', $2) returning id`,
    [WS, SESSION]
  );
  const id = rows[0]!.id;
  await client.query(
    `insert into channel_members (channel_id, member_id, member_kind, role) values ($1, 'teammate', 'human', 'owner')`,
    [id]
  );
  return id;
}

beforeEach(async () => {
  client = new PGlite();
  // EVERY table: the channel read rule's object-room branch (Documents v2)
  // evaluates the documents / views / entities floors, whatever the room.
  const allTables = new Map(
    (Object.values(schema) as unknown[])
      .filter(
        (v): v is PgTable =>
          !!v &&
          typeof v === "object" &&
          Symbol.for("drizzle:IsDrizzleTable") in v
      )
      .map((t) => [getTableConfig(t).name, t])
  );
  for (const t of allTables.values()) {
    await client.exec(ddlFor(t));
  }
  await client.exec(
    `create unique index on channel_members (channel_id, member_id);`
  );
  holder.db = drizzle(client, {
    schema: {
      channels,
      channelMembers,
      focusSessions,
      users,
      workspaceMembers,
      workspaces,
    },
  });
  holder.notified.length = 0;
  holder.events.length = 0;
  await client.exec(`
    insert into users (id, email, name, user_type, created_by_user_id) values
      ('owner', 'o@x', 'Olive Owner', 'human', null),
      ('member', 'm@x', 'Max Member', 'human', null),
      ('teammate', 't@x', 'Tess Teammate', 'human', null),
      ('stranger', 's@x', 'Sam Stranger', 'human', null),
      ('owner-agent', 'oa@x', 'Agent', 'agent', 'owner');
    insert into workspace_members (workspace_id, user_id, role) values
      ('${WS}', 'owner', 'owner'),
      ('${WS}', 'member', 'editor'),
      ('${WS}', 'teammate', 'editor'),
      ('${WS}', 'owner-agent', 'editor'),
      ('${OTHER_WS}', 'stranger', 'owner');
    insert into focus_sessions (id, user_id, workspace_id, title, status) values
      ('${SESSION}', 'owner', '${WS}', 'Budget review', 'active');
  `);
});

describe("chat.addRoomMember", () => {
  it("the owner adds a workspace member: enrolled as a HUMAN member and notified", async () => {
    const room = await sessionRoom(WS);
    const res = await caller("owner").add({
      channelId: room,
      userId: "member",
    });
    expect(res.status).toBe("added");

    const { rows } = await client.query<{
      member_kind: string;
      role: string;
      added_by: string;
    }>(
      `select member_kind, role, added_by from channel_members where channel_id = $1 and member_id = 'member'`,
      [room]
    );
    expect(rows).toEqual([
      { member_kind: "human", role: "member", added_by: "owner" },
    ]);

    expect(holder.notified).toHaveLength(1);
    const n = holder.notified[0]!;
    expect(n).toMatchObject({
      type: "chat.room_member_added",
      userId: "member",
      sourceId: room,
      data: { inviterName: "Olive Owner", roomTitle: "Budget review" },
    });
    // The type the door writes is a real registry row whose templates the
    // payload fills — a typo here would be a notification nobody can render.
    const def = getNotificationDef(n.type as string);
    expect(def).toBeDefined();
    for (const key of (def!.titleTemplate.match(/{{(\w+)}}/g) ?? []).map((k) =>
      k.slice(2, -2)
    )) {
      expect((n.data as Record<string, unknown>)[key]).toBeTruthy();
    }
    // The added person's own socket room is reached, so the room appears.
    expect(holder.events.some((e) => e.userId === "member")).toBe(true);
  });

  it("is idempotent — a second add writes nothing and notifies nobody", async () => {
    const room = await sessionRoom(WS);
    await caller("owner").add({ channelId: room, userId: "member" });
    holder.notified.length = 0;
    const res = await caller("owner").add({
      channelId: room,
      userId: "member",
    });
    expect(res.status).toBe("already_member");
    expect(holder.notified).toHaveLength(0);
  });

  it("refuses a NON-OWNER caller — even one already in the room", async () => {
    const room = await sessionRoom(WS);
    await caller("owner").add({ channelId: room, userId: "member" });
    await expect(
      caller("member").add({ channelId: room, userId: "teammate" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await roster(room)).toEqual(["member", "owner"]);
  });

  it("a caller who cannot see the room gets NOT_FOUND (the id tells them nothing)", async () => {
    const room = await sessionRoom(WS);
    await expect(
      caller("teammate").add({ channelId: room, userId: "teammate" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await roster(room)).toEqual(["owner"]);
  });

  it("refuses a target who is NOT a member of the room's workspace", async () => {
    const room = await sessionRoom(WS);
    await expect(
      caller("owner").add({ channelId: room, userId: "stranger" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await roster(room)).toEqual(["owner"]);
    expect(holder.notified).toHaveLength(0);
  });

  it("refuses an AGENT target — the person door never enrolls an agent", async () => {
    const room = await sessionRoom(WS);
    await expect(
      caller("owner").add({ channelId: room, userId: "owner-agent" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("pod-wide room (NULL workspace): only someone sharing a workspace with the owner", async () => {
    const room = await sessionRoom(null);
    await expect(
      caller("owner").add({ channelId: room, userId: "stranger" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const res = await caller("owner").add({
      channelId: room,
      userId: "teammate",
    });
    expect(res.status).toBe("added");
  });

  it("refuses a room that is not a session room", async () => {
    const { rows } = await client.query<{ id: string }>(
      `insert into channels (user_id, workspace_id, channel_type, scope, status, title)
       values ('owner', $1, 'group', 'workspace', 'active', 'General') returning id`,
      [WS]
    );
    await expect(
      caller("owner").add({ channelId: rows[0]!.id, userId: "member" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("a FORGED session stamp (no channel_id FK) manages nobody", () => {
  it("its minter cannot seat anyone or list candidates, and is offered no door", async () => {
    await sessionRoom(WS);
    const room = await forgedRoom();
    await expect(
      caller("teammate").add({ channelId: room, userId: "member" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller("teammate").candidates({ channelId: room })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(
      (await caller("teammate").list({ channelId: room })).viewerCanManagePeople
    ).toBe(false);
    expect(await roster(room)).toEqual(["teammate"]);
  });
});

describe("chat.removeRoomMember", () => {
  it("the owner removes a member — the roster row (the share) is gone", async () => {
    const room = await sessionRoom(WS);
    await caller("owner").add({ channelId: room, userId: "member" });
    const res = await caller("owner").remove({
      channelId: room,
      userId: "member",
    });
    expect(res.status).toBe("removed");
    expect(await roster(room)).toEqual(["owner"]);
  });

  it("the owner can never be removed", async () => {
    const room = await sessionRoom(WS);
    await expect(
      caller("owner").remove({ channelId: room, userId: "owner" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await roster(room)).toEqual(["owner"]);
  });

  it("a non-owner member cannot remove anyone", async () => {
    const room = await sessionRoom(WS);
    await caller("owner").add({ channelId: room, userId: "member" });
    await caller("owner").add({ channelId: room, userId: "teammate" });
    await expect(
      caller("member").remove({ channelId: room, userId: "teammate" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await roster(room)).toEqual(["member", "owner", "teammate"]);
  });
});

describe("chat.listRoomMembers / listRoomMemberCandidates", () => {
  it("viewerCanManagePeople is true for the owner only", async () => {
    const room = await sessionRoom(WS);
    await caller("owner").add({ channelId: room, userId: "member" });
    expect(
      (await caller("owner").list({ channelId: room })).viewerCanManagePeople
    ).toBe(true);
    expect(
      (await caller("member").list({ channelId: room })).viewerCanManagePeople
    ).toBe(false);
  });

  it("viewerCanRemove: the owner may remove a member, never the owner; a member may remove no one", async () => {
    const room = await sessionRoom(WS);
    await caller("owner").add({ channelId: room, userId: "member" });
    const flags = async (viewer: string) =>
      Object.fromEntries(
        (await caller(viewer).list({ channelId: room })).members.map((m) => [
          m.memberId,
          m.viewerCanRemove,
        ])
      );
    expect(await flags("owner")).toEqual({ owner: false, member: true });
    expect(await flags("member")).toEqual({ owner: false, member: false });
  });

  it("candidates = eligible humans not already in the room; non-owners refused", async () => {
    const room = await sessionRoom(WS);
    await caller("owner").add({ channelId: room, userId: "member" });
    const { candidates } = await caller("owner").candidates({
      channelId: room,
    });
    expect(candidates.map((c) => c.userId)).toEqual(["teammate"]);
    await expect(
      caller("member").candidates({ channelId: room })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
