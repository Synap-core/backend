/**
 * `automations.trigger` returns a run id and the worker opens the run's focus
 * session LATER (`automation-execute`, pg-boss), so the session id cannot ride
 * on the trigger reply without a race. The honest door is the run's own detail:
 * `getRun({flowType:"automation"})` reads `sessionId` from the session the
 * worker stamped (`focus_sessions.metadata.automationRunId`), through the one
 * session read rule (D1: a session is content, `sessionReadableWhere`).
 *
 * Driven through the REAL service on PGlite. What it CANNOT see: production
 * Postgres (tables are generated from the Drizzle definitions without FKs,
 * NOT NULL or enums), and the worker itself (the stamp is inserted by hand
 * exactly as `openRunSession` writes it).
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
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
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, {
    schema: {
      focusSessions: actual.focusSessions as never,
      workspaceMembers: actual.workspaceMembers as never,
      workspaces: actual.workspaces as never,
    },
  });
  return { ...actual, db, getDb: async () => db };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { getRun } from "../index.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

const OWNER = "owner-run-session";
const COLLEAGUE = "colleague-run-session";
const WS = randomUUID();
const AUTOMATION = randomUUID();
const RUN_WITH_SESSION = randomUUID();
const RUN_NOT_OPENED = randomUUID();
const RUN_SKIPPED = randomUUID();
const SESSION = randomUUID();
const ROOM = randomUUID();

const HUMAN = { roster: true } as const;

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const n of [
    "automations",
    "automation_runs",
    "automation_step_runs",
    "focus_sessions",
    "channels",
    "channel_members",
    "users",
    "workspaces",
    "workspace_members",
  ]) {
    expect(byName.has(n), `table ${n}`).toBe(true);
  }
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  for (const u of [OWNER, COLLEAGUE]) {
    await q(`insert into users (id, user_type) values ($1, 'human')`, [u]);
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'editor')`,
      [randomUUID(), WS, u]
    );
  }
  await q(`insert into workspaces (id, name, owner_id) values ($1, 'W', $2)`, [
    WS,
    OWNER,
  ]);
  await q(
    `insert into automations (id, name, workspace_id, created_by, status, trigger_type, version, created_at, updated_at)
     values ($1, 'Daily recap', $2, $3, 'active', 'manual', 1, now(), now())`,
    [AUTOMATION, WS, OWNER]
  );
  for (const run of [RUN_WITH_SESSION, RUN_NOT_OPENED, RUN_SKIPPED]) {
    await q(
      `insert into automation_runs (id, automation_id, workspace_id, triggered_by, status, trigger_payload, started_at)
       values ($1, $2, $3, $4, $5, '{}'::jsonb, now())`,
      [run, AUTOMATION, WS, OWNER, run === RUN_SKIPPED ? "skipped" : "running"]
    );
  }
  // What `openRunSession` writes: the run id on `metadata.automationRunId`,
  // the session's own minted room (FK + stamp) for the roster branch.
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, goal, status, metadata, channel_id, created_at, updated_at, started_at)
     values ($1, $2, $3, 'Daily recap', 'active', $4::jsonb, $5, now(), now(), now())`,
    [
      SESSION,
      OWNER,
      WS,
      JSON.stringify({
        source: "automation",
        automationRunId: RUN_WITH_SESSION,
      }),
      ROOM,
    ]
  );
  await q(
    `insert into channels (id, user_id, workspace_id, channel_type, context_object_type, context_object_id, created_at, updated_at)
     values ($1, $2, $3, 'group', 'focus_session', $4, now(), now())`,
    [ROOM, OWNER, WS, SESSION]
  );
});

describe("getRun automation: the session the run opened", () => {
  it("names the session the worker stamped with this run", async () => {
    const detail = await getRun({
      userId: OWNER,
      flowType: "automation",
      id: RUN_WITH_SESSION,
      ...HUMAN,
    });
    expect(detail?.run.flowType).toBe("automation");
    expect(detail && "sessionId" in detail ? detail.sessionId : undefined).toBe(
      SESSION
    );
  });

  it("is null until the worker has opened it (the trigger reply came first)", async () => {
    const detail = await getRun({
      userId: OWNER,
      flowType: "automation",
      id: RUN_NOT_OPENED,
      ...HUMAN,
    });
    expect(detail && "sessionId" in detail ? detail.sessionId : "absent").toBe(
      null
    );
  });

  it("is null for a run that never opens one (a skipped precondition)", async () => {
    const detail = await getRun({
      userId: OWNER,
      flowType: "automation",
      id: RUN_SKIPPED,
      ...HUMAN,
    });
    expect(detail && "sessionId" in detail ? detail.sessionId : "absent").toBe(
      null
    );
  });

  it("never hands a session id to a workspace member who may not read the session (D1)", async () => {
    // COLLEAGUE sees the run (workspace member) but the session is content
    // owned by OWNER, on a room COLLEAGUE has no seat in.
    const detail = await getRun({
      userId: COLLEAGUE,
      flowType: "automation",
      id: RUN_WITH_SESSION,
      ...HUMAN,
    });
    expect(detail).not.toBeNull();
    expect(detail && "sessionId" in detail ? detail.sessionId : "absent").toBe(
      null
    );
  });
});
