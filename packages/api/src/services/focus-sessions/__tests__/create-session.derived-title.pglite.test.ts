/**
 * No session is stored nameless (plan 9992207a, c-auto-titles).
 *
 * Live (2026-10-12): 19 sessions in 30 days had a NULL title — the titler only
 * names a session once something happens in it, so an idle one stayed
 * untitled forever. Now `createFocusSession` derives a name from the goal
 * (marked `derived`, so the background titler may still improve it), while a
 * title the caller gave is kept and marked as theirs.
 *
 * Real: `createFocusSession` on PGlite. Stubbed: governance, room, realtime,
 * project placement (same harness as create-session.agent-roster).
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
const AGENT = "22222222-2222-4222-8222-222222222222";

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

const row = async (id: string) =>
  (
    await h.client!.query<{ title: string | null; source: string | null }>(
      `select title, metadata->>'titleSource' as source from focus_sessions where id = $1`,
      [id]
    )
  ).rows[0]!;

const sessionId = (r: unknown) =>
  (r as { session?: { id: string } }).session?.id ?? (r as { id: string }).id;

beforeAll(async () => {
  for (const t of Object.values(schema)) {
    if (is(t, PgTable)) await h.client!.exec(ddlFor(t));
  }
  await h.client!.query(
    `insert into users (id, email, name, user_type) values
      ($1, 'a@x.test', 'Antoine', 'human'),
      ($2, 'g@x.test', 'Agent', 'agent')`,
    [USER, AGENT]
  );
}, 120_000);

describe("createFocusSession — a session is never stored nameless", () => {
  it("derives a short name from the goal and marks it derived", async () => {
    const tag = randomUUID().slice(0, 4);
    const goal = `Short titles for every new entry ${tag}, and the existing backlog of this pod is repaired.`;
    const res = await createFocusSession({
      userId: USER,
      goal,
      agentUserId: AGENT,
      matchTemplate: false,
      forceCreate: true,
    });
    const r = await row(sessionId(res));
    expect(r.source).toBe("derived");
    expect(r.title).toBe(`Short titles for every new entry ${tag}`);
    expect(r.title!.endsWith("…")).toBe(false);
  });

  it("keeps a title the caller gave, marked as the agent's", async () => {
    const res = await createFocusSession({
      userId: USER,
      title: "Knowledge and title quality",
      goal: `Fix titles ${randomUUID()}`,
      agentUserId: AGENT,
      matchTemplate: false,
      forceCreate: true,
    });
    expect(await row(sessionId(res))).toEqual({
      title: "Knowledge and title quality",
      source: "agent",
    });
  });
});
