/**
 * Plan 08e4fba7 §3.5 (slice 7): `runs.get` on an agent playbook run returns
 * WHY it cost what it cost (`playbookDetail.cost`, `run-cost-record.ts`),
 * from what the pod records: the session's turn ledger (`metadata.runTurns`)
 * and the agent-run telemetry events of the run's window.
 *
 * Driven through the REAL tRPC door (`runsRouter.get`) and `getRun` on PGlite.
 * What is not recorded must read as absent (null), never as 0.
 *
 * What this CANNOT see: production Postgres (tables are generated from the
 * Drizzle definitions without FKs / NOT NULL / enums), and the IS posting real
 * telemetry.
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
      proposals: actual.proposals as never,
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
import { ledgerRecordOf } from "../run-cost-record.js";
import { runsRouter } from "../../../routers/runs.js";

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

const OWNER = "owner-cost";
const COLLEAGUE = "colleague-cost";
const WS = randomUUID();
const PLAYBOOK = randomUUID();
const S = randomUUID(); // the session both runs drove
const OTHER_S = randomUUID(); // another session, same window
const RUN = randomUUID(); // the first run on S
const RUN2 = randomUUID(); // the session's next run (a re-run)
const ROOM = randomUUID();

const T0 = new Date("2026-11-09T10:00:00.000Z"); // RUN starts
const T2 = new Date("2026-11-09T12:00:00.000Z"); // RUN2 starts
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

const FIRST_TURN = {
  at: at(1).toISOString(),
  turnKey: "turn-1",
  outcome: "stopped",
  reason: "turn_budget",
  agentType: "meta",
  ceiling: 120_000,
  spentInputTokens: 118_000,
  chargedInputTokens: 61_000,
  cacheReadInputTokens: 64_000,
  cacheWriteInputTokens: 9_000,
  model: "anthropic/claude-sonnet-5-5",
  next: "continue",
  firstCall: {
    promptTokens: 21_000,
    reported: true,
    toolCount: 3,
    chars: { system: 40_000, tools: 12_000, history: 0, message: 800 },
    sections: [
      { name: "persona", chars: 9_000 },
      { name: "method", chars: 31_000 },
    ],
    tools: ["synap_get_entity", "synap_capture", "synap_update_session"],
    guidance: ["skill:rules/voice"],
  },
};
// A turn whose provider reported no cache counts: absent, never 0.
const SECOND_TURN = {
  at: at(5).toISOString(),
  turnKey: "turn-2",
  outcome: "completed",
  agentType: "meta",
  ceiling: 120_000,
  spentInputTokens: 30_000,
  model: "anthropic/claude-haiku-5-5",
};

// A turn the IS reported failed: its outcome and reason are kept as such.
const FAILED_TURN = {
  at: at(9).toISOString(),
  turnKey: "turn-3",
  outcome: "failed",
  reason: "turn_error",
  agentType: "meta",
  ceiling: 120_000,
};

/** The ledger complete-run wrote for RUN (6 turns; the middle 3 dropped). */
const LEDGER = {
  runId: RUN,
  stops: 1,
  autoContinues: 1,
  firstTurn: FIRST_TURN,
  turns: [SECOND_TURN, FAILED_TURN],
  cost: {
    turns: 6,
    freshInputTokens: 100_000,
    rawInputTokens: 164_000,
    cacheReadInputTokens: 64_000,
    models: ["anthropic/claude-sonnet-5-5", "anthropic/claude-haiku-5-5"],
  },
};

async function agentRunEvent(over: {
  at: Date;
  sessionId: string;
  costUsd: number | null;
  tokensOut: number | null;
  model?: string;
}) {
  await q(
    `insert into events (id, timestamp, type, subject_id, subject_type, user_id, data, is_agent, agent_type, model, cost_usd, tokens_in, tokens_out, tool_count, run_status, finish_reason)
     values ($1, $2, 'agentRun.create.completed', $3, 'agentRun', 'agent-of-owner', $4::jsonb, true, 'meta', $5, $6, 1000, $7, 2, 'succeeded', 'stop')`,
    [
      randomUUID(),
      over.at.toISOString(),
      randomUUID(),
      JSON.stringify({ sessionId: over.sessionId }),
      over.model ?? "anthropic/claude-sonnet-5-5",
      over.costUsd,
      over.tokensOut,
    ]
  );
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const n of [
    "focus_sessions",
    "playbook_runs",
    "playbooks",
    "events",
    "workspaces",
    "workspace_members",
  ]) {
    expect(byName.has(n)).toBe(true);
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
    `insert into playbooks (id, name, goal_template, workspace_id, status, version, executor, updated_at) values ($1, 'Captions', 'g', $2, 'active', 1, 'agent', now())`,
    [PLAYBOOK, WS]
  );
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, playbook_id, goal, status, metadata, channel_id, created_at, updated_at, started_at)
     values ($1, $2, $3, $4, 'Write the caption', 'active', $5::jsonb, $6, now(), now(), now())`,
    [S, OWNER, WS, PLAYBOOK, JSON.stringify({ runTurns: LEDGER }), ROOM]
  );
  await q(
    `insert into playbook_runs (id, workspace_id, playbook_id, session_id, executor, status, stop_reason, started_at, created_by)
     values ($1, $2, $3, $4, 'is-agent', 'failed', 'budget', $5, $6)`,
    [RUN, WS, PLAYBOOK, S, T0.toISOString(), OWNER]
  );
  await q(
    `insert into playbook_runs (id, workspace_id, playbook_id, session_id, executor, status, started_at, created_by)
     values ($1, $2, $3, $4, 'is-agent', 'running', $5, $6)`,
    [RUN2, WS, PLAYBOOK, S, T2.toISOString(), OWNER]
  );

  // RUN's window [T0, T2): one priced turn, one unpriced turn with no output count.
  await agentRunEvent({
    at: at(2),
    sessionId: S,
    costUsd: 0.0425,
    tokensOut: 1_500,
  });
  await agentRunEvent({
    at: at(6),
    sessionId: S,
    costUsd: null,
    tokensOut: null,
    model: "anthropic/claude-haiku-5-5",
  });
  // Before RUN started: not RUN's.
  await agentRunEvent({
    at: new Date(T0.getTime() - 60_000),
    sessionId: S,
    costUsd: 9,
    tokensOut: 9,
  });
  // Another session in the same window: not RUN's.
  await agentRunEvent({
    at: at(3),
    sessionId: OTHER_S,
    costUsd: 7,
    tokensOut: 7,
  });
  // RUN2's window [T2, ∞).
  await agentRunEvent({
    at: new Date(T2.getTime() + 60_000),
    sessionId: S,
    costUsd: 0.5,
    tokensOut: 300,
  });
});

const ctx = (userId: string) => ({ authenticated: true, userId }) as never;

describe("runs.get — an agent run's cost record", () => {
  it("returns the turns the ledger kept, with what each one recorded", async () => {
    const d = await runsRouter
      .createCaller(ctx(OWNER))
      .get({ flowType: "playbook", id: RUN });
    const cost = d?.playbookDetail?.cost;
    expect(cost?.runId).toBe(RUN);
    expect(cost?.stopReason).toBe("budget");
    expect(cost?.turns).toEqual([
      {
        at: FIRST_TURN.at,
        outcome: "stopped",
        reason: "turn_budget",
        agentType: "meta",
        model: "anthropic/claude-sonnet-5-5",
        inputTokens: 118_000,
        chargedInputTokens: 61_000,
        cacheReadInputTokens: 64_000,
        cacheWriteInputTokens: 9_000,
        ceiling: 120_000,
        next: "continue",
      },
      {
        at: SECOND_TURN.at,
        outcome: "completed",
        reason: null,
        agentType: "meta",
        model: "anthropic/claude-haiku-5-5",
        inputTokens: 30_000,
        // Not reported by the provider: absent, never 0.
        chargedInputTokens: null,
        cacheReadInputTokens: null,
        cacheWriteInputTokens: null,
        ceiling: 120_000,
        next: null,
      },
      {
        at: FAILED_TURN.at,
        outcome: "failed",
        reason: "turn_error",
        agentType: "meta",
        model: null,
        inputTokens: null,
        chargedInputTokens: null,
        cacheReadInputTokens: null,
        cacheWriteInputTokens: null,
        ceiling: 120_000,
        next: null,
      },
    ]);
    // The ledger's running total covers every turn; 3 are no longer kept.
    expect(cost?.total).toEqual(LEDGER.cost);
    expect(cost?.turnsNotKept).toBe(3);
  });

  it("returns what the first call was made of: sections, tools, guidance", async () => {
    const d = await getRun({ userId: OWNER, flowType: "playbook", id: RUN });
    expect(d?.playbookDetail?.cost?.firstCall).toEqual({
      promptTokens: 21_000,
      reported: true,
      toolCount: 3,
      chars: { system: 40_000, tools: 12_000, history: 0, message: 800 },
      sections: FIRST_TURN.firstCall.sections,
      tools: FIRST_TURN.firstCall.tools,
      guidance: ["skill:rules/voice"],
    });
  });

  it("sums output tokens and real cost over the run's own window only", async () => {
    const d = await getRun({ userId: OWNER, flowType: "playbook", id: RUN });
    const spend = d?.playbookDetail?.cost?.spend;
    expect(spend?.status).toBe("ok");
    if (spend?.status !== "ok") return;
    // Two turns in [T0, T2) of THIS session: not the earlier event, not the
    // other session's, not the next run's.
    expect(spend.turns).toBe(2);
    expect(spend.costUsd).toBeCloseTo(0.0425, 6);
    // The unpriced turn makes the cost a floor, said, never folded into 0.
    expect(spend.uncostedTurns).toBe(1);
    expect(spend.outputTokens).toBe(1_500);
    expect(spend.unmeasuredOutputTurns).toBe(1);
    expect(spend.items.map((i) => i.model)).toEqual([
      "anthropic/claude-haiku-5-5",
      "anthropic/claude-sonnet-5-5",
    ]);
    expect(spend.items[0]?.costUsd).toBeNull();
  });

  it("the session's next run reads its own window, and no ledger of another run", async () => {
    const d = await getRun({ userId: OWNER, flowType: "playbook", id: RUN2 });
    const cost = d?.playbookDetail?.cost;
    expect(cost?.runId).toBe(RUN2);
    // The session's ledger is RUN's: not shown under RUN2.
    expect(cost?.turns).toEqual([]);
    expect(cost?.total).toBeNull();
    expect(cost?.firstCall).toBeNull();
    expect(cost?.stopReason).toBeNull();
    const spend = cost?.spend;
    expect(spend?.status).toBe("ok");
    if (spend?.status !== "ok") return;
    expect(spend.turns).toBe(1);
    expect(spend.costUsd).toBeCloseTo(0.5, 6);
  });

  it("a viewer who may not read the session gets no cost record", async () => {
    const d = await getRun({
      userId: COLLEAGUE,
      flowType: "playbook",
      id: RUN,
    });
    expect(d?.playbookDetail?.sessionPrivate).toBe(true);
    expect(d?.playbookDetail?.cost).toBeUndefined();
  });
});

describe("ledgerRecordOf (pure)", () => {
  it("a session with no ledger reads as no turns, no total", () => {
    expect(ledgerRecordOf({}, RUN)).toEqual({
      total: null,
      turns: [],
      turnsNotKept: 0,
      firstCall: null,
    });
  });
  it("the first turn is listed once when the ledger still keeps it", () => {
    const r = ledgerRecordOf(
      {
        runTurns: {
          runId: RUN,
          stops: 0,
          autoContinues: 0,
          firstTurn: SECOND_TURN,
          turns: [SECOND_TURN],
        },
      },
      RUN
    );
    expect(r.turns).toHaveLength(1);
    expect(r.turnsNotKept).toBe(0);
    // An older ledger with no running total is summed from its turns.
    expect(r.total?.turns).toBe(1);
    // A first call that recorded no inventory reads as none.
    expect(r.firstCall).toBeNull();
  });
  it("a first-call size that was not recorded is null, never 0", () => {
    const { message: _dropped, ...chars } = FIRST_TURN.firstCall.chars;
    const r = ledgerRecordOf(
      {
        runTurns: {
          runId: RUN,
          stops: 0,
          autoContinues: 0,
          firstTurn: {
            ...FIRST_TURN,
            firstCall: { ...FIRST_TURN.firstCall, chars },
          },
          turns: [],
        },
      },
      RUN
    );
    expect(r.firstCall?.chars).toEqual({
      system: 40_000,
      tools: 12_000,
      history: 0,
      message: null,
    });
  });
});
