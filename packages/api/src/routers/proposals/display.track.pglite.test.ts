/**
 * TRACK RECORD on the proposal wire — `enrichProposalsForDisplay` attaches
 * `track` (the flow's measured run history) to a playbook session start and an
 * automation run, driven through the REAL function on PGlite with the real
 * visibility predicates executed as SQL.
 *
 * What it pins:
 *   - the value ARRIVES on the row (reachability, not a declared key);
 *   - a flow the viewer cannot see gets NO track (the same floor as its name);
 *   - runs in a workspace the viewer cannot see are not counted;
 *   - a visible flow that never ran is a measured zero, not an absence;
 *   - kinds that rerun no flow — and `capability.run`, whose ledger cannot
 *     record a failed direct run — carry no track;
 *   - a session row carries one only when it STARTS the session: an update
 *     or a stage gate on a live session reruns nothing;
 *   - the record is measured over the flow's most recent
 *     `PROPOSAL_TRACK_RUN_WINDOW` runs, and `runs` states that sample.
 *
 * What it CANNOT see: production Postgres constraints (tables are generated
 * without FKs / NOT NULL / enums) and the list/get access-check on the
 * proposal itself, which sits above this function.
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
  return { ...actual, db: drizzle(client) };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { PROPOSAL_TRACK_RUN_WINDOW } from "@synap-core/types/proposals";
import { enrichProposalsForDisplay } from "./display.js";

const VIEWER = "viewer-track";
const OTHER = "other-track";
const WS_SEEN = randomUUID();
const WS_HIDDEN = randomUUID();
const id = () => randomUUID();
const PLAYBOOK_SEEN = id();
const PLAYBOOK_NEVER_RAN = id();
const PLAYBOOK_HIDDEN = id();
const AUTOMATION_SEEN = id();
const AUTOMATION_BUSY = id();
const SKILL_SEEN = id();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);
const MIN = 60_000;
const at = (min: number) => new Date(Date.UTC(2026, 0, 1) + min * MIN);

function proposalRow(over: Record<string, unknown>) {
  const now = new Date();
  return {
    id: id(),
    status: "pending",
    proposalType: "create",
    targetType: "entity",
    targetId: id(),
    data: {},
    workspaceId: WS_SEEN,
    projectId: null,
    threadId: null,
    sessionId: null,
    correlationId: null,
    agentUserId: null,
    subjectUserId: null,
    createdBy: VIEWER,
    reviewedBy: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  } as never;
}

async function trackOf(over: Record<string, unknown>) {
  const [row] = await enrichProposalsForDisplay([proposalRow(over)], VIEWER);
  return (row as unknown as { track?: Record<string, unknown> }).track;
}

async function run(
  table: "playbook_runs" | "automation_runs",
  flowCol: "playbook_id" | "automation_id",
  flowId: string,
  status: string,
  startMin: number,
  durMin: number | null,
  ws: string = WS_SEEN
) {
  await q(
    `insert into ${table} (id, ${flowCol}, workspace_id, status, started_at, completed_at) values ($1,$2,$3,$4,$5,$6)`,
    [
      id(),
      flowId,
      ws,
      status,
      at(startMin).toISOString(),
      durMin === null ? null : at(startMin + durMin).toISOString(),
    ]
  );
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(
    `insert into workspaces (id, name, owner_id) values ($1,'Seen WS',$3),($2,'Hidden WS',$4)`,
    [WS_SEEN, WS_HIDDEN, VIEWER, OTHER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner'),($4,$5,$6,'owner')`,
    [id(), WS_SEEN, VIEWER, id(), WS_HIDDEN, OTHER]
  );
  await q(
    `insert into playbooks (id, name, goal_template, workspace_id) values
      ($1,'CRM Hygiene','g',$2),($3,'Never ran','g',$2),($4,'Hidden playbook','g',$5)`,
    [PLAYBOOK_SEEN, WS_SEEN, PLAYBOOK_NEVER_RAN, PLAYBOOK_HIDDEN, WS_HIDDEN]
  );
  await q(
    `insert into automations (id, name, workspace_id) values ($1,'Daily briefing',$2),($3,'Busy sync',$2)`,
    [AUTOMATION_SEEN, WS_SEEN, AUTOMATION_BUSY]
  );
  // Busy sync: 2 OLD failed runs, then a full window of newer completed runs.
  // Only the newest PROPOSAL_TRACK_RUN_WINDOW may be measured.
  await q(
    `insert into automation_runs (id, automation_id, workspace_id, status, started_at, completed_at)
     select gen_random_uuid(), $1, $2,
            case when g <= 2 then 'failed' else 'completed' end,
            $3::timestamptz + (g || ' minutes')::interval,
            $3::timestamptz + (g || ' minutes')::interval + interval '1 minute'
     from generate_series(1, $4::int + 2) g`,
    [AUTOMATION_BUSY, WS_SEEN, at(0).toISOString(), PROPOSAL_TRACK_RUN_WINDOW]
  );
  await q(
    `insert into skills (id, name, slug, user_id, scope) values ($1,'Seen skill','seen',$2,'user')`,
    [SKILL_SEEN, VIEWER]
  );

  // CRM Hygiene: 3 failed runs the viewer can see + 1 completed run in a
  // workspace the viewer CANNOT see (must not be counted, nor sampled).
  for (const m of [0, 10, 20])
    await run("playbook_runs", "playbook_id", PLAYBOOK_SEEN, "failed", m, 1);
  await run(
    "playbook_runs",
    "playbook_id",
    PLAYBOOK_SEEN,
    "completed",
    30,
    9,
    WS_HIDDEN
  );
  await run(
    "playbook_runs",
    "playbook_id",
    PLAYBOOK_HIDDEN,
    "completed",
    0,
    2,
    WS_HIDDEN
  );

  // Daily briefing: 3 completed (4, 6, 8 min) → median 6, last 8.
  await run(
    "automation_runs",
    "automation_id",
    AUTOMATION_SEEN,
    "completed",
    0,
    4
  );
  await run(
    "automation_runs",
    "automation_id",
    AUTOMATION_SEEN,
    "completed",
    10,
    6
  );
  await run(
    "automation_runs",
    "automation_id",
    AUTOMATION_SEEN,
    "completed",
    20,
    8
  );
});

describe("enrichProposalsForDisplay — track record", () => {
  it("session start on a visible playbook: the measured record arrives, hidden-workspace runs excluded", async () => {
    const track = await trackOf({
      targetType: "focus_session",
      data: { changeType: "create", playbookId: PLAYBOOK_SEEN },
    });
    expect(track).toEqual({
      runs: 3,
      completed: 0,
      running: 0,
      durationSamples: 0,
    });
  });

  it("automation run: counts + median + last duration arrive", async () => {
    const track = await trackOf({
      targetType: "automation",
      proposalType: "execute",
      data: { automationId: AUTOMATION_SEEN },
    });
    expect(track).toMatchObject({
      runs: 3,
      completed: 3,
      durationSamples: 3,
      medianDurationMs: 6 * MIN,
      lastDurationMs: 8 * MIN,
    });
  });

  it("a visible playbook that never ran is a MEASURED zero", async () => {
    const track = await trackOf({
      targetType: "focus_session",
      data: { changeType: "create", playbookId: PLAYBOOK_NEVER_RAN },
    });
    expect(track).toEqual({
      runs: 0,
      completed: 0,
      running: 0,
      durationSamples: 0,
    });
  });

  it("FLOOR: a playbook the viewer cannot see gets no track (its runs are no oracle)", async () => {
    const track = await trackOf({
      targetType: "focus_session",
      data: { changeType: "create", playbookId: PLAYBOOK_HIDDEN },
    });
    expect(track).toBeUndefined();
  });

  it("kinds that rerun no flow carry no track", async () => {
    expect(
      await trackOf({
        targetType: "automation",
        proposalType: "update",
        data: { automationId: AUTOMATION_SEEN },
      })
    ).toBeUndefined();
    expect(
      await trackOf({
        targetType: "capability",
        proposalType: "capability.run",
        data: { skillId: SKILL_SEEN },
      })
    ).toBeUndefined();
  });

  it("a session row that does not START the session carries no track", async () => {
    // The start is the positive control: the same playbook, a create.
    expect(
      await trackOf({
        targetType: "focus_session",
        data: { changeType: "create", playbookId: PLAYBOOK_SEEN },
      })
    ).toMatchObject({ runs: 3 });
    for (const changeType of ["update", "stage_gate", "grant_capability"]) {
      expect(
        await trackOf({
          targetType: "focus_session",
          proposalType: changeType,
          data: { changeType, playbookId: PLAYBOOK_SEEN },
        })
      ).toBeUndefined();
    }
  });

  it("is measured over the flow's most recent window, and says so in `runs`", async () => {
    const track = await trackOf({
      targetType: "automation",
      proposalType: "execute",
      data: { automationId: AUTOMATION_BUSY },
    });
    // 102 runs exist; the 2 oldest (failed) fall outside the window.
    expect(PROPOSAL_TRACK_RUN_WINDOW).toBe(100);
    expect(track).toMatchObject({
      runs: PROPOSAL_TRACK_RUN_WINDOW,
      completed: PROPOSAL_TRACK_RUN_WINDOW,
      durationSamples: PROPOSAL_TRACK_RUN_WINDOW,
    });
  });

  it("batches: two rows on the same flow get the same record from one read", async () => {
    const rows = await enrichProposalsForDisplay(
      [
        proposalRow({
          targetType: "automation",
          proposalType: "execute",
          data: { automationId: AUTOMATION_SEEN },
        }),
        proposalRow({
          targetType: "automation",
          proposalType: "execute",
          data: { automationId: AUTOMATION_SEEN },
        }),
      ],
      VIEWER
    );
    const tracks = rows.map(
      (r) => (r as unknown as { track?: { runs: number } }).track?.runs
    );
    expect(tracks).toEqual([3, 3]);
  });
});
