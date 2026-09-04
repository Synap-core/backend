/**
 * AN EXPIRED RULE'S *SCHEDULED* AUTOMATION MUST ALSO STOP FIRING.
 *
 * The event matcher was guarded first (`automation-trigger-matcher.rule-expiry.test.ts`),
 * and the tripwire that certified it was titled as though that were the firing
 * side entire. It was not: a rule can compile to a CRON automation
 * (`services/rules/compile.ts` accepts `triggerType: "cron"` once
 * `triggerConfig.expression` is present), and this scheduler dispatched those
 * with no expiry check at all — so a scheduled rule kept running forever after
 * its review date, which is the same "silence the advice, leave the action
 * running" half-fix, one door over.
 *
 * Locked here:
 *  - a due cron automation whose rule has EXPIRED is not dispatched;
 *  - an ordinary cron automation (no `metadata.ruleId`) is unaffected, and
 *    costs ZERO extra queries — the expiry lookup is skipped entirely;
 *  - ENFORCEMENT ≠ VISIBILITY: the skip writes nothing. No archive, no status
 *    change, and specifically no `nextRunAt` advance — renewing the rule must
 *    resume the schedule with no repair step.
 *
 * The db is mocked, so this proves the WORKER's decision, not Postgres.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const bossSend = vi.fn().mockResolvedValue(undefined);
const updateSet = vi.fn();
const insertValues = vi.fn();

let selectResults: unknown[][] = [];
let selectCall = 0;

function makeThenable(result: unknown) {
  const p: Record<string, unknown> = {};
  const chain = () => p;
  p.from = chain;
  p.where = () => p;
  p.set = (v: unknown) => {
    updateSet(v);
    return p;
  };
  p.values = (v: unknown) => {
    insertValues(v);
    return p;
  };
  p.returning = () => Promise.resolve(result);
  p.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(result).then(res, rej);
  return p;
}

const selectSpy = vi.fn(() => {
  const result = selectResults[selectCall] ?? [];
  selectCall += 1;
  return makeThenable(result);
});

vi.mock("@synap/events", () => ({ getBoss: () => ({ send: bossSend }) }));

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
    query: {
      focusSessions: { findFirst: () => Promise.resolve(null) },
      links: { findMany: () => Promise.resolve([]) },
    },
    select: () => selectSpy(),
    insert: () => makeThenable([{ id: "run-1" }]),
    update: () => makeThenable(undefined),
    delete: () => makeThenable(undefined),
  },
  eq: () => ({}),
  and: () => ({}),
  or: () => ({}),
  lte: () => ({}),
  isNull: () => ({}),
  inArray: () => ({}),
  drizzleSql: () => ({}),
  automations: {
    id: "id",
    status: "status",
    triggerType: "trigger_type",
    nextRunAt: "next_run_at",
    triggerConfig: "trigger_config",
    metadata: "metadata",
    workspaceId: "workspace_id",
    createdBy: "created_by",
    runCount: 0,
  },
  automationRuns: { id: "id" },
  automationClaims: { id: "id" },
  playbookAutomations: {},
  skills: { id: "id", metadata: "metadata" },
  workspaceMembers: { workspaceId: "ws", userId: "uid" },
  workspaces: { id: "ws_id", settings: "settings" },
}));

const { handleAutomationCronScheduler } =
  await import("./automation-cron-scheduler.js");

const PAST = new Date(Date.now() - 86_400_000).toISOString();
const FUTURE = new Date(Date.now() + 86_400_000).toISOString();

/** A due cron automation compiled from a rule. */
const ruleCron = (id: string, ruleId: string) => ({
  id,
  workspaceId: "ws-1",
  status: "active",
  triggerType: "cron",
  triggerConfig: { expression: "0 8 * * *" },
  metadata: { ruleId, kind: "rule" },
  nextRunAt: new Date(Date.now() - 1000),
  runCount: 0,
  createdBy: "user-1",
});

/** A due cron automation with no rule behind it. */
const plainCron = {
  id: "auto-plain",
  workspaceId: "ws-1",
  status: "active",
  triggerType: "cron",
  triggerConfig: { expression: "0 8 * * *" },
  metadata: {},
  nextRunAt: new Date(Date.now() - 1000),
  runCount: 0,
  createdBy: "user-1",
};

const ruleRow = (id: string, expiresAt: string | null) => ({
  id,
  metadata: { rule: expiresAt ? { expiresAt } : {} },
});

// selectResults[0] = the heal query, [1] = the due query, [2] = the expiry lookup
const HEAL_NONE: unknown[] = [];

describe("cron scheduler — an expired rule's schedule stops firing", () => {
  beforeEach(() => {
    bossSend.mockClear();
    updateSet.mockClear();
    insertValues.mockClear();
    selectSpy.mockClear();
    selectCall = 0;
    selectResults = [];
  });

  it("does NOT dispatch a due cron whose rule has expired", async () => {
    selectResults = [
      HEAL_NONE,
      [ruleCron("auto-rule", "rule-1")],
      [ruleRow("rule-1", PAST)],
    ];
    await handleAutomationCronScheduler();
    expect(bossSend).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("DOES dispatch a due cron whose rule is still in date", async () => {
    selectResults = [
      HEAL_NONE,
      [ruleCron("auto-rule", "rule-1")],
      [ruleRow("rule-1", FUTURE)],
    ];
    await handleAutomationCronScheduler();
    expect(bossSend).toHaveBeenCalledTimes(1);
  });

  it("ABSENT is not EXPIRED — a rule with no review date still fires", async () => {
    selectResults = [
      HEAL_NONE,
      [ruleCron("auto-rule", "rule-1")],
      [ruleRow("rule-1", null)],
    ];
    await handleAutomationCronScheduler();
    expect(bossSend).toHaveBeenCalledTimes(1);
  });

  it("costs ZERO extra queries when no due automation is rule-backed", async () => {
    selectResults = [HEAL_NONE, [plainCron]];
    await handleAutomationCronScheduler();
    expect(bossSend).toHaveBeenCalledTimes(1);
    // heal + due, and nothing else: the expiry lookup must not be issued.
    expect(selectSpy).toHaveBeenCalledTimes(2);
  });

  it("batches ONE lookup for many rule-backed automations, not one each", async () => {
    selectResults = [
      HEAL_NONE,
      [
        ruleCron("a1", "rule-1"),
        ruleCron("a2", "rule-2"),
        ruleCron("a3", "rule-3"),
      ],
      [
        ruleRow("rule-1", PAST),
        ruleRow("rule-2", FUTURE),
        ruleRow("rule-3", PAST),
      ],
    ];
    await handleAutomationCronScheduler();
    expect(selectSpy).toHaveBeenCalledTimes(3); // heal + due + ONE expiry lookup
    expect(bossSend).toHaveBeenCalledTimes(1); // only rule-2 survives
  });

  it("ENFORCEMENT ≠ VISIBILITY — the skip writes nothing at all", async () => {
    selectResults = [
      HEAL_NONE,
      [ruleCron("auto-rule", "rule-1")],
      [ruleRow("rule-1", PAST)],
    ];
    await handleAutomationCronScheduler();
    // No archive, no status change, and critically no `nextRunAt` advance:
    // renewing the rule must resume the schedule with no repair step.
    expect(updateSet).not.toHaveBeenCalled();
  });
});
