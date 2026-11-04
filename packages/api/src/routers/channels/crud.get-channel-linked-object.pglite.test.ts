/**
 * `chat.getChannel` names what the conversation belongs to (`linkedObject`),
 * so the pod admin page can link to it. Driven through the REAL procedure on
 * PGlite.
 *
 *   WS: Alice (owner) and Bob (editor).
 *   STAMPED_ROOM: Alice's session room, stamped focus_session → ALICE_SESSION.
 *   GROUP: Alice's group room in WS, readable by Bob; ALICE_BORROWER, an
 *     Alice-only session, uses it as its room without a stamp.
 *   BRANCH: Bob's branch of GROUP, no stamp, no session.
 *   LONE: Bob's thread, belonging to nothing.
 *
 * Real: the procedure, `channelVisibilityWhere`, `sessionReadableWhere`.
 * Stubbed: the tRPC auth middlewares (ctx is handed in).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return { ...actual, db, getDb: async () => db };
});

vi.mock("../../trpc.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../trpc.js")>();
  return {
    ...actual,
    protectedProcedure: actual.t.procedure,
    workspaceProcedure: actual.t.procedure,
  };
});

vi.mock("../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => undefined,
}));

import { pgliteAllTablesDdl } from "../../__tests__/pglite-ddl.js";
import { router } from "../../trpc.js";
import { crudProcedures } from "./crud.js";

const ALICE = randomUUID();
const BOB = randomUUID();
const WS = randomUUID();
const STAMPED_ROOM = randomUUID();
const GROUP = randomUUID();
const BRANCH = randomUUID();
const LONE = randomUUID();
const ALICE_SESSION = randomUUID();
const ALICE_BORROWER = randomUUID();

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const linkedFor = async (userId: string, channelId: string) =>
  (
    await router({ getChannel: crudProcedures.getChannel })
      .createCaller({ userId, authenticated: true, workspaceId: WS } as never)
      .getChannel({ channelId, includeContext: false })
  ).linkedObject;

beforeAll(async () => {
  await h.client!.exec(pgliteAllTablesDdl());
  await q(
    `insert into workspaces (id, name, owner_id) values ($1,'space',$2)`,
    [WS, ALICE]
  );
  for (const [user, role] of [
    [ALICE, "owner"],
    [BOB, "editor"],
  ]) {
    await q(
      `insert into workspace_members (workspace_id, user_id, role) values ($1,$2,$3)`,
      [WS, user, role]
    );
  }
  const channel = (
    id: string,
    owner: string,
    type: string,
    title: string,
    extra: { ctxType?: string; ctxId?: string; parent?: string } = {}
  ) =>
    q(
      `insert into channels (id, user_id, workspace_id, channel_type, status, title,
         context_object_type, context_object_id, parent_channel_id)
       values ($1,$2,$3,$4,'active',$5,$6,$7,$8)`,
      [
        id,
        owner,
        WS,
        type,
        title,
        extra.ctxType ?? null,
        extra.ctxId ?? null,
        extra.parent ?? null,
      ]
    );
  await channel(STAMPED_ROOM, ALICE, "thread", "Room", {
    ctxType: "focus_session",
    ctxId: ALICE_SESSION,
  });
  await channel(GROUP, ALICE, "group", "Team room");
  await channel(BRANCH, BOB, "thread", "Side thread", { parent: GROUP });
  await channel(LONE, BOB, "thread", "Lone thread");
  const session = (id: string, title: string, channelId: string) =>
    q(
      `insert into focus_sessions (id, user_id, workspace_id, title, goal, channel_id)
       values ($1,$2,$3,$4,'a goal',$5)`,
      [id, ALICE, WS, title, channelId]
    );
  await session(ALICE_SESSION, "Ship 0.7.2", STAMPED_ROOM);
  await session(ALICE_BORROWER, "Alice's private work", GROUP);
});

describe("getChannel.linkedObject: what a conversation belongs to", () => {
  it("a session room links to its session, by the stamp, with its title", async () => {
    expect(await linkedFor(ALICE, STAMPED_ROOM)).toEqual({
      type: "session",
      id: ALICE_SESSION,
      title: "Ship 0.7.2",
      via: "context",
    });
  });

  it("a borrowed room (no stamp) links to the session its reader can read", async () => {
    expect(await linkedFor(ALICE, GROUP)).toEqual({
      type: "session",
      id: ALICE_BORROWER,
      title: "Alice's private work",
      via: "session_room",
    });
  });

  it("never reveals a borrowing session its reader cannot read", async () => {
    // Bob reads the group room, not Alice's owner-only session.
    expect(await linkedFor(BOB, GROUP)).toBeNull();
  });

  it("a branch with no stamp and no session links to the conversation it came from", async () => {
    expect(await linkedFor(BOB, BRANCH)).toEqual({
      type: "channel",
      id: GROUP,
      title: "Team room",
      via: "parent",
    });
  });

  it("a conversation that belongs to nothing has no link", async () => {
    expect(await linkedFor(BOB, LONE)).toBeNull();
  });
});
