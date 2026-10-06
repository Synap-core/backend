/**
 * The agent that STARTS a session is on its roster (`agent_ids`).
 *
 * Live defect (2026-10-06): sessions Raycast's agent started through
 * `start_session` were stored `origin: "agent"` with `agent_ids: []`. Every
 * surface names a session's agent from `agent_ids` alone, so they read as the
 * person's own sessions, with no agent on them.
 *
 * Real: `createFocusSession` on PGlite with every @synap/database table.
 * Stubbed: governance (granted), the session room, realtime, project placement.
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
const HELPER = "33333333-3333-4333-8333-333333333333";

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

const roster = async (id: string) =>
  (
    await h.client!.query<{ agent_ids: string[] | null; origin: string }>(
      `select agent_ids, origin from focus_sessions where id = $1`,
      [id]
    )
  ).rows[0];

const sessionId = (r: unknown) =>
  (r as { session?: { id: string } }).session?.id ?? (r as { id: string }).id;

beforeAll(async () => {
  for (const t of Object.values(schema)) {
    if (is(t, PgTable)) await h.client!.exec(ddlFor(t));
  }
  await h.client!.query(
    `insert into users (id, email, name, user_type) values
      ($1, 'a@x.test', 'Antoine', 'human'),
      ($2, 'r@x.test', 'Raycast', 'agent'),
      ($3, 'h@x.test', 'Helper', 'agent')`,
    [USER, RAYCAST, HELPER]
  );
}, 120_000);

describe("createFocusSession — the starting agent is on the roster", () => {
  it("an agent's start lists that agent", async () => {
    const res = await createFocusSession({
      userId: USER,
      goal: `Ship carousel ${randomUUID()}`,
      agentUserId: RAYCAST,
      matchTemplate: false,
      forceCreate: true,
    });
    expect(res.status).toBe("created");
    expect(await roster(sessionId(res))).toEqual({
      agent_ids: [RAYCAST],
      origin: "agent",
    });
  });

  it("keeps the agents the caller named and never lists the starter twice", async () => {
    const res = await createFocusSession({
      userId: USER,
      goal: `Pitch deck ${randomUUID()}`,
      agentUserId: RAYCAST,
      agentIds: [HELPER, RAYCAST],
      matchTemplate: false,
      forceCreate: true,
    });
    expect((await roster(sessionId(res))).agent_ids).toEqual([HELPER, RAYCAST]);
  });

  it("CONTROL — a person's start lists no agent", async () => {
    const res = await createFocusSession({
      userId: USER,
      goal: `My own work ${randomUUID()}`,
      matchTemplate: false,
      forceCreate: true,
    });
    expect(await roster(sessionId(res))).toMatchObject({ origin: "human" });
    expect((await roster(sessionId(res))).agent_ids ?? []).toEqual([]);
  });
});
