/**
 * A required playbook param an AGENT left unanswered goes back to that agent
 * as a refusal — never a slot in the person's Needs you (founder decision E3,
 * 2026-10-27).
 *
 * Live case before: "Answer: UI design" ("Nobody supplied it when this session
 * was started."), filed for the founder by an agent's `start_session` from a
 * playbook, on a session that never ran.
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
import { PARAM_SLOT_KIND } from "@synap-core/types/focus-sessions";
import { createFocusSession } from "../create-session.js";

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const PLAYBOOK = "44444444-4444-4444-8444-444444444444";

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

const sessions = async (goal: string) =>
  (
    await h.client!.query<{
      id: string;
      expected_outputs: Array<Record<string, unknown>>;
    }>(`select id, expected_outputs from focus_sessions where goal = $1`, [
      goal,
    ])
  ).rows;

const sessionId = (r: unknown) =>
  (r as { session?: { id: string } }).session?.id ?? (r as { id: string }).id;

beforeAll(async () => {
  for (const t of Object.values(schema)) {
    if (is(t, PgTable)) await h.client!.exec(ddlFor(t));
  }
  await h.client!.query(
    `insert into users (id, email, name, user_type) values
      ($1, 'a@x.test', 'Antoine', 'human'),
      ($2, 'r@x.test', 'Builder', 'agent')`,
    [USER, AGENT]
  );
  await h.client!.query(
    `insert into playbooks (id, workspace_id, created_by, name, goal_template, params, input_strategy, channel_spec, expected_outputs, stages, criteria, required_intents, version, executor, status)
     values ($1, null, $2, 'Design a screen', 'Design {{design}}', $3::jsonb, '{"kind":"none"}'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 1, 'is-agent', 'active')`,
    [
      PLAYBOOK,
      USER,
      JSON.stringify([
        { name: "design", label: "UI design", type: "text", required: true },
      ]),
    ]
  );
}, 120_000);

const start = (goal: string, extra: Record<string, unknown>) =>
  createFocusSession({
    userId: USER,
    goal,
    templateId: PLAYBOOK,
    matchTemplate: false,
    forceCreate: true,
    ...extra,
  });

describe("createFocusSession — a missing playbook param an agent left out", () => {
  it("is REFUSED to the agent, naming the param; nothing is created", async () => {
    const goal = `Design the inbox ${randomUUID()}`;
    await expect(start(goal, { agentUserId: AGENT })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(
        /"Design a screen" needs "design" \(text\)\. Nothing was started/
      ),
    });
    expect(await sessions(goal)).toEqual([]);
  });

  it("an agent that supplies it starts the session, with no param slot", async () => {
    const goal = `Design the inbox ${randomUUID()}`;
    const res = await start(goal, {
      agentUserId: AGENT,
      params: { design: "the inbox" },
    });
    expect(res.status).toBe("created");
    const [row] = await sessions(goal);
    expect(row!.id).toBe(sessionId(res));
    expect(
      row!.expected_outputs.filter((o) => o.kind === PARAM_SLOT_KIND)
    ).toEqual([]);
  });

  it("CONTROL — a person's own start still owes it as their slot", async () => {
    const goal = `Design the inbox ${randomUUID()}`;
    const res = await start(goal, {});
    expect(res.status).toBe("created");
    const [row] = await sessions(goal);
    expect(
      row!.expected_outputs.find((o) => o.kind === PARAM_SLOT_KIND)
    ).toMatchObject({ label: "Answer: UI design", owner: "human" });
  });
});
