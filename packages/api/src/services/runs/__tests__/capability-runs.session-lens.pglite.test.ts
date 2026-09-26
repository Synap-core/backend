/**
 * SESSION LENS — "every capability run that happened in this session".
 *
 * The data has always landed on two INDEXED columns and no reader asked for it:
 * a PROPOSED run stamps `proposals.session_id` (`proposals_session_id_idx`), a
 * DIRECT run — which has no proposal row at all — stamps `events.session_id`
 * (`idx_events_session_id`). `RunScope.sessionId` filters BOTH branches of
 * `listCapabilityRuns`.
 *
 * WHY PGLITE AND NOT MOCKS: the sibling suite (`capability-runs.test.ts`) mocks
 * `db.select()` and feeds rows in order, so it can only assert the SHAPE of a
 * WHERE clause — it would pass on a predicate that is built and then never
 * reaches Postgres, which is this repo's single most repeated defect. Here the
 * rows are INSERTed, the real Drizzle query builder emits real SQL, and a real
 * engine decides which rows come back. An assertion below is a statement about
 * reachability: the value arrives, or it does not.
 *
 * WHAT THESE TESTS CANNOT SEE, measured:
 *   - Index USE. PGlite plans over a handful of rows; the partial index
 *     `idx_events_session_id` is never exercised. These prove correctness of
 *     the predicate, never its cost.
 *   - The PRODUCERS. That `recordDirectCapabilityRun` / the MCP capability door
 *     actually stamp these two columns in production is asserted elsewhere; the
 *     fixtures here write the columns directly.
 *   - Live Postgres-only behaviour (Timescale hypertable partitioning on
 *     `events`). The table is created as a plain table here.
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

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  proposals,
  events,
  workspaces,
  workspaceMembers,
  podMembers,
  users,
  projectMembers,
} from "@synap/database/schema";
import { listRuns } from "../index.js";

type ColumnLike = {
  name: string;
  primary: boolean;
  hasDefault: boolean;
  default: unknown;
  getSQLType(): string;
};

/** Minimal DDL derived from the REAL Drizzle table config — never hand-written,
 *  so a schema column this reader depends on cannot go missing from the fixture
 *  while the test still passes. */
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

const USER = "user-session-lens";
const SESSION_A = randomUUID();
const SESSION_B = randomUUID();
const PROJECT = randomUUID();
const ENTITY = randomUUID();

/** Proposed run in session A. */
const PROP_A = randomUUID();
const CORR_A = randomUUID();
/** Proposed run in session B (the discriminating "other session" row). */
const PROP_B = randomUUID();
const CORR_B = randomUUID();
/** Direct run (event only, no proposal) in session A. */
const CORR_DIRECT_A = randomUUID();
/** Direct run in session B. */
const CORR_DIRECT_B = randomUUID();
/** A proposed→approved run: BOTH a proposal row and an event, same correlationId. */
const PROP_BOTH = randomUUID();
const CORR_BOTH = randomUUID();
/** A capture.graph proposal in session A — a SESSION-BLIND ledger's row.
 *  `listCaptureRuns` surfaces it under `correlationId ?? id`, so the id this
 *  test looks for is the correlation id. */
const PROP_CAPTURE_A = randomUUID();
const CORR_CAPTURE_A = randomUUID();

async function insertProposal(row: {
  id: string;
  proposalType: string;
  correlationId: string | null;
  sessionId: string | null;
  createdAt: string;
  projectId?: string | null;
}) {
  await h.client!.query(
    `insert into proposals (id, proposal_type, target_type, target_id, status,
       correlation_id, session_id, workspace_id, project_id, created_at, reviewed_at, data)
     values ($1,$2,'capability','t','approved',$3,$4,null,$5,$6,$6,$7::jsonb)`,
    [
      row.id,
      row.proposalType,
      row.correlationId,
      row.sessionId,
      row.projectId ?? null,
      row.createdAt,
      JSON.stringify({
        verbId: `verb-${row.id.slice(0, 4)}`,
        runResult: { ok: 1 },
      }),
    ]
  );
}

async function insertDirectEvent(row: {
  correlationId: string;
  sessionId: string | null;
  timestamp: string;
  userId?: string;
}) {
  await h.client!.query(
    `insert into events (id, timestamp, subject_type, subject_id, type,
       user_id, correlation_id, session_id, data)
     values (gen_random_uuid(), $1, 'ai_decision', gen_random_uuid(),
       'ai_decision.completed', $2, $3, $4, $5::jsonb)`,
    [
      row.timestamp,
      row.userId ?? USER,
      row.correlationId,
      row.sessionId,
      JSON.stringify({
        kind: "capability_run",
        verbId: "direct.verb",
        runResult: { ok: 1 },
      }),
    ]
  );
}

const ids = (runs: Array<{ id: string }>) => runs.map((r) => r.id).sort();

beforeAll(async () => {
  for (const t of [
    workspaces,
    workspaceMembers,
    proposals,
    events,
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
});

beforeEach(async () => {
  await h.client!.exec(`delete from proposals; delete from events;`);

  const t = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();
  await insertProposal({
    id: PROP_A,
    proposalType: "capability.run",
    correlationId: CORR_A,
    sessionId: SESSION_A,
    createdAt: t(1),
  });
  await insertProposal({
    id: PROP_B,
    proposalType: "capability.run",
    correlationId: CORR_B,
    sessionId: SESSION_B,
    createdAt: t(2),
  });
  await insertProposal({
    id: PROP_BOTH,
    proposalType: "capability.run",
    correlationId: CORR_BOTH,
    sessionId: SESSION_A,
    createdAt: t(3),
  });
  await insertProposal({
    id: PROP_CAPTURE_A,
    proposalType: "capture.graph",
    correlationId: CORR_CAPTURE_A,
    sessionId: SESSION_A,
    createdAt: t(4),
  });
  await insertDirectEvent({
    correlationId: CORR_DIRECT_A,
    sessionId: SESSION_A,
    timestamp: t(5),
  });
  await insertDirectEvent({
    correlationId: CORR_DIRECT_B,
    sessionId: SESSION_B,
    timestamp: t(6),
  });
  // The approved run's OWN event — same correlationId as PROP_BOTH.
  await insertDirectEvent({
    correlationId: CORR_BOTH,
    sessionId: SESSION_A,
    timestamp: t(7),
  });
});

describe("RunScope.sessionId — the capability-run session lens", () => {
  it("NON-VACUITY: with no session lens, every fixture run of both sessions is reachable", async () => {
    const runs = await listRuns({ userId: USER, flowType: "capability" });
    // 3 proposals (A, B, BOTH) + 2 direct-only events (A, B); the BOTH event
    // dedupes onto its proposal.
    expect(ids(runs)).toEqual(
      ids([
        { id: PROP_A },
        { id: PROP_B },
        { id: PROP_BOTH },
        { id: CORR_DIRECT_A },
        { id: CORR_DIRECT_B },
      ])
    );
  });

  it("returns a PROPOSED run filed under session A, and NOT session B's", async () => {
    const runs = await listRuns({
      userId: USER,
      flowType: "capability",
      scope: { sessionId: SESSION_A },
    });
    expect(runs.map((r) => r.id)).toContain(PROP_A);
    expect(runs.map((r) => r.id)).not.toContain(PROP_B);
  });

  it("returns a DIRECT run (event, no proposal) filed under session A, and NOT session B's", async () => {
    const runs = await listRuns({
      userId: USER,
      flowType: "capability",
      scope: { sessionId: SESSION_A },
    });
    expect(runs.map((r) => r.id)).toContain(CORR_DIRECT_A);
    expect(runs.map((r) => r.id)).not.toContain(CORR_DIRECT_B);
  });

  it("session A returns EXACTLY its own runs — the other session's proposal AND event are both gone", async () => {
    const runs = await listRuns({
      userId: USER,
      flowType: "capability",
      scope: { sessionId: SESSION_A },
    });
    expect(ids(runs)).toEqual(
      ids([{ id: PROP_A }, { id: PROP_BOTH }, { id: CORR_DIRECT_A }])
    );
  });

  it("session B likewise — proving the filter tracks the ARGUMENT, not a constant", async () => {
    const runs = await listRuns({
      userId: USER,
      flowType: "capability",
      scope: { sessionId: SESSION_B },
    });
    expect(ids(runs)).toEqual(ids([{ id: PROP_B }, { id: CORR_DIRECT_B }]));
  });

  it("a proposed→approved run present in BOTH ledgers appears ONCE, proposal-backed, under the lens", async () => {
    const runs = await listRuns({
      userId: USER,
      flowType: "capability",
      scope: { sessionId: SESSION_A },
    });
    const both = runs.filter((r) => r.correlationId === CORR_BOTH);
    expect(both).toHaveLength(1);
    // Proposal-backed wins: its id is the PROPOSAL row id, not the correlationId.
    expect(both[0]!.id).toBe(PROP_BOTH);
  });

  // CAVEAT 2 — the silent-empty trap, made loud.
  it("THROWS when `sessionId` is combined with `projectId` instead of silently dropping every direct run", async () => {
    await expect(
      listRuns({
        userId: USER,
        flowType: "capability",
        scope: { sessionId: SESSION_A, projectId: PROJECT },
      })
    ).rejects.toThrow(/sessionId.*projectId.*cannot be combined/i);
  });

  // CAVEAT 1 — precedence is INTERSECTION, not override.
  it("`subjectEntityId` still short-circuits with a session lens set (scope fields AND, they do not override)", async () => {
    const runs = await listRuns({
      userId: USER,
      flowType: "capability",
      scope: { sessionId: SESSION_A, subjectEntityId: ENTITY },
    });
    expect(runs).toEqual([]);
  });

  it("a SESSION-BLIND ledger contributes NOTHING under the lens — it does not leak unfiltered rows", async () => {
    // Discriminating input: `PROP_CAPTURE_A` is a capture.graph proposal filed
    // under session A. It is reachable without the lens, so its absence WITH the
    // lens is exclusion, not a missing fixture. A reader that forgot to exclude
    // session-blind ledgers would return it (its own filter ignores sessionId).
    const unlensed = await listRuns({ userId: USER, flowType: "capture" });
    expect(unlensed.map((r) => r.id)).toContain(CORR_CAPTURE_A);

    const lensed = await listRuns({
      userId: USER,
      scope: { sessionId: SESSION_A },
    });
    expect(lensed.map((r) => r.id)).not.toContain(CORR_CAPTURE_A);
    // …and the capability ledger still answers in the same merged call.
    expect(lensed.map((r) => r.id)).toContain(PROP_A);
  });

  it("the event branch is USER-floored: another user's direct run in the same session is not returned", async () => {
    await insertDirectEvent({
      correlationId: randomUUID(),
      sessionId: SESSION_A,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 8)).toISOString(),
      userId: "someone-else",
    });
    const runs = await listRuns({
      userId: USER,
      flowType: "capability",
      scope: { sessionId: SESSION_A },
    });
    expect(ids(runs)).toEqual(
      ids([{ id: PROP_A }, { id: PROP_BOTH }, { id: CORR_DIRECT_A }])
    );
  });
});
