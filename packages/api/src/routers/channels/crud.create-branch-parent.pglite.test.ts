/**
 * `chat.createChannel` with a `parentChannelId` (a branch) accepts only a
 * parent the caller can read, in the caller's workspace or in none. Any
 * refusal is NOT_FOUND and writes no row. Driven through the REAL procedure
 * on PGlite.
 *
 *   WS and OTHER_WS: two spaces Bob belongs to; Alice belongs to WS.
 *   Alice owns a private thread in WS and a group room in WS.
 *   Bob owns a thread in WS, a thread in OTHER_WS and a personal thread with
 *   no workspace.
 *
 * Real: the procedure, the grant-aware `channelVisibilityWhere`, the insert.
 * Stubbed: the tRPC auth middlewares (ctx is handed in) and the realtime emit.
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
const OTHER_WS = randomUUID();
const ALICE_THREAD = randomUUID();
const ALICE_GROUP = randomUUID();
const BOB_THREAD = randomUUID();
const BOB_OTHER_WS_THREAD = randomUUID();
const BOB_PERSONAL = randomUUID();

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const caller = (userId: string, workspaceId: string) =>
  router({ createChannel: crudProcedures.createChannel }).createCaller({
    userId,
    authenticated: true,
    workspaceId,
  } as never);

async function branchesOf(parentId: string): Promise<number> {
  const { rows } = await q<{ n: number }>(
    `select count(*)::int as n from channels where parent_channel_id = $1`,
    [parentId]
  );
  return rows[0]!.n;
}

beforeAll(async () => {
  await h.client!.exec(pgliteAllTablesDdl());
  for (const [id, owner] of [
    [WS, ALICE],
    [OTHER_WS, BOB],
  ]) {
    await q(`insert into workspaces (id, name, owner_id) values ($1,$2,$3)`, [
      id,
      `space ${id.slice(0, 4)}`,
      owner,
    ]);
  }
  for (const [ws, user, role] of [
    [WS, ALICE, "owner"],
    [WS, BOB, "editor"],
    [OTHER_WS, BOB, "owner"],
  ]) {
    await q(
      `insert into workspace_members (workspace_id, user_id, role) values ($1,$2,$3)`,
      [ws, user, role]
    );
  }
  const channel = (
    id: string,
    owner: string,
    workspaceId: string | null,
    type: string
  ) =>
    q(
      `insert into channels (id, user_id, workspace_id, channel_type, status, title) values ($1,$2,$3,$4,'active',$5)`,
      [id, owner, workspaceId, type, `${type} of ${owner.slice(0, 4)}`]
    );
  await channel(ALICE_THREAD, ALICE, WS, "thread");
  await channel(ALICE_GROUP, ALICE, WS, "group");
  await channel(BOB_THREAD, BOB, WS, "thread");
  await channel(BOB_OTHER_WS_THREAD, BOB, OTHER_WS, "thread");
  await channel(BOB_PERSONAL, BOB, null, "personal");
});

describe("createChannel: a branch's parent goes through the read floor", () => {
  it("refuses another member's private thread with NOT_FOUND and writes nothing", async () => {
    await expect(
      caller(BOB, WS).createChannel({ parentChannelId: ALICE_THREAD })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Parent channel not found",
    });
    expect(await branchesOf(ALICE_THREAD)).toBe(0);
  });

  it("refuses the caller's own channel in another workspace with NOT_FOUND", async () => {
    await expect(
      caller(BOB, WS).createChannel({ parentChannelId: BOB_OTHER_WS_THREAD })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await branchesOf(BOB_OTHER_WS_THREAD)).toBe(0);
  });

  it("branches the caller's own thread in the workspace", async () => {
    const { channelId } = await caller(BOB, WS).createChannel({
      parentChannelId: BOB_THREAD,
    });
    const { rows } = await q<{
      parent_channel_id: string;
      user_id: string;
      workspace_id: string;
    }>(
      `select parent_channel_id, user_id, workspace_id from channels where id = $1`,
      [channelId]
    );
    expect(rows[0]).toEqual({
      parent_channel_id: BOB_THREAD,
      user_id: BOB,
      workspace_id: WS,
    });
  });

  it("branches a shared room of the workspace the caller can read", async () => {
    await caller(BOB, WS).createChannel({ parentChannelId: ALICE_GROUP });
    expect(await branchesOf(ALICE_GROUP)).toBe(1);
  });

  it("branches the caller's own personal thread (no workspace)", async () => {
    await caller(BOB, WS).createChannel({ parentChannelId: BOB_PERSONAL });
    expect(await branchesOf(BOB_PERSONAL)).toBe(1);
  });
});
