/**
 * `runs.recentByFlows` carries each run's SESSION (W2 review): the door a
 * `waiting_on_you` mark opens to its owed slot. Real SQL on PGlite — the
 * automation half is a correlated subquery on `metadata.automationRunId`,
 * which only a real engine can confirm; the playbook half is the column.
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
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client) };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  workspaces,
  workspaceMembers,
  playbooks,
  playbookRuns,
  automations,
  automationRuns,
  focusSessions,
  podMembers,
  users,
  projectMembers,
} from "@synap/database/schema";
import { listRecentRunsByFlows } from "../recent-by-flows.js";

type ColumnLike = {
  name: string;
  hasDefault: boolean;
  default: unknown;
  getSQLType(): string;
};

/** DDL derived from the REAL Drizzle config (no NOT NULLs, no FKs). */
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = (cfg.columns as unknown as ColumnLike[]).map((c) => {
    const raw = c.getSQLType();
    const isArray = raw.endsWith("[]");
    const base = raw.replace(/\[\]$/, "").replace(/\(.*\)/, "");
    const type =
      /^(text|uuid|jsonb|boolean|integer|timestamp with time zone|timestamp)$/.test(
        base
      )
        ? base
        : "text";
    let def = "";
    if (c.hasDefault) {
      const d = c.default;
      if (isArray) def = " default '{}'";
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
      else if (typeof d === "string")
        def = ` default '${d.replace(/'/g, "''")}'`;
      else if (d && typeof d === "object" && !("queryChunks" in d))
        def = ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
      else if (type === "uuid") def = " default gen_random_uuid()";
      else if (type.startsWith("timestamp")) def = " default now()";
    }
    return `"${c.name}" ${type}${isArray ? "[]" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const USER = "user-recent";
const AUTO = randomUUID();
const PB = randomUUID();
const RUN_WITH = randomUUID();
const RUN_WITHOUT = randomUUID();
const PB_RUN = randomUUID();
const SESSION_A = randomUUID();
const SESSION_P = randomUUID();

beforeAll(async () => {
  for (const t of [
    workspaces,
    workspaceMembers,
    playbooks,
    playbookRuns,
    automations,
    automationRuns,
    focusSessions,
    podMembers,
    users,
    projectMembers,
  ])
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  await h.client!.exec(
    `insert into users (id, email) values ('${USER}', '${USER}@example.test')`
  );
  await h.client!.query(
    `insert into automations (id, name) values ($1, 'Enrich')`,
    [AUTO]
  );
  await h.client!.query(
    `insert into playbooks (id, name) values ($1, 'Onboard')`,
    [PB]
  );
  await h.client!.query(
    `insert into automation_runs (id, automation_id, workspace_id, status, started_at)
     values ($1, $3, null, 'waiting_on_you', now() - interval '1 hour'),
            ($2, $3, null, 'completed', now() - interval '2 hours')`,
    [RUN_WITH, RUN_WITHOUT, AUTO]
  );
  await h.client!.query(
    `insert into focus_sessions (id, user_id, goal, status, metadata)
     values ($1, $2, 'g', 'active', jsonb_build_object('automationRunId', $3::text))`,
    [SESSION_A, USER, RUN_WITH]
  );
  await h.client!.query(
    `insert into playbook_runs (id, playbook_id, workspace_id, session_id, status, started_at)
     values ($1, $2, null, $3, 'waiting_on_you', now())`,
    [PB_RUN, PB, SESSION_P]
  );
}, 120_000);

describe("recentByFlows sessionId", () => {
  it("carries the run's session for both ledgers, null when there is none", async () => {
    const histories = await listRecentRunsByFlows({
      userId: USER,
      flows: [
        { flowType: "automation", flowId: AUTO },
        { flowType: "playbook", flowId: PB },
      ],
    });
    const runs = new Map(
      histories.flatMap((h) => h.runs).map((r) => [r.id, r.sessionId])
    );
    expect(runs.get(RUN_WITH)).toBe(SESSION_A);
    expect(runs.get(RUN_WITHOUT)).toBeNull();
    expect(runs.get(PB_RUN)).toBe(SESSION_P);
  });
});
