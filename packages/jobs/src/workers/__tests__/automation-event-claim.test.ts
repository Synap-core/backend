/**
 * D5 automation event fingerprint helpers + claim-skip path.
 *
 * Pure key builders are unit-tested directly. Claim skip is exercised via a
 * mocked matcher fire: when automation_claims ON CONFLICT returns no row, the
 * run is marked skipped and automation-execute is NOT enqueued.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const bossSend = vi.fn().mockResolvedValue(undefined);
const insertValues = vi.fn();
const updateSets = vi.fn();

/** First insert = automation_runs; second = automation_claims. */
let claimReturning: Array<{ id: string }> = [{ id: "claim-1" }];
let insertCall = 0;

function makeThenable(result: unknown) {
  const p: Record<string, unknown> = {};
  const chain = () => p;
  p.from = chain;
  p.where = chain;
  p.set = (v: unknown) => {
    updateSets(v);
    return p;
  };
  p.values = (v: unknown) => {
    insertValues(v);
    return p;
  };
  p.onConflictDoNothing = () => p;
  p.returning = () => {
    // First insert is always the run; subsequent is the claim.
    if (insertCall === 0) {
      insertCall += 1;
      return Promise.resolve([{ id: "run-1" }]);
    }
    insertCall += 1;
    return Promise.resolve(result);
  };
  p.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(result).then(res, rej);
  return p;
}

let selectResults: Array<
  Array<{
    id: string;
    triggerConfig: Record<string, unknown>;
    workspaceId: string;
  }>
> = [];
let selectCall = 0;

const selectSpy = vi.fn(() => {
  const result = selectResults[selectCall] ?? [];
  selectCall += 1;
  return makeThenable(result);
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
    query: {
      focusSessions: { findFirst: () => Promise.resolve(null) },
      links: { findMany: () => Promise.resolve([]) },
    },
    select: selectSpy,
    insert: () => makeThenable(claimReturning),
    update: () => makeThenable(undefined),
  },
  eq: () => ({}),
  and: () => ({}),
  or: () => ({}),
  isNull: () => ({}),
  inArray: () => ({}),
  drizzleSql: () => ({}),
  automations: { id: "id", workspaceId: "workspace_id", runCount: 0 },
  automationRuns: { id: "id" },
  automationClaims: { id: "id" },
  playbookAutomations: {},
  workspaceMembers: {},
  workspaces: {},
}));

const {
  handleAutomationTriggerMatch,
  matchRuleScopeFilters,
  buildAutomationEventClaimKey,
  resolveAutomationEventFingerprintId,
  AUTOMATION_EVENT_CLAIM_NAMESPACE,
} = await import("../automation-trigger-matcher.js");

describe("automation event fingerprint helpers", () => {
  it("prefers messageId from payload when present", () => {
    expect(
      resolveAutomationEventFingerprintId({
        eventType: "external_message.received.completed",
        subjectId: "chan-1",
        data: { messageId: "discord-snowflake-9", channelId: "c" },
      })
    ).toBe("discord-snowflake-9");
  });

  it("prefers explicit eventId over messageId", () => {
    expect(
      resolveAutomationEventFingerprintId({
        eventType: "entity.create.completed",
        subjectId: "e1",
        data: { eventId: "evt-1", messageId: "m1" },
      })
    ).toBe("evt-1");
  });

  it("stable-hashes when no native id is present", () => {
    const a = resolveAutomationEventFingerprintId({
      eventType: "entity.create.completed",
      subjectId: "e1",
      data: { profileSlug: "person", title: "Ada" },
    });
    const b = resolveAutomationEventFingerprintId({
      eventType: "entity.create.completed",
      subjectId: "e1",
      data: { title: "Ada", profileSlug: "person" }, // key order differs
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it("builds claim key with none subject when entity missing", () => {
    expect(
      buildAutomationEventClaimKey({
        automationId: "auto-1",
        eventType: "external_message.received.completed",
        subjectEntityId: null,
        eventFingerprintId: "msg-1",
      })
    ).toBe("auto-1:external_message.received.completed:none:msg-1");
  });

  it("uses automation-event namespace constant", () => {
    expect(AUTOMATION_EVENT_CLAIM_NAMESPACE).toBe("automation-event");
  });
});

describe("matcher claim skip (event fingerprint held)", () => {
  beforeEach(() => {
    bossSend.mockClear();
    insertValues.mockClear();
    updateSets.mockClear();
    selectSpy.mockClear();
    selectCall = 0;
    insertCall = 0;
    selectResults = [];
    claimReturning = [{ id: "claim-1" }];
  });

  it("enqueues when claim is acquired", async () => {
    selectResults = [
      [
        {
          id: "auto-1",
          triggerConfig: { eventPattern: "entity.create.completed" },
          workspaceId: "ws-1",
        },
      ],
    ];
    claimReturning = [{ id: "claim-won" }];

    await handleAutomationTriggerMatch({
      data: {
        eventType: "entity.create.completed",
        subjectId: "e1",
        userId: "u1",
        workspaceId: "ws-1",
        data: { eventId: "evt-stable" },
      },
    });

    expect(bossSend).toHaveBeenCalledTimes(1);
    expect(bossSend.mock.calls[0]![0]).toBe("automation-execute");

    // Run insert + claim insert
    expect(insertValues).toHaveBeenCalled();
    const claimInsert = insertValues.mock.calls.find(
      (c) =>
        (c[0] as { namespace?: string })?.namespace ===
        AUTOMATION_EVENT_CLAIM_NAMESPACE
    );
    expect(claimInsert).toBeDefined();
    expect((claimInsert![0] as { claimKey: string }).claimKey).toContain(
      "evt-stable"
    );
  });

  it("skips fire when claim already held", async () => {
    selectResults = [
      [
        {
          id: "auto-1",
          triggerConfig: { eventPattern: "entity.create.completed" },
          workspaceId: "ws-1",
        },
      ],
    ];
    // Claim insert returns empty → conflict (already held)
    claimReturning = [];

    await handleAutomationTriggerMatch({
      data: {
        eventType: "entity.create.completed",
        subjectId: "e1",
        userId: "u1",
        workspaceId: "ws-1",
        data: { eventId: "evt-dup" },
      },
    });

    expect(bossSend).not.toHaveBeenCalled();
    expect(updateSets).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "skipped",
        errorMessage: "event_claim_already_held",
      })
    );
  });
});

describe("matcher daily cap (triggerConfig.maxRunsPerDay)", () => {
  beforeEach(() => {
    bossSend.mockClear();
    updateSets.mockClear();
    selectSpy.mockClear();
    selectCall = 0;
    insertCall = 0;
    claimReturning = [{ id: "claim-won" }];
  });

  const fire = () =>
    handleAutomationTriggerMatch({
      data: {
        eventType: "entity.create.completed",
        subjectId: "e1",
        userId: "u1",
        workspaceId: "ws-1",
        data: { eventId: `evt-${Math.random()}` },
      },
    });

  const capped = (n: number) => [
    [
      {
        id: "auto-1",
        triggerConfig: {
          eventPattern: "entity.create.completed",
          maxRunsPerDay: 3,
        },
        workspaceId: "ws-1",
      },
    ],
    // The rolling-day count of runs that RAN (the cap read).
    [{ n }] as never,
  ];

  it("at the cap → the run is recorded skipped / daily_cap_reached and NOT enqueued", async () => {
    selectResults = capped(3);
    await fire();
    expect(bossSend).not.toHaveBeenCalled();
    expect(updateSets).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "skipped",
        errorMessage: "daily_cap_reached",
      })
    );
  });

  it("under the cap → fires", async () => {
    selectResults = capped(2);
    await fire();
    expect(bossSend).toHaveBeenCalledTimes(1);
    expect(updateSets).not.toHaveBeenCalledWith(
      expect.objectContaining({ errorMessage: "daily_cap_reached" })
    );
  });
});

describe("stage worker idempotency — per (thing, transition event) (work model L4)", () => {
  const AUTOMATION = "auto-worker";
  const move = (transitionId: string) => ({
    eventType: "entity.transition.completed",
    subjectId: "deal-1",
    // The emit's payload: the StatusTransition spread + lifecycleProfile.
    data: {
      transitionId,
      entityId: "deal-1",
      profileSlug: "deal",
      role: null,
      from: "draft",
      to: "review",
      category: "active",
      lifecycleProfile: "deal",
    },
  });
  const keyOf = (m: ReturnType<typeof move>) =>
    buildAutomationEventClaimKey({
      automationId: AUTOMATION,
      eventType: m.eventType,
      subjectEntityId: m.subjectId,
      eventFingerprintId: resolveAutomationEventFingerprintId(m),
    });

  it("one move delivered twice is ONE claim", () => {
    expect(keyOf(move("t-1"))).toBe(keyOf(move("t-1")));
  });

  it("the same draft→review move made twice is TWO claims (two moves, not a redelivery)", () => {
    expect(keyOf(move("t-1"))).not.toBe(keyOf(move("t-2")));
  });

  it("the move's own id IS the fingerprint (named, not left to a payload hash)", () => {
    expect(resolveAutomationEventFingerprintId(move("t-9"))).toBe("t-9");
  });
});

describe("a project-scoped worker and a ROLE's move (work model L4, edge 9)", () => {
  // A role's transition names the PARENT entity as its subject (the emit's
  // `subjectId: t.entityId`), so its project membership is the entity's.
  const facts = (projects: string[]) => ({
    entityId: "person-1",
    projectIds: new Set(projects),
  });
  it("the move of a thing in project P fires P's worker, not Q's", () => {
    const event = "entity.transition.completed";
    expect(
      matchRuleScopeFilters(event, { projectId: "P" } as never, facts(["P"]))
    ).toBe(true);
    expect(
      matchRuleScopeFilters(event, { projectId: "Q" } as never, facts(["P"]))
    ).toBe(false);
  });
  it("a membership that could not be READ never matches", () => {
    expect(
      matchRuleScopeFilters(
        "entity.transition.completed",
        { projectId: "P" } as never,
        { entityId: "person-1", projectIds: null }
      )
    ).toBe(false);
  });
});
