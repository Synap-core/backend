/**
 * `diagnose` run arm — per-automation AI dispatch and CHILD failure counts.
 *
 * The incident's parent runs read `completed` while the playbook runs they
 * started failed; these counts come from the children, so a rule whose
 * children fail is visible even when its own run rows look healthy.
 *
 * Real SQL on PGlite: `automationDispatchFootprints` over automations,
 * automation_runs, focus_sessions and playbook_runs. Each count is paired with
 * a row that must NOT be counted (out of window, another rule, a live child).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
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
  return { ...actual, db: drizzle(client) };
});

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { automationDispatchFootprints } from "../automation-dispatch.js";
import { AI_DISPATCH_GUARDRAILS } from "@synap-core/types/automations";

const USER = "11111111-1111-4111-8111-111111111111";
const WS = "22222222-2222-4222-8222-222222222222";
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = t.endsWith("[]")
      ? t
      : BASIC.test(t)
        ? t.replace(/\(.*\)/, "")
        : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

async function automation(name: string, triggerConfig = {}): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into automations (id, workspace_id, created_by, name, trigger_type, trigger_config, flow_definition, status)
     values ($1, $2, $3, $4, 'cron', $5::jsonb, '{}'::jsonb, 'active')`,
    [id, WS, USER, name, JSON.stringify(triggerConfig)]
  );
  return id;
}
async function run(automationId: string, hoursAgo: number, ai: number) {
  const id = randomUUID();
  await q(
    `insert into automation_runs (id, automation_id, workspace_id, status, ai_dispatch_count, started_at)
     values ($1, $2, $3, 'completed', $4, now() - ($5::int * interval '1 hour'))`,
    [id, automationId, WS, ai, hoursAgo]
  );
  return id;
}
async function child(parentRunId: string, status: string) {
  const sessionId = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, metadata) values ($1, $2, 'g', 'closed', $3::jsonb)`,
    [sessionId, USER, JSON.stringify({ automationRunId: parentRunId })]
  );
  await q(
    `insert into playbook_runs (id, playbook_id, session_id, status, started_at) values ($1, $2, $3, $4, now())`,
    [randomUUID(), randomUUID(), sessionId, status]
  );
}

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value as PgTable));
  }
  await q(
    "insert into workspace_members (id, workspace_id, user_id, role) values (gen_random_uuid(), $1, $2, 'owner')",
    [WS, USER]
  );
  await q("insert into workspaces (id, owner_id, name) values ($1, $2, 'ws')", [
    WS,
    USER,
  ]);
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    "delete from automations; delete from automation_runs; delete from focus_sessions; delete from playbook_runs;"
  );
});

describe("automationDispatchFootprints", () => {
  it("counts AI dispatches in 24h and child runs / failures in 7d, per automation", async () => {
    const runaway = await automation("Assess every company");
    const r1 = await run(runaway, 2, 20);
    const r2 = await run(runaway, 5, 5);
    await run(runaway, 48, 99); // outside the 24h dispatch window, inside 7d
    await child(r1, "failed");
    await child(r1, "failed");
    await child(r2, "completed");
    await child(r2, "running");

    const quiet = await automation("Quiet", { maxAiDispatchesPerDay: 7 });
    const q1 = await run(quiet, 1, 1);
    await child(q1, "completed");

    await automation("Never ran"); // no run in 7d → not listed

    const rows = await automationDispatchFootprints({ userId: USER });
    expect(rows.map((r) => r.name)).toEqual(["Assess every company", "Quiet"]);
    expect(rows[0]).toMatchObject({
      automationId: runaway,
      aiDispatches24h: 25,
      aiDispatchCapPerDay: AI_DISPATCH_GUARDRAILS.maxAiDispatchesPerDayDefault,
      childRuns7d: 4,
      childFailed7d: 2,
    });
    expect(rows[1]).toMatchObject({
      aiDispatches24h: 1,
      aiDispatchCapPerDay: 7,
      childRuns7d: 1,
      childFailed7d: 0,
    });
  });

  it("narrows to one workspace", async () => {
    const a = await automation("Mine");
    await run(a, 1, 1);
    const rows = await automationDispatchFootprints({
      userId: USER,
      workspaceId: randomUUID(),
    });
    expect(rows).toEqual([]);
  });
});
