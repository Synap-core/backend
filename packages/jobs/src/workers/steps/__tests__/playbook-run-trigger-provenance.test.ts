/**
 * TRIGGER PROVENANCE — "which fact am I here because of?"
 *
 * Before 0256 the answer dead-ended. `automation_runs` carried `triggered_by`
 * (a userId or the literal "system") and `trigger_payload` (an envelope the
 * MATCHER rebuilt), but no pointer to the `events` row that actually matched —
 * so a session spawned by a rule could not be walked back to the fact that
 * caused it, and the fact could not be walked forward to what it produced.
 *
 * This drives the REAL seam end to end, with mocks only at the DB boundary:
 *
 *   handleAutomationTriggerMatch  (the real matcher)
 *     → the `automation_runs` INSERT values          — assert `triggerEventId`
 *     → the `automation-execute` boss payload        — assert it rides along
 *   executePlaybookRun            (the real step, fed THAT payload)
 *     → the playbook runner's `chainContext`         — assert the VALUE arrives
 *     → the `events` UPDATE                          — assert the back-stamp
 *
 * Nothing between the two halves is hand-built: the executor payload the step
 * receives is the object the matcher actually sent. That is the point — a
 * projection that drops the field between them is exactly the defect class this
 * repo keeps shipping, and a test that hand-builds the step's input downstream
 * of it stays green while the field never arrives.
 *
 * The PRODUCER half is covered by the second describe below, which drives the
 * REAL `automation-trigger-match` reactor out of the live registry rather than
 * hand-writing the queue payload — so the exact key the reactor emits and the
 * exact key the matcher reads are proven to be the same key. That was the whole
 * defect: the id existed at the producer and never reached the run row.
 *
 * WHAT THIS DOES NOT COVER, measured: the hop ABOVE the reactor,
 * `recordDomainMutation` setting `eventId` from the awaited `EventRecord`. It
 * lives in @synap/api, which @synap/jobs cannot import (circular dep), and is
 * pinned by `packages/api/src/utils/domain-mutation.event-id.test.ts`. Also not
 * covered: the fingerprint must stay inert to this field — that is its own
 * tripwire, `automation-trigger-matcher.fingerprint-provenance.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const bossSend = vi.fn().mockResolvedValue(undefined);

/** Every `.values({...})` the code under test inserts, in order. */
const insertedValues: Array<Record<string, unknown>> = [];
/** Every `.set({...})` on an UPDATE, paired with the table it targeted. */
const updateCalls: Array<{ table: unknown; set: Record<string, unknown> }> = [];

let activeAutomationsResult: Array<{
  id: string;
  triggerConfig: Record<string, unknown>;
  workspaceId: string;
}> = [];

/** A drizzle-builder-shaped thenable: chain methods return itself, awaiting
 *  it (or `.returning()`) resolves to `result`. Same shape the sibling matcher
 *  suites use. */
function makeThenable(result: unknown, onSet?: (v: unknown) => void) {
  const p: Record<string, unknown> = {};
  const chain = () => p;
  p.from = chain;
  p.where = chain;
  p.set = (v: unknown) => {
    onSet?.(v);
    return p;
  };
  p.values = (v: unknown) => {
    insertedValues.push(v as Record<string, unknown>);
    return p;
  };
  p.onConflictDoNothing = chain;
  p.returning = () => Promise.resolve(result);
  p.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(result).then(res, rej);
  return p;
}

const EVENTS_TABLE = { __table: "events" };

// importOriginal + spread, NOT a total factory. Two reasons, both load-bearing:
// `getReactors` must be the REAL registry (this suite drives the real
// automation-trigger-match reactor), and a total `vi.mock` silently kills the
// WHOLE FILE the moment the source under test gains an import — a failure that
// reports as "0 tests" and reads like success everywhere.
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
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
      // No subject binding — keeps the step's IDOR guard inert, which is the
      // ordinary shape for a rule that names no entity.
      entities: { findFirst: () => Promise.resolve(undefined) },
    },
    select: () => makeThenable(activeAutomationsResult),
    // The run insert returns the run id; the claim insert returns a claim row
    // (a non-empty array = claim won, so the matcher proceeds to enqueue).
    insert: () => makeThenable([{ id: "run-1" }]),
    update: (table: unknown) =>
      makeThenable(undefined, (set) =>
        updateCalls.push({ table, set: set as Record<string, unknown> })
      ),
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
  entities: {},
  events: EVENTS_TABLE,
  proposals: {},
  ProposalStatus: { PENDING: "pending" },
  insertPendingProposal: vi.fn(),
  verifyPermission: vi.fn(),
}));

vi.mock("@synap/database/agent-governance", () => ({
  resolveAgentGovernanceDecision: vi.fn(async () => ({
    decision: "not-agent" as const,
  })),
}));
vi.mock("@synap/governance-policy", () => ({
  requiredPermissionFor: vi.fn(() => "write"),
}));

const { getReactors } = await import("@synap/events");
const { handleAutomationTriggerMatch } =
  await import("../../automation-trigger-matcher.js");
const { executePlaybookRun } = await import("../playbook-run.js");
const { registerPlaybookRunner } = await import("../../capability-dispatch.js");
import type { StepContext } from "../../automation-executor-types.js";

const EVENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const runnerMock = vi.fn(async (_input: unknown) => ({
  run: { id: "pbrun-1", status: "running" },
  session: { id: SESSION_ID, channelId: "chan-1" },
}));

const stepContext = () =>
  ({
    trigger: { payload: {} },
    steps: {},
    automation: { id: "auto-1", state: {} },
  }) as unknown as StepContext;

/** Drive the real matcher for one event and return what it enqueued. */
async function fireEvent(eventId?: string) {
  await handleAutomationTriggerMatch({
    data: {
      eventType: "entity.create.completed",
      subjectId: "entity-1",
      userId: "user-1",
      workspaceId: "ws-1",
      data: { profileSlug: "person" },
      ...(eventId === undefined ? {} : { eventId }),
    },
  } as never);
  expect(bossSend).toHaveBeenCalledTimes(1);
  return bossSend.mock.calls[0][1] as {
    automationContext: Record<string, unknown>;
  };
}

beforeEach(() => {
  bossSend.mockClear();
  runnerMock.mockClear();
  insertedValues.length = 0;
  updateCalls.length = 0;
  registerPlaybookRunner(runnerMock as never);
  activeAutomationsResult = [
    {
      id: "auto-1",
      triggerConfig: { eventPattern: "entity.create.completed" },
      workspaceId: "ws-1",
    },
  ];
});

describe("trigger provenance — event → run → session → event", () => {
  it("stamps the triggering event on the run row and carries it to the executor", async () => {
    const payload = await fireEvent(EVENT_ID);

    // The RUN row claims the event that fired it. Asserting the VALUE on the
    // insert, not merely that a column exists on the schema.
    const runInsert = insertedValues.find((v) => "triggerPayload" in v);
    expect(runInsert).toBeDefined();
    expect(runInsert!.triggerEventId).toBe(EVENT_ID);

    // …and it rides the executor payload, which is the only way the step can
    // ever see it.
    expect(payload.automationContext.triggerEventId).toBe(EVENT_ID);
  });

  it("the step hands it to the spine and back-stamps events.session_id", async () => {
    const payload = await fireEvent(EVENT_ID);

    // The step is fed the matcher's OWN payload — nothing hand-built between.
    await executePlaybookRun(
      { playbookId: "pb-1" },
      stepContext(),
      "ws-1",
      "user-1",
      payload.automationContext as never
    );

    // Forward edge: the spine receives the event id on the chain context it
    // stamps onto the session's `metadata.automationChainContext`.
    expect(runnerMock).toHaveBeenCalledTimes(1);
    const runnerInput = runnerMock.mock.calls[0][0] as {
      chainContext?: { triggerEventId?: string };
    };
    expect(runnerInput.chainContext?.triggerEventId).toBe(EVENT_ID);

    // Reverse edge: the event row now names the session it produced.
    const eventUpdate = updateCalls.find((u) => u.table === EVENTS_TABLE);
    expect(eventUpdate).toBeDefined();
    expect(eventUpdate!.set).toEqual({ sessionId: SESSION_ID });
  });

  it("no event id ⇒ NO claim written, on either edge", async () => {
    // A cron / manual / webhook run has no triggering event row. NULL must mean
    // "nothing is claimed", never a junk pointer — and the back-stamp must not
    // fire at all, or a fan-out would overwrite an event's real session.
    const payload = await fireEvent(undefined);

    const runInsert = insertedValues.find((v) => "triggerPayload" in v);
    expect(runInsert!.triggerEventId).toBeUndefined();
    expect(payload.automationContext.triggerEventId).toBeUndefined();

    await executePlaybookRun(
      { playbookId: "pb-1" },
      stepContext(),
      "ws-1",
      "user-1",
      payload.automationContext as never
    );
    expect(updateCalls.find((u) => u.table === EVENTS_TABLE)).toBeUndefined();
  });
});

describe("the PRODUCER half — the reactor emits the key the matcher reads", () => {
  /** The live reactor, out of the real registry. Not a hand-written payload. */
  function triggerReactor() {
    const r = getReactors().find((x) => x.id === "automation-trigger-match");
    // Non-vacuity: if the registry were empty or the id were renamed, every
    // assertion below would be skipped and this suite would pass over nothing.
    expect(
      r,
      "automation-trigger-match reactor is not registered"
    ).toBeDefined();
    return r!;
  }

  it("forwards eventId TOP-LEVEL, and never inside `data`", async () => {
    const sent: Array<[string, Record<string, unknown>]> = [];
    await triggerReactor().handler(
      {
        subjectType: "entity",
        action: "create",
        subjectId: "entity-1",
        userId: "user-1",
        workspaceId: "ws-1",
        data: { profileSlug: "person" },
        eventId: EVENT_ID,
      },
      {
        boss: {
          send: async (q: string, p: Record<string, unknown>) => {
            sent.push([q, p]);
            return null;
          },
        },
      } as never
    );

    expect(sent).toHaveLength(1);
    const [queue, payload] = sent[0];
    expect(queue).toBe("automation-trigger-match");

    // THE seam: the reactor's key and the matcher's key are the same key.
    expect(payload.eventId).toBe(EVENT_ID);

    // …and the fingerprint input is untouched. `data.eventId` here would make
    // every event's fingerprint unique and disable the exactly-once claim; see
    // automation-trigger-matcher.fingerprint-provenance.test.ts.
    expect((payload.data as Record<string, unknown>).eventId).toBeUndefined();
  });

  it("an emit with no log row claims NO event", async () => {
    // A bare `emitSideEffects` that fires without a matching append (a facet
    // change's parent refresh, document re-indexing), or a failed best-effort
    // append. Null means "nothing claimed", never a guessed or stale id.
    const sent: Array<Record<string, unknown>> = [];
    await triggerReactor().handler(
      {
        subjectType: "entity",
        action: "create",
        subjectId: "entity-1",
        userId: "user-1",
        workspaceId: "ws-1",
      },
      {
        boss: {
          send: async (_q: string, p: Record<string, unknown>) => {
            sent.push(p);
            return null;
          },
        },
      } as never
    );
    expect(sent[0].eventId).toBeNull();
  });

  it("END TO END: reactor payload → matcher → run row + session + events row", async () => {
    // The whole chain with NOTHING hand-built between the halves: the object
    // the reactor actually emitted is the object the matcher consumes, and the
    // object the matcher actually enqueued is the object the step consumes.
    const sent: Array<Record<string, unknown>> = [];
    await triggerReactor().handler(
      {
        subjectType: "entity",
        action: "create",
        subjectId: "entity-1",
        userId: "user-1",
        workspaceId: "ws-1",
        data: { profileSlug: "person" },
        eventId: EVENT_ID,
      },
      {
        boss: {
          send: async (_q: string, p: Record<string, unknown>) => {
            sent.push(p);
            return null;
          },
        },
      } as never
    );

    await handleAutomationTriggerMatch({ data: sent[0] } as never);
    const executorPayload = bossSend.mock.calls[0][1] as {
      automationContext: Record<string, unknown>;
    };

    await executePlaybookRun(
      { playbookId: "pb-1" },
      stepContext(),
      "ws-1",
      "user-1",
      executorPayload.automationContext as never
    );

    // 1. the run row names the event
    const runInsert = insertedValues.find((v) => "triggerPayload" in v);
    expect(runInsert!.triggerEventId).toBe(EVENT_ID);
    // 2. the session names the event
    const runnerInput = runnerMock.mock.calls[0][0] as {
      chainContext?: { triggerEventId?: string };
    };
    expect(runnerInput.chainContext?.triggerEventId).toBe(EVENT_ID);
    // 3. the event row names the session
    const eventUpdate = updateCalls.find((u) => u.table === EVENTS_TABLE);
    expect(eventUpdate!.set).toEqual({ sessionId: SESSION_ID });
  });
});
