/**
 * An agent's START is filed into the project it declared its focus on
 * (`synap_set_project_focus`), as its auto-opened receipt sessions already are
 * (`permission-check.ts`). Plan A2-a, 2026-10-29: 68% of sessions had no
 * project, because `synap_start_session` never read the focus.
 *
 * Real: `createFocusSession` and the project ladder (`resolveSessionProjectPlacement`
 * → `resolveProjectPlacement`) on PGlite, and the focus reader
 * (`getAgentFocusProjectId`) over a real `users.agent_metadata` row.
 * Stubbed: governance (granted), the session room, realtime, spawn edges.
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
const FOCUSED = "22222222-2222-4222-8222-222222222222";
const UNFOCUSED = "33333333-3333-4333-8333-333333333333";
const FOCUS_PROJECT = "44444444-4444-4444-8444-444444444444";
const OTHER_PROJECT = "55555555-5555-4555-8555-555555555555";

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

const projectOf = async (r: unknown) => {
  const id =
    (r as { session?: { id: string } }).session?.id ?? (r as { id: string }).id;
  return (
    await h.client!.query<{ project_id: string | null }>(
      `select project_id from focus_sessions where id = $1`,
      [id]
    )
  ).rows[0]?.project_id;
};

const start = (over: Record<string, unknown>) =>
  createFocusSession({
    userId: USER,
    goal: `Work ${randomUUID()}`,
    matchTemplate: false,
    forceCreate: true,
    ...over,
  });

beforeAll(async () => {
  for (const t of Object.values(schema)) {
    if (is(t, PgTable)) await h.client!.exec(ddlFor(t));
  }
  await h.client!.query(
    `insert into users (id, email, name, user_type, agent_metadata) values
      ($1, 'a@x.test', 'Antoine', 'human', null),
      ($2, 'f@x.test', 'Focused', 'agent', $4::jsonb),
      ($3, 'u@x.test', 'Unfocused', 'agent', null)`,
    [
      USER,
      FOCUSED,
      UNFOCUSED,
      JSON.stringify({ focusProjectId: FOCUS_PROJECT }),
    ]
  );
}, 120_000);

describe("createFocusSession — an agent's declared project focus", () => {
  it("files the agent's start into its focus project when nothing pins one", async () => {
    expect(await projectOf(await start({ agentUserId: FOCUSED }))).toBe(
      FOCUS_PROJECT
    );
  });

  it("an explicit projectId still wins over the focus", async () => {
    expect(
      await projectOf(
        await start({ agentUserId: FOCUSED, projectId: OTHER_PROJECT })
      )
    ).toBe(OTHER_PROJECT);
  });

  it("CONTROL — an agent with no focus, and a person, start unfiled", async () => {
    expect(await projectOf(await start({ agentUserId: UNFOCUSED }))).toBeNull();
    expect(await projectOf(await start({}))).toBeNull();
  });
});
