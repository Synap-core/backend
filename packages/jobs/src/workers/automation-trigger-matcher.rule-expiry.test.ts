/**
 * AN EXPIRED RULE'S AUTOMATION MUST STOP FIRING.
 *
 * `expiresAt` on a rule was honoured by the three `skills` READ doors only
 * (`visibleSkillsWhere` ANDs `ruleNotExpiredWhere()`), so a lapsed rule stopped
 * reaching an agent's prompt while the automation it compiled kept firing
 * forever — the owner believes the standing permission ended, and the action
 * behind it does not. Expiry is this product's chosen mitigation for a standing
 * permission being wrong; silencing the advice is the wrong half of it.
 *
 * ENFORCEMENT ≠ VISIBILITY: the automation is SKIPPED, never archived, deleted
 * or hidden. It stays listed, editable and renewable.
 *
 * The db is mocked, so this proves the WORKER's decision, not Postgres.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const bossSend = vi.fn().mockResolvedValue(undefined);
const updateSet = vi.fn();
const deleteCalls = vi.fn();

let selectResults: unknown[][] = [];
let selectCall = 0;

function makeThenable(result: unknown) {
  const p: Record<string, unknown> = {};
  const chain = () => p;
  p.from = chain;
  p.set = (v: unknown) => {
    updateSet(v);
    return p;
  };
  p.where = () => p;
  p.values = () => p;
  p.onConflictDoNothing = () => p;
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
    delete: () => {
      deleteCalls();
      return makeThenable(undefined);
    },
  },
  eq: () => ({}),
  and: () => ({}),
  or: () => ({}),
  isNull: () => ({}),
  inArray: () => ({}),
  drizzleSql: () => ({}),
  automations: {
    id: "id",
    workspaceId: "workspace_id",
    createdBy: "created_by",
    triggerConfig: "trigger_config",
    metadata: "metadata",
    runCount: 0,
  },
  automationRuns: {},
  automationClaims: { id: "id" },
  playbookAutomations: {},
  skills: { id: "id", metadata: "metadata" },
  workspaceMembers: { workspaceId: "ws", userId: "uid" },
  workspaces: { id: "ws_id", settings: "settings" },
}));

const { handleAutomationTriggerMatch, isRuleSkillExpired, ruleIdOfAutomation } =
  await import("./automation-trigger-matcher.js");

const EVENT = {
  eventType: "entity.create.completed",
  subjectId: "entity-1",
  userId: "user-1",
  workspaceId: "ws-1",
  data: { profileSlug: "person" },
} as const;

/** One rule-compiled automation whose trigger matches EVENT. */
const RULE_AUTOMATION = {
  id: "auto-rule",
  workspaceId: "ws-1",
  triggerConfig: { eventPattern: "entity.create.completed" },
  metadata: { ruleId: "rule-1", kind: "rule" },
};

/** An ordinary automation carrying no rule back-reference. */
const PLAIN_AUTOMATION = {
  id: "auto-plain",
  workspaceId: "ws-1",
  triggerConfig: { eventPattern: "entity.create.completed" },
  metadata: {},
};

const PAST = "2020-01-01T00:00:00.000Z";
const FUTURE = "2999-01-01T00:00:00.000Z";

beforeEach(() => {
  selectResults = [];
  selectCall = 0;
  bossSend.mockClear();
  updateSet.mockClear();
  deleteCalls.mockClear();
  selectSpy.mockClear();
});

describe("the mirrored expiry predicate", () => {
  it("ABSENT is not EXPIRED — a rule with no expiry never lapses", () => {
    expect(isRuleSkillExpired({}, new Date())).toBe(false);
    expect(isRuleSkillExpired({ rule: {} }, new Date())).toBe(false);
    expect(isRuleSkillExpired(null, new Date())).toBe(false);
  });

  it("an UNREADABLE instant reads as absent, never as expired", () => {
    // Stored JSONB is DATA. A hand-edited value must not silently switch a live
    // rule off — the write door is where a bad instant is refused.
    expect(
      isRuleSkillExpired({ rule: { expiresAt: "2026-13-45" } }, new Date())
    ).toBe(false);
    expect(isRuleSkillExpired({ rule: { expiresAt: "" } }, new Date())).toBe(
      false
    );
  });

  it("a past instant is expired, a future one is not", () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    expect(isRuleSkillExpired({ rule: { expiresAt: PAST } }, now)).toBe(true);
    expect(isRuleSkillExpired({ rule: { expiresAt: FUTURE } }, now)).toBe(
      false
    );
  });

  it("the instant itself counts as passed (`<=`, matching the SSOT)", () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    expect(
      isRuleSkillExpired({ rule: { expiresAt: now.toISOString() } }, now)
    ).toBe(true);
  });

  it("reads the rule back-reference off an automation, and only a real one", () => {
    expect(ruleIdOfAutomation({ ruleId: "r" })).toBe("r");
    expect(ruleIdOfAutomation({ ruleId: "" })).toBeUndefined();
    expect(ruleIdOfAutomation({})).toBeUndefined();
    expect(ruleIdOfAutomation(null)).toBeUndefined();
  });
});

describe("an expired rule's automation does not fire", () => {
  it("SKIPS the automation whose rule has expired", async () => {
    selectResults = [
      [RULE_AUTOMATION],
      // the batched skills lookup
      [{ id: "rule-1", metadata: { rule: { expiresAt: PAST } } }],
    ];
    await handleAutomationTriggerMatch({ data: EVENT } as never);
    expect(bossSend).not.toHaveBeenCalled();
  });

  it("still fires while the rule is in effect", async () => {
    selectResults = [
      [RULE_AUTOMATION],
      [{ id: "rule-1", metadata: { rule: { expiresAt: FUTURE } } }],
    ];
    await handleAutomationTriggerMatch({ data: EVENT } as never);
    expect(bossSend).toHaveBeenCalledTimes(1);
  });

  it("a rule row that is GONE is not treated as expired", async () => {
    // Absent means "no expiry" on this side too. Deleting the rule is a
    // different decision from letting it lapse, and this worker makes neither.
    selectResults = [[RULE_AUTOMATION], []];
    await handleAutomationTriggerMatch({ data: EVENT } as never);
    expect(bossSend).toHaveBeenCalledTimes(1);
  });

  it("never touches an automation with no rule behind it — and issues NO extra query", async () => {
    selectResults = [[PLAIN_AUTOMATION]];
    await handleAutomationTriggerMatch({ data: EVENT } as never);
    expect(bossSend).toHaveBeenCalledTimes(1);
    // ONE select: the candidate set. The expiry lookup is pay-per-use — an
    // event whose candidates carry no `ruleId` must not cost a round trip.
    expect(selectSpy).toHaveBeenCalledTimes(1);
  });

  it("costs ONE extra query however many rule-backed candidates there are", async () => {
    selectResults = [
      [
        RULE_AUTOMATION,
        { ...RULE_AUTOMATION, id: "auto-rule-2" },
        {
          ...RULE_AUTOMATION,
          id: "auto-rule-3",
          metadata: { ruleId: "rule-2" },
        },
      ],
      [{ id: "rule-1", metadata: { rule: { expiresAt: PAST } } }],
    ];
    await handleAutomationTriggerMatch({ data: EVENT } as never);
    // Candidate select + exactly one batched skills select. No N+1.
    expect(selectSpy).toHaveBeenCalledTimes(2);
    // rule-2 has not expired, so its automation still fires — and only it.
    expect(bossSend).toHaveBeenCalledTimes(1);
  });

  it("ENFORCEMENT ≠ VISIBILITY — nothing is archived or deleted", async () => {
    selectResults = [
      [RULE_AUTOMATION],
      [{ id: "rule-1", metadata: { rule: { expiresAt: PAST } } }],
    ];
    await handleAutomationTriggerMatch({ data: EVENT } as never);
    expect(deleteCalls).not.toHaveBeenCalled();
    // The only `update().set()` in this worker is the run-count bump on a FIRE,
    // which did not happen. Nothing set a status.
    expect(updateSet).not.toHaveBeenCalled();
  });
});
