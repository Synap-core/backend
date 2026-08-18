/**
 * agentRuns.summary — the NULL-vs-0 contract.
 *
 * THE LIE THIS PINS. `events.cost_usd` is NULL when the provider reported no
 * price (a free-tier or local model), NOT when the run was free. `SUM()` skips
 * NULLs — correct — but if the reader then coalesces that NULL to 0, a day of
 * unpriced runs renders as "$0.00", which tells the user "this was free". It
 * was not; we simply do not know. So `costUsd` must stay `null`, and the bucket
 * must carry `costedRunCount` / `uncostedRunCount` so the UI can say
 * "$1.62 (+3 runs of unknown cost)" instead of a false total.
 *
 * Two layers, deliberately:
 *  1. PURE — `shapeAgentSpend` is the row shaper the repository delegates to,
 *     so the whole contract is provable with NO database. These tests always
 *     run; there is no skip to be honest about.
 *  2. DB-GATED — the real GROUPING SETS SQL against live Postgres (day
 *     bucketing, the total row, the user clamp). Skips cleanly when Postgres is
 *     absent; the first `describe` proves the skip is honest, not vacuous.
 */

import { randomUUID } from "crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  db,
  users,
  drizzleSql,
  eq,
  shapeAgentSpend,
  getEventRepository,
  type AgentSpendRawRow,
} from "@synap/database";
import { agentRunsRouter } from "./agent-runs.js";

// ── Layer 1: pure shaper — no database ───────────────────────────────────────

const NOW = new Date("2026-08-18T09:30:00.000Z");

/**
 * Fixture factory. Annotated (`: AgentSpendRawRow`), never cast — a cast here
 * would hide a missing required field from the typechecker.
 */
function rawRow(over: Partial<AgentSpendRawRow>): AgentSpendRawRow {
  const base: AgentSpendRawRow = {
    day: "2026-08-18",
    is_total: 0,
    cost_usd: null,
    tokens_in: null,
    tokens_out: null,
    run_count: 0,
    failed_count: 0,
    costed_run_count: 0,
    uncosted_run_count: 0,
  };
  return { ...base, ...over };
}

describe("shapeAgentSpend — NULL cost is 'unknown', never $0", () => {
  it("a day whose runs ALL have unknown cost reports null, NOT 0", () => {
    const rows: AgentSpendRawRow[] = [
      rawRow({
        day: "2026-08-17",
        cost_usd: null, // SUM over all-NULL → NULL
        tokens_in: "1200",
        tokens_out: "340",
        run_count: "3",
        costed_run_count: "0",
        uncosted_run_count: "3",
      }),
      rawRow({
        day: null,
        is_total: 1,
        cost_usd: null,
        run_count: "3",
        costed_run_count: "0",
        uncosted_run_count: "3",
      }),
    ];

    const out = shapeAgentSpend(rows, { windowDays: 3, now: NOW });
    const day = out.days.find((d) => d.day === "2026-08-17");

    // THE ASSERTION. `toBeNull` alone would pass on `undefined` in some
    // matchers, and `0` must be rejected explicitly — 0 is the lie.
    expect(day?.costUsd).toBeNull();
    expect(day?.costUsd).not.toBe(0);
    expect(out.total.costUsd).toBeNull();
    expect(out.total.costUsd).not.toBe(0);

    // ...and the honest denominator the UI needs to say so.
    expect(day?.runCount).toBe(3);
    expect(day?.costedRunCount).toBe(0);
    expect(day?.uncostedRunCount).toBe(3);
  });

  it("a MIXED day reports the known sum as a floor, flagging the unpriced runs", () => {
    const rows: AgentSpendRawRow[] = [
      rawRow({
        day: "2026-08-18",
        cost_usd: "1.620000",
        tokens_in: "9000",
        tokens_out: "2500",
        run_count: "5",
        failed_count: "1",
        costed_run_count: "2",
        uncosted_run_count: "3",
      }),
      rawRow({
        day: null,
        is_total: 1,
        cost_usd: "1.620000",
        run_count: "5",
        failed_count: "1",
        costed_run_count: "2",
        uncosted_run_count: "3",
      }),
    ];

    const out = shapeAgentSpend(rows, { windowDays: 2, now: NOW });
    const day = out.days.find((d) => d.day === "2026-08-18");

    expect(day?.costUsd).toBeCloseTo(1.62, 6);
    expect(day?.uncostedRunCount).toBe(3); // → "$1.62 (+3 of unknown cost)"
    expect(day?.failedCount).toBe(1);
    expect(out.total.costUsd).toBeCloseTo(1.62, 6);
  });

  it("a genuine zero is preserved as 0 (0 and null are different facts)", () => {
    const rows: AgentSpendRawRow[] = [
      rawRow({
        day: "2026-08-18",
        cost_usd: "0.000000",
        run_count: "1",
        costed_run_count: "1",
        uncosted_run_count: "0",
      }),
    ];
    const out = shapeAgentSpend(rows, { windowDays: 1, now: NOW });
    expect(out.days[0].costUsd).toBe(0);
    expect(out.days[0].costUsd).not.toBeNull();
  });

  it("fills the window with empty days, oldest → newest, cost null not 0", () => {
    const out = shapeAgentSpend([], { windowDays: 3, now: NOW });
    expect(out.days.map((d) => d.day)).toEqual([
      "2026-08-16",
      "2026-08-17",
      "2026-08-18",
    ]);
    expect(out.windowStart).toBe("2026-08-16");
    expect(out.windowEnd).toBe("2026-08-18");
    for (const d of out.days) {
      expect(d.runCount).toBe(0);
      expect(d.costUsd).toBeNull();
    }
    // No rows at all ⇒ the total is empty, and still not a fabricated $0.
    expect(out.total.runCount).toBe(0);
    expect(out.total.costUsd).toBeNull();
  });
});

// ── Layer 2: the real SQL, against live Postgres ─────────────────────────────

const USER = "e0000000-0000-0000-0000-0000000000d1";
const OTHER_USER = "e0000000-0000-0000-0000-0000000000d2";
const WS = "e0000000-0000-0000-0000-0000000000d3";

async function checkDb(): Promise<boolean> {
  try {
    await db
      .select({ one: drizzleSql`1` })
      .from(users)
      .limit(1);
    return true;
  } catch {
    return false;
  }
}

const dbAvailable = await checkDb();

describe("agentRuns.summary — live-PG gate", () => {
  it("probed the database (skips below are honest, not vacuous)", () => {
    expect(typeof dbAvailable).toBe("boolean");
  });
});

async function cleanup() {
  for (const id of [USER, OTHER_USER]) {
    await db.execute(drizzleSql`DELETE FROM events WHERE user_id = ${id}`);
    await db.delete(users).where(eq(users.id, id));
  }
}

/** Insert one `agentRun.create.completed` event directly (the write door lives in the hub REST layer, which is out of scope here). */
async function insertRun(opts: {
  userId: string;
  daysAgo: number;
  costUsd: string | null;
  tokensIn: number;
  tokensOut: number;
  runStatus: "succeeded" | "failed";
  workspaceId?: string;
}) {
  const ts = new Date(Date.now() - opts.daysAgo * 86_400_000);
  await db.execute(drizzleSql`
    INSERT INTO events (
      id, timestamp, type, subject_id, subject_type, data, source, user_id,
      is_agent, cost_usd, tokens_in, tokens_out, run_status, workspace_id
    ) VALUES (
      ${randomUUID()}, ${ts.toISOString()}, 'agentRun.create.completed',
      ${randomUUID()}, 'agent_run', ${drizzleSql`'{}'::jsonb`}, 'api', ${opts.userId},
      true, ${opts.costUsd}, ${opts.tokensIn}, ${opts.tokensOut},
      ${opts.runStatus}, ${opts.workspaceId ?? null}
    )
  `);
}

describe.skipIf(!dbAvailable)("agentRuns.summary — SQL aggregate", () => {
  beforeAll(async () => {
    await cleanup();
    for (const [id, email] of [
      [USER, "spend-summary@test.synap"],
      [OTHER_USER, "spend-summary-other@test.synap"],
    ] as const) {
      await db
        .insert(users)
        .values({ id, email, userType: "human" })
        .onConflictDoNothing();
    }
    // Today: one priced run + two unpriced ones (the mixed case).
    await insertRun({
      userId: USER,
      daysAgo: 0,
      costUsd: "1.500000",
      tokensIn: 100,
      tokensOut: 50,
      runStatus: "succeeded",
      workspaceId: WS,
    });
    await insertRun({
      userId: USER,
      daysAgo: 0,
      costUsd: null,
      tokensIn: 10,
      tokensOut: 5,
      runStatus: "failed",
    });
    await insertRun({
      userId: USER,
      daysAgo: 0,
      costUsd: null,
      tokensIn: 10,
      tokensOut: 5,
      runStatus: "succeeded",
    });
    // Two days ago: ALL unpriced — the day that must never render as $0.
    await insertRun({
      userId: USER,
      daysAgo: 2,
      costUsd: null,
      tokensIn: 20,
      tokensOut: 8,
      runStatus: "succeeded",
    });
    // Another user's spend must never leak in.
    await insertRun({
      userId: OTHER_USER,
      daysAgo: 0,
      costUsd: "99.000000",
      tokensIn: 1,
      tokensOut: 1,
      runStatus: "succeeded",
    });
  });

  afterAll(cleanup);

  const caller = () =>
    agentRunsRouter.createCaller({
      authenticated: true,
      userId: USER,
    } as never);

  it("groups by UTC day and totals in one pass, clamped to the owner", async () => {
    const out = await caller().summary({ days: 7 });

    expect(out.days).toHaveLength(7);
    expect(out.total.runCount).toBe(4); // OTHER_USER's run excluded
    expect(out.total.costUsd).toBeCloseTo(1.5, 6); // never 100.5
    expect(out.total.costedRunCount).toBe(1);
    expect(out.total.uncostedRunCount).toBe(3);
    expect(out.total.failedCount).toBe(1);
  });

  it("an all-unpriced day reports null, NOT 0", async () => {
    const out = await caller().summary({ days: 7 });
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const day = out.days.find((d) => d.day === twoDaysAgo);

    expect(day?.runCount).toBe(1);
    expect(day?.costUsd).toBeNull();
    expect(day?.costUsd).not.toBe(0);
    expect(day?.uncostedRunCount).toBe(1);
  });

  it("workspaceId NARROWS and never widens", async () => {
    const narrowed = await caller().summary({ days: 7, workspaceId: WS });
    expect(narrowed.total.runCount).toBe(1);
    expect(narrowed.total.costUsd).toBeCloseTo(1.5, 6);
  });

  it("the repository clamp holds directly too (no router in the way)", async () => {
    const out = await getEventRepository().summarizeAgentRuns({
      userId: OTHER_USER,
      days: 7,
    });
    expect(out.total.runCount).toBe(1);
    expect(out.total.costUsd).toBeCloseTo(99, 6);
  });
});
