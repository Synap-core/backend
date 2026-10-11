/**
 * `createFocusSession` refuses a caller-supplied ROOM the caller cannot read.
 *
 * A session's `channelId` is the room the judge and every room reader read AS
 * the session's. The Hub route alone used to floor it, so tRPC `create` and
 * MCP `start_session` stored a pointer at a stranger's conversation. The floor
 * now lives in the ONE start door every caller passes, through the canonical
 * channel read predicate (`canUserSeeChannel`) — real here, on real rows.
 *
 * Real: `createFocusSession` + `canUserSeeChannel` on PGlite with every
 * @synap/database table. Stubbed: governance (granted), the session room
 * mint, realtime, project placement.
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
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return {
    ...actual,
    db: drizzle(client, { schema }),
    recordSessionSpawn: async () => ({
      linked: false,
      suspendedIntentRecorded: false,
    }),
    resolveSessionProjectPlacement: async () => ({ projectId: null }),
  };
});
vi.mock("../../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    checkPermissionOrPropose: async () => ({ granted: true }),
  };
});
vi.mock("../ensure-session-channel.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, ensureSessionChannel: async () => null };
});
vi.mock("../../../utils/domain-event-bridge.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, emitHubRealtimeEvent: () => undefined };
});

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { createFocusSession } from "../create-session.js";

const USER = "11111111-1111-4111-8111-111111111111";
const RAYCAST = "22222222-2222-4222-8222-222222222222";
const STRANGER = "33333333-3333-4333-8333-333333333333";
const MY_ROOM = "44444444-4444-4444-8444-444444444444";
const THEIR_ROOM = "55555555-5555-4555-8555-555555555555";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = t.endsWith("[]") ? t : BASIC.test(t) ? t : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const stored = async (goal: string) =>
  (
    await h.client!.query<{ channel_id: string | null }>(
      `select channel_id from focus_sessions where goal = $1`,
      [goal]
    )
  ).rows;

beforeAll(async () => {
  for (const t of Object.values(schema)) {
    if (is(t, PgTable)) await h.client!.exec(ddlFor(t));
  }
  await h.client!.query(
    `insert into users (id, email, name, user_type) values
      ($1, 'a@x.test', 'Antoine', 'human'),
      ($2, 'r@x.test', 'Raycast', 'agent'),
      ($3, 's@x.test', 'Stranger', 'human')`,
    [USER, RAYCAST, STRANGER]
  );
  // Two PERSONAL channels: mine, and a stranger's private thread.
  await h.client!.query(
    `insert into channels (id, user_id, channel_type, title) values
      ($1, $2, 'personal', 'mine'),
      ($3, $4, 'personal', 'theirs')`,
    [MY_ROOM, USER, THEIR_ROOM, STRANGER]
  );
}, 120_000);

describe("createFocusSession — the room floor", () => {
  it("tRPC-shaped (a person): someone else's room is NOT_FOUND, nothing stored", async () => {
    const goal = `Peek ${randomUUID()}`;
    await expect(
      createFocusSession({
        userId: USER,
        goal,
        channelId: THEIR_ROOM,
        matchTemplate: false,
        forceCreate: true,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await stored(goal)).toEqual([]);
  });

  it("MCP-shaped (an agent key on the person): someone else's room is NOT_FOUND", async () => {
    const goal = `Agent peek ${randomUUID()}`;
    await expect(
      createFocusSession({
        userId: USER,
        agentUserId: RAYCAST,
        goal,
        channelId: THEIR_ROOM,
        matchTemplate: false,
        forceCreate: true,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await stored(goal)).toEqual([]);
  });

  it("the caller's own room is stored as the session's room", async () => {
    const goal = `Mine ${randomUUID()}`;
    const res = await createFocusSession({
      userId: USER,
      agentUserId: RAYCAST,
      goal,
      channelId: MY_ROOM,
      matchTemplate: false,
      forceCreate: true,
    });
    expect(res.status).toBe("created");
    expect(await stored(goal)).toEqual([{ channel_id: MY_ROOM }]);
  });

  it("CONTROL — no room named (the internal callers' shape) still creates", async () => {
    const goal = `Roomless ${randomUUID()}`;
    const res = await createFocusSession({
      userId: USER,
      goal,
      matchTemplate: false,
      forceCreate: true,
    });
    expect(res.status).toBe("created");
    expect(await stored(goal)).toEqual([{ channel_id: null }]);
  });
});
