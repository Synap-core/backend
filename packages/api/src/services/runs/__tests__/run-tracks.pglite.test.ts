/**
 * TRACK RECORD — `listRunTracks`, the run-group aggregate narrowed to named
 * flows, including the MEASURED duration sample (median + last).
 *
 * PGLITE, not mocks: `percentile_cont … within group … filter (where …)` and
 * the `array_agg … filter` last-duration are ordered-set / filtered aggregates
 * whose meaning only a real engine decides. A mocked `db.select()` would pass
 * on SQL that Postgres rejects or answers differently.
 *
 * Fixture flows (each one a case the renderer words differently):
 *   PB_NONE   — 3 runs, 0 completed (2 failed, 1 running) → no sample at all
 *   PB_ONE    — 1 completed run of 4 min                  → sample of one
 *   PB_MANY   — 3 completed (2, 6, 10 min) + 1 failed     → median 6 min
 *   PB_SKEW   — 1 completed with completedAt < startedAt  → excluded, not negative
 *   AU_MIX    — automation: 2 completed (1, 3 min), 1 blocked_by_policy
 *   PB_HIDDEN — runs only in a workspace the user cannot see → absent
 *
 * WHAT THESE TESTS CANNOT SEE: index use / cost; the producers that stamp
 * `completed_at` (asserted by the executors' own suites); the caller-side
 * NAME floor that decides which ids reach this function (display.ts).
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
  podMembers,
  users,
  projectMembers,
} from "@synap/database/schema";
import { listRunTracks, listRunGroups } from "../index.js";

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

const USER = "user-track";
const STRANGER_WS = randomUUID();
const PB_NONE = randomUUID();
const PB_ONE = randomUUID();
const PB_MANY = randomUUID();
const PB_SKEW = randomUUID();
const PB_HIDDEN = randomUUID();
const PB_NEVER = randomUUID();
const AU_MIX = randomUUID();

const MIN = 60_000;
const t0 = Date.UTC(2026, 0, 1);
const at = (ms: number) => new Date(t0 + ms).toISOString();

async function playbookRun(
  playbookId: string,
  status: string,
  startMin: number,
  durationMin: number | null,
  workspaceId: string | null = null
) {
  await h.client!.query(
    `insert into playbook_runs (id, playbook_id, workspace_id, status, started_at, completed_at)
     values (gen_random_uuid(), $1, $2, $3, $4, $5)`,
    [
      playbookId,
      workspaceId,
      status,
      at(startMin * MIN),
      durationMin === null ? null : at((startMin + durationMin) * MIN),
    ]
  );
}

async function automationRun(
  automationId: string,
  status: string,
  startMin: number,
  durationMin: number | null
) {
  await h.client!.query(
    `insert into automation_runs (id, automation_id, workspace_id, status, started_at, completed_at)
     values (gen_random_uuid(), $1, null, $2, $3, $4)`,
    [
      automationId,
      status,
      at(startMin * MIN),
      durationMin === null ? null : at((startMin + durationMin) * MIN),
    ]
  );
}

beforeAll(async () => {
  for (const t of [
    workspaces,
    workspaceMembers,
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
  // A KNOWN principal (Sites W2 S2): an id with no `users` row is an unknown
  // principal and reads no pod-level row (pod-wide globals, pod-visible
  // workspaces) — `podReaderWhere`. This fixture models provisioned users.
  await h.client!.exec(
    `insert into users (id, email) values ('${USER}', '${USER}@example.test')`
  );
  // The stranger's workspace: owned by someone else, not pod-visible.
  await h.client!.query(
    `insert into workspaces (id, name, owner_id) values ($1, 'Theirs', 'someone-else')`,
    [STRANGER_WS]
  );
  for (const [id, name] of [
    [PB_NONE, "CRM Hygiene"],
    [PB_ONE, "One"],
    [PB_MANY, "Many"],
    [PB_SKEW, "Skew"],
    [PB_HIDDEN, "Hidden"],
    [PB_NEVER, "Never"],
  ]) {
    await h.client!.query(`insert into playbooks (id, name) values ($1, $2)`, [
      id,
      name,
    ]);
  }
  await h.client!.query(
    `insert into automations (id, name) values ($1, 'Daily briefing')`,
    [AU_MIX]
  );

  await playbookRun(PB_NONE, "failed", 0, 5);
  await playbookRun(PB_NONE, "failed", 10, 5);
  await playbookRun(PB_NONE, "running", 20, null);

  await playbookRun(PB_ONE, "completed", 0, 4);

  await playbookRun(PB_MANY, "completed", 0, 2);
  await playbookRun(PB_MANY, "completed", 10, 10);
  await playbookRun(PB_MANY, "completed", 20, 6); // the newest completed
  await playbookRun(PB_MANY, "failed", 30, 1); // newer, but not in the sample

  await playbookRun(PB_SKEW, "completed", 10, -5);

  await playbookRun(PB_HIDDEN, "completed", 0, 3, STRANGER_WS);

  await automationRun(AU_MIX, "completed", 0, 1);
  await automationRun(AU_MIX, "completed", 10, 3);
  await automationRun(AU_MIX, "blocked_by_policy", 20, 0);
});

async function tracks() {
  return listRunTracks({
    userId: USER,
    playbookIds: [PB_NONE, PB_ONE, PB_MANY, PB_SKEW, PB_HIDDEN, PB_NEVER],
    automationIds: [AU_MIX],
  });
}

describe("listRunTracks — measured track record per flow", () => {
  it("NON-VACUITY: every visible fixture flow with a run is reachable", async () => {
    const map = await tracks();
    expect([...map.keys()].sort()).toEqual(
      [
        `playbook:${PB_NONE}`,
        `playbook:${PB_ONE}`,
        `playbook:${PB_MANY}`,
        `playbook:${PB_SKEW}`,
        `automation:${AU_MIX}`,
      ].sort()
    );
  });

  it("0 completed: counts are exact and there is NO duration — null, never 0", async () => {
    const g = (await tracks()).get(`playbook:${PB_NONE}`)!;
    expect(g).toMatchObject({
      runCount: 3,
      completedCount: 0,
      failedCount: 2,
      runningCount: 1,
      latestStatus: "running",
      durationSampleCount: 0,
      medianDurationMs: null,
      lastDurationMs: null,
    });
  });

  it("1 completed: a sample of one — median and last are that run", async () => {
    const g = (await tracks()).get(`playbook:${PB_ONE}`)!;
    expect(g).toMatchObject({
      runCount: 1,
      completedCount: 1,
      durationSampleCount: 1,
      medianDurationMs: 4 * MIN,
      lastDurationMs: 4 * MIN,
    });
  });

  it("several completed: the median over completed runs only; last = newest COMPLETED", async () => {
    const g = (await tracks()).get(`playbook:${PB_MANY}`)!;
    expect(g).toMatchObject({
      runCount: 4,
      completedCount: 3,
      failedCount: 1,
      latestStatus: "failed",
      durationSampleCount: 3,
      // median(2, 10, 6) = 6 — the 1-min failed run is not in the sample
      medianDurationMs: 6 * MIN,
      lastDurationMs: 6 * MIN,
    });
  });

  it("a completedAt before startedAt is excluded from the sample, never a negative duration", async () => {
    const g = (await tracks()).get(`playbook:${PB_SKEW}`)!;
    expect(g.completedCount).toBe(1);
    expect(g.durationSampleCount).toBe(0);
    expect(g.medianDurationMs).toBeNull();
  });

  it("automation ledger: blocked_by_policy counts as failed; median of (1, 3) = 2 min", async () => {
    const g = (await tracks()).get(`automation:${AU_MIX}`)!;
    expect(g).toMatchObject({
      runCount: 3,
      completedCount: 2,
      failedCount: 1,
      durationSampleCount: 2,
      medianDurationMs: 2 * MIN,
      lastDurationMs: 3 * MIN,
    });
  });

  it("FLOOR: runs in a workspace the user cannot see are not counted", async () => {
    expect((await tracks()).has(`playbook:${PB_HIDDEN}`)).toBe(false);
  });

  it("a flow with no runs is ABSENT (the caller reads absence as 'never ran')", async () => {
    expect((await tracks()).has(`playbook:${PB_NEVER}`)).toBe(false);
  });

  it("the unfiltered runs feed carries the same aggregate (one aggregator, not two)", async () => {
    const groups = await listRunGroups({ userId: USER });
    const many = groups.find((g) => g.flowId === PB_MANY)!;
    expect(many.medianDurationMs).toBe(6 * MIN);
    expect(groups.some((g) => g.flowId === PB_HIDDEN)).toBe(false);
  });
});
