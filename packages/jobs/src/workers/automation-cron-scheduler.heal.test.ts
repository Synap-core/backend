/**
 * Cron scheduler self-healing — an active cron automation with a NULL
 * `nextRunAt` must be scheduled, not ignored forever.
 *
 * The defect this locks: the due-query is `status='active' AND
 * trigger_type='cron' AND next_run_at <= now()`. NULL never satisfies `<=`, so a
 * row that never got its `nextRunAt` stamped is structurally invisible to the
 * scheduler for the rest of time (two live crons had fired ZERO times in 8
 * days). The scheduler now repairs such rows itself, using the SAME
 * `computeNextRunAt` parser as the post-run update.
 *
 * Locked semantics:
 *  - the heal SELECT is narrowed by `isNull(automations.next_run_at)`. Without
 *    that conjunct the heal would re-stamp EVERY active cron row every 60s, so
 *    a `0 8 * * *` automation would have its next slot pushed forward forever
 *    and never fire. Deleting the `isNull` from production makes the first test
 *    here fail.
 *  - the healed row is stamped with its NEXT slot (strictly in the future) and
 *    is NOT fired in that pass — healing must never replay the missed
 *    occurrences as a burst of catch-up runs.
 *  - a row whose expression cannot be parsed reaches a TERMINAL state
 *    (`status: "error"` + `errorMessage`) instead of re-warning every minute
 *    forever.
 *
 * What is NOT proven here: the db is mocked, so this locks the predicate SHAPE
 * and the write payloads. Postgres' actual evaluation of the predicate, and the
 * concurrency of the `isNull`-guarded UPDATE, are unproven — that needs a live
 * PG run.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const bossSend = vi.fn().mockResolvedValue(undefined);
const updateSet = vi.fn();
const insertValues = vi.fn();
/** WHERE trees handed to each `.where(...)`, in call order. */
const whereArgs: unknown[] = [];

let selectResults: unknown[][] = [];
let selectCall = 0;
/** Index of the select call that should reject, simulating a transient PG error. */
let selectRejectsOnCall: number | null = null;

const PG_ERROR = Symbol("pg-error");

function makeThenable(result: unknown) {
  const p: Record<string, unknown> = {};
  const chain = () => p;
  p.from = chain;
  p.where = (arg: unknown) => {
    whereArgs.push(arg);
    return p;
  };
  p.set = (v: unknown) => {
    updateSet(v);
    return p;
  };
  p.values = (v: unknown) => {
    insertValues(v);
    return p;
  };
  const settle = () =>
    result === PG_ERROR
      ? Promise.reject(new Error("connection terminated unexpectedly"))
      : Promise.resolve(result);
  p.returning = settle;
  p.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    settle().then(res, rej);
  return p;
}

const selectSpy = vi.fn((..._args: unknown[]) => {
  const call = selectCall;
  selectCall += 1;
  if (call === selectRejectsOnCall) return makeThenable(PG_ERROR);
  return makeThenable(selectResults[call] ?? []);
});

vi.mock("@synap/events", () => ({
  getBoss: () => ({ send: bossSend }),
}));

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("@synap/database", () => ({
  db: {
    select: (...args: unknown[]) => selectSpy(...args),
    insert: () => makeThenable([{ id: "run-1" }]),
    update: () => makeThenable(undefined),
  },
  // Operators return inspectable markers so the predicate SHAPE is assertable
  // (same technique as automation-trigger-matcher.pod-wide.test.ts).
  eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
  and: (...args: unknown[]) => ({ op: "and", args }),
  lte: (col: unknown, val: unknown) => ({ op: "lte", col, val }),
  isNull: (col: unknown) => ({ op: "isNull", col }),
  drizzleSql: () => ({}),
  automations: {
    id: "id",
    status: "status",
    triggerType: "trigger_type",
    nextRunAt: "next_run_at",
    triggerConfig: "trigger_config",
    runCount: 0,
  },
  automationRuns: { id: "id" },
}));

const { handleAutomationCronScheduler } =
  await import("./automation-cron-scheduler.js");

/** Depth-first search for an `isNull(<col>)` marker in a predicate tree. */
function hasIsNullOn(node: unknown, col: string): boolean {
  if (node == null || typeof node !== "object") return false;
  const n = node as { op?: string; col?: unknown; args?: unknown[] };
  if (n.op === "isNull" && n.col === col) return true;
  return (n.args ?? []).some((child) => hasIsNullOn(child, col));
}

describe("cron scheduler — NULL nextRunAt self-healing", () => {
  beforeEach(() => {
    bossSend.mockClear();
    selectSpy.mockClear();
    updateSet.mockClear();
    insertValues.mockClear();
    whereArgs.length = 0;
    selectCall = 0;
    selectResults = [];
    selectRejectsOnCall = null;
  });

  it("narrows the heal query to rows with a NULL nextRunAt", async () => {
    selectResults = [[], []];

    await handleAutomationCronScheduler();

    // [0] is the heal SELECT (it runs before the due SELECT).
    const healWhere = whereArgs[0] as { op?: string; args?: unknown[] };
    expect(healWhere.op).toBe("and");
    // The `isNull(next_run_at)` conjunct must be a DIRECT member of that AND —
    // it is what makes the heal touch only unscheduled rows. Remove it from
    // production and this assertion fails.
    expect(
      (healWhere.args ?? []).some((c) => hasIsNullOn(c, "next_run_at"))
    ).toBe(true);
    // ...alongside the active+cron narrowing, so healing cannot resurrect a
    // paused or non-cron automation.
    expect(healWhere.args).toContainEqual({
      op: "eq",
      col: "status",
      val: "active",
    });
    expect(healWhere.args).toContainEqual({
      op: "eq",
      col: "trigger_type",
      val: "cron",
    });
  });

  it("stamps the next slot on an active cron automation with NULL nextRunAt, without firing a catch-up run", async () => {
    selectResults = [
      // [0] the heal query: one unscheduled daily-8am automation
      [{ id: "auto-dark", triggerConfig: { expression: "0 8 * * *" } }],
      // [1] the due query: nothing due (the healed row is scheduled forward)
      [],
    ];

    const before = Date.now();
    await handleAutomationCronScheduler();

    // Exactly one write: the heal stamp. No run row, no dispatch.
    expect(updateSet).toHaveBeenCalledTimes(1);
    expect(insertValues).not.toHaveBeenCalled();
    expect(bossSend).not.toHaveBeenCalled();

    const patch = updateSet.mock.calls[0][0] as { nextRunAt: Date };
    expect(patch.nextRunAt).toBeInstanceOf(Date);
    // Strictly in the FUTURE — never a replay of the missed 8am slots.
    expect(patch.nextRunAt.getTime()).toBeGreaterThan(before);
    // ...and it is the automation's own slot: 08:00 local, zero seconds.
    expect(patch.nextRunAt.getHours()).toBe(8);
    expect(patch.nextRunAt.getMinutes()).toBe(0);
    expect(patch.nextRunAt.getSeconds()).toBe(0);
  });

  it("parks a row with a missing or unparseable cron expression in status=error instead of re-warning forever", async () => {
    selectResults = [
      [
        { id: "auto-no-expr", triggerConfig: {} },
        { id: "auto-bad-expr", triggerConfig: { expression: "not a cron" } },
      ],
      [],
    ];

    await handleAutomationCronScheduler();

    // Never scheduled, never fired...
    expect(bossSend).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
    // ...but given a TERMINAL state so it leaves the heal set: an unschedulable
    // row would otherwise re-warn every 60s for the rest of time.
    expect(updateSet).toHaveBeenCalledTimes(2);
    const patches = updateSet.mock.calls.map(
      (c) =>
        c[0] as { status?: string; errorMessage?: string; nextRunAt?: Date }
    );
    for (const patch of patches) {
      expect(patch.status).toBe("error");
      expect(patch.nextRunAt).toBeUndefined();
      expect(typeof patch.errorMessage).toBe("string");
    }
    expect(patches[1].errorMessage).toContain("not a cron");
  });

  it("still dispatches due automations when the heal query fails", async () => {
    // The REPAIR path must never take down the PRIMARY path: a transient PG
    // error inside healing would otherwise skip every cron due that minute.
    selectRejectsOnCall = 0; // the heal SELECT
    selectResults = [
      [],
      [
        {
          id: "auto-due",
          workspaceId: "ws-1",
          triggerConfig: { expression: "* * * * *" },
        },
      ],
    ];

    await handleAutomationCronScheduler();

    expect(bossSend).toHaveBeenCalledTimes(1);
    expect(bossSend.mock.calls[0][0]).toBe("automation-execute");
  });

  it("writes nothing when no automation needs healing and none are due", async () => {
    selectResults = [[], []];

    await handleAutomationCronScheduler();

    expect(updateSet).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
    expect(bossSend).not.toHaveBeenCalled();
  });
});
