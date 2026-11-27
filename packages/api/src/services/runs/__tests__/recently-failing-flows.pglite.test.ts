/**
 * `listRecentlyFailingFlows` — the narrow read behind whole-pod health
 * (`diagnose.global`): only flows that FAILED inside the health window, with
 * the same numbers, order, floor and lens `listRunGroups` gives those flows.
 *
 * PGLITE, not mocks: the read is a grouped query with two correlated
 * subqueries (newest start, any running run) and a `now()`-relative window;
 * only a real engine decides what they return.
 *
 * Fixture flows (each one a case a wrong rule would get wrong):
 *   AU_FAILING  — old completed runs, 2 recent failures, a NEWER clean run
 *                 → failing, count 2, latest = the clean run (all runs, not
 *                   just the failures)
 *   AU_OLD_FAIL — failed 30 days ago, clean since → absent
 *   AU_BLOCKED  — a recent blocked_by_policy → absent (not a failure)
 *   PB_RUNNING  — failed 2 days ago + a run STARTED 10 days ago still running
 *                 → hasRunning true (a running run of any age)
 *   PB_LONG     — a failure that started 9 days ago and ended 3 days ago
 *                 → failing (dated by coalesce(completedAt, startedAt))
 *   PB_CLEAN    — recent completed only, the most recently active flow → absent
 *   PB_HIDDEN   — a recent failure in a workspace the user cannot see → absent
 *   PB_LENS     — a recent failure in the user's own workspace (lens case)
 *   PB_BUDGET   — recent runs that only STOPPED at their budget (`failed` +
 *                 stop_reason `budget`) → absent; counted in stoppedCount
 *   AU_MIXED    — a budget stop, a real failure and a `stages_left` failure
 *                 → failing, count 2 (the budget stop is not a failure)
 *
 * WHAT THESE TESTS CANNOT SEE: index use and cost (measured on the live pod,
 * EXPLAIN in the PR); the `diagnose` summary wording (diagnose.test.ts).
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
  apiKeys,
  playbooks,
  playbookRuns,
  automations,
  automationRuns,
  podMembers,
  users,
  projectMembers,
} from "@synap/database/schema";
import { listRecentlyFailingFlows, listRunGroups } from "../index.js";

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

const USER = "user-failing";
const MY_WS = randomUUID();
const STRANGER_WS = randomUUID();
const AU_FAILING = randomUUID();
const AU_OLD_FAIL = randomUUID();
const AU_BLOCKED = randomUUID();
const PB_RUNNING = randomUUID();
const PB_LONG = randomUUID();
const PB_CLEAN = randomUUID();
const PB_HIDDEN = randomUUID();
const PB_LENS = randomUUID();
const PB_BUDGET = randomUUID();
const AU_MIXED = randomUUID();

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Relative to the real clock: the window is `now()` in SQL. */
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

async function run(
  ledger: "automation" | "playbook",
  flowId: string,
  status: string,
  startedAgo: number,
  completedAgo: number | null,
  workspaceId: string | null = null,
  stopReason: string | null = null
) {
  const [table, col] =
    ledger === "automation"
      ? ["automation_runs", "automation_id"]
      : ["playbook_runs", "playbook_id"];
  await h.client!.query(
    `insert into ${table} (id, ${col}, workspace_id, status, started_at, completed_at, stop_reason)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, $6)`,
    [
      flowId,
      workspaceId,
      status,
      ago(startedAgo),
      completedAgo === null ? null : ago(completedAgo),
      stopReason,
    ]
  );
}

beforeAll(async () => {
  for (const t of [
    workspaces,
    workspaceMembers,
    apiKeys,
    playbooks,
    playbookRuns,
    automations,
    automationRuns,
    podMembers,
    users,
    projectMembers,
  ]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
  // A KNOWN principal: an unknown one reads no pod-level row.
  await h.client!.exec(
    `insert into users (id, email) values ('${USER}', '${USER}@example.test')`
  );
  await h.client!.query(
    `insert into workspaces (id, name, owner_id) values ($1, 'Mine', $2)`,
    [MY_WS, USER]
  );
  await h.client!.query(
    `insert into workspaces (id, name, owner_id) values ($1, 'Theirs', 'someone-else')`,
    [STRANGER_WS]
  );
  for (const [id, name] of [
    [AU_FAILING, "Inbox triage"],
    [AU_OLD_FAIL, "Old failure"],
    [AU_BLOCKED, "Blocked"],
    [AU_MIXED, "Mixed"],
  ]) {
    await h.client!.query(
      `insert into automations (id, name) values ($1, $2)`,
      [id, name]
    );
  }
  for (const [id, name] of [
    [PB_RUNNING, "Running"],
    [PB_LONG, "Long"],
    [PB_CLEAN, "Clean"],
    [PB_HIDDEN, "Hidden"],
    [PB_LENS, "Lens"],
    [PB_BUDGET, "Budget"],
  ]) {
    await h.client!.query(`insert into playbooks (id, name) values ($1, $2)`, [
      id,
      name,
    ]);
  }

  for (let i = 0; i < 5; i++) {
    const started = 40 * DAY + i * HOUR;
    await run("automation", AU_FAILING, "completed", started, 40 * DAY);
  }
  await run("automation", AU_FAILING, "failed", 2 * DAY, 2 * DAY - HOUR);
  await run("automation", AU_FAILING, "failed", 1 * DAY, 1 * DAY - HOUR);
  // The newest run of the flow, and a clean one.
  await run("automation", AU_FAILING, "completed", 3 * HOUR, 2 * HOUR);

  await run("automation", AU_OLD_FAIL, "failed", 30 * DAY, 30 * DAY);
  await run("automation", AU_OLD_FAIL, "completed", 5 * HOUR, 5 * HOUR);

  await run("automation", AU_BLOCKED, "blocked_by_policy", 4 * HOUR, 4 * HOUR);

  await run("playbook", PB_RUNNING, "running", 10 * DAY, null);
  await run("playbook", PB_RUNNING, "failed", 2 * DAY, 2 * DAY);

  await run("playbook", PB_LONG, "failed", 9 * DAY, 3 * DAY);

  await run("playbook", PB_CLEAN, "completed", 1 * HOUR, 1 * HOUR);

  await run("playbook", PB_HIDDEN, "failed", 1 * DAY, 1 * DAY, STRANGER_WS);

  await run("playbook", PB_LENS, "failed", 6 * HOUR, 6 * HOUR, MY_WS);

  await run("playbook", PB_BUDGET, "failed", 2 * DAY, 2 * DAY, null, "budget");
  await run("playbook", PB_BUDGET, "failed", 1 * DAY, 1 * DAY, null, "budget");

  await run("automation", AU_MIXED, "failed", 7 * DAY, 7 * DAY, null, "budget");
  await run("automation", AU_MIXED, "failed", 6 * DAY, 6 * DAY);
  await run("automation", AU_MIXED, "failed", 5 * DAY, 5 * DAY, null, "stages_left");
});

describe("listRecentlyFailingFlows — only what diagnose shows", () => {
  it("NON-VACUITY: the failing fixture flows are reachable, in newest-active order", async () => {
    const flows = await listRecentlyFailingFlows({ userId: USER });
    expect(flows.map((f) => f.flowId)).toEqual([
      AU_FAILING, // newest start 3 h ago
      PB_LENS, // 6 h ago
      PB_RUNNING, // 2 days ago (the running run started 10 days ago)
      AU_MIXED, // 5 days ago
      PB_LONG, // 9 days ago
    ]);
  });

  it("counts only the window's failures, and dates the flow by its newest run of ANY status", async () => {
    const [f] = (await listRecentlyFailingFlows({ userId: USER })).filter(
      (x) => x.flowId === AU_FAILING
    );
    expect(f).toMatchObject({
      flowType: "automation",
      flowName: "Inbox triage",
      recentFailedCount: 2,
      hasRunning: false,
    });
    expect(Date.now() - f!.latestStartedAt.getTime()).toBeLessThan(
      3 * HOUR + 10 * 60_000
    );
  });

  it("excludes old failures, policy blocks and clean flows", async () => {
    const ids = (await listRecentlyFailingFlows({ userId: USER })).map(
      (f) => f.flowId
    );
    expect(ids).not.toContain(AU_OLD_FAIL);
    expect(ids).not.toContain(AU_BLOCKED);
    expect(ids).not.toContain(PB_CLEAN);
  });

  it("a run that STOPPED at its budget is not a failure: a flow of only budget stops is not failing", async () => {
    const ids = (await listRecentlyFailingFlows({ userId: USER })).map(
      (f) => f.flowId
    );
    expect(ids).not.toContain(PB_BUDGET);
    const [g] = (await listRunGroups({ userId: USER, limit: 100 })).filter(
      (x) => x.flowId === PB_BUDGET
    );
    expect(g).toMatchObject({
      runCount: 2,
      failedCount: 0,
      recentFailedCount: 0,
      stoppedCount: 2,
    });
  });

  it("a real failure still counts next to a budget stop (stages_left is a fault)", async () => {
    const f = (await listRecentlyFailingFlows({ userId: USER })).find(
      (x) => x.flowId === AU_MIXED
    );
    expect(f).toMatchObject({ recentFailedCount: 2 });
    const [g] = (await listRunGroups({ userId: USER, limit: 100 })).filter(
      (x) => x.flowId === AU_MIXED
    );
    expect(g).toMatchObject({
      runCount: 3,
      failedCount: 2,
      recentFailedCount: 2,
      stoppedCount: 1,
    });
  });

  it("hasRunning reads a running run of any age, not only recent ones", async () => {
    const f = (await listRecentlyFailingFlows({ userId: USER })).find(
      (x) => x.flowId === PB_RUNNING
    );
    expect(f).toMatchObject({ hasRunning: true, recentFailedCount: 1 });
  });

  it("a long failure is dated by when it ENDED (coalesce(completedAt, startedAt))", async () => {
    const f = (await listRecentlyFailingFlows({ userId: USER })).find(
      (x) => x.flowId === PB_LONG
    );
    expect(f).toMatchObject({ recentFailedCount: 1, hasRunning: false });
  });

  it("FLOOR: a failure in a workspace the user cannot see is not shown", async () => {
    const ids = (await listRecentlyFailingFlows({ userId: USER })).map(
      (f) => f.flowId
    );
    expect(ids).not.toContain(PB_HIDDEN);
  });

  it("LENS: a workspace scope narrows to that workspace's runs", async () => {
    const flows = await listRecentlyFailingFlows({
      userId: USER,
      scope: { workspaceId: MY_WS },
    });
    expect(flows.map((f) => f.flowId)).toEqual([PB_LENS]);
  });

  it("PARITY: the same rows, numbers and order as listRunGroups' failing groups", async () => {
    const project = (g: {
      flowType: string;
      flowId: string;
      flowName: string;
      recentFailedCount: number;
      hasRunning: boolean;
      latestStartedAt: Date;
    }) => ({
      flowType: g.flowType,
      flowId: g.flowId,
      flowName: g.flowName,
      recentFailedCount: g.recentFailedCount,
      hasRunning: g.hasRunning,
      latestStartedAt: g.latestStartedAt.getTime(),
    });
    for (const scope of [undefined, { workspaceId: MY_WS }]) {
      const wide = (await listRunGroups({ userId: USER, scope, limit: 100 }))
        .filter((g) => g.recentFailedCount > 0)
        .map(project);
      const narrow = (
        await listRecentlyFailingFlows({ userId: USER, scope, limit: 100 })
      ).map(project);
      expect(wide.length).toBeGreaterThan(0);
      expect(narrow).toEqual(wide);
    }
  });

  it("the limit applies to FAILING flows: a busier clean flow cannot push one out", async () => {
    // listRunGroups({limit: 1}) keeps only the most recently active flow
    // (PB_CLEAN, 1 h ago) and so shows no failing flow at all.
    const busiest = await listRunGroups({ userId: USER, limit: 1 });
    expect(busiest.map((g) => g.flowId)).toEqual([PB_CLEAN]);
    const flows = await listRecentlyFailingFlows({ userId: USER, limit: 1 });
    expect(flows.map((f) => f.flowId)).toEqual([AU_FAILING]);
  });

  it("a failed read THROWS — never an empty 'nothing is failing'", async () => {
    await h.client!.exec(`alter table playbook_runs rename to pr_gone`);
    try {
      await expect(
        listRecentlyFailingFlows({ userId: USER })
      ).rejects.toThrow();
    } finally {
      await h.client!.exec(`alter table pr_gone rename to playbook_runs`);
    }
  });
});
