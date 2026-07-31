/**
 * Webhook trigger ingress — an inbound webhook fires webhook-typed automations.
 *
 * The gap this closes: `triggerType:"webhook"` + `triggerConfig.webhookSubscriptionId`
 * existed in the schema with ZERO runtime consumers — the trigger matcher only
 * ever selected `triggerType:"event"` automations. The authenticated ingress
 * (routers/webhooks-inbound.ts `/api/webhooks/inbound/:subscriptionId`) already
 * emitted `external_webhook.received.completed` with `data = { subscriptionId,
 * payload }`; this proves the matcher now ALSO selects webhook automations bound
 * to that subscription and fires them through the SAME run-creation door
 * (insert automation_run + enqueue `automation-execute`) as event/cron/manual:
 *   - a matching active webhook automation → a run is created + dispatched
 *   - the inbound body reaches the flow context at `trigger.payload.body`
 *   - the run is run-as-owner (`triggeredBy` = the subscription owner's userId)
 *   - no matching webhook automation → nothing is created (no run, no dispatch)
 *   - a non-webhook event never selects webhook automations
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const bossSend = vi.fn().mockResolvedValue(undefined);

// Captures the values passed to db.insert(automationRuns).values(...) so we can
// assert the run's triggerPayload + triggeredBy (run-as-owner).
const insertValues = vi.fn();

// Per-select-call results. The handler issues selects in a fixed order for a
// no-session event: [0] event-typed automations, [1] webhook-typed automations.
let selectResults: Array<
  Array<{
    id: string;
    triggerConfig: Record<string, unknown>;
    workspaceId: string;
  }>
> = [];
let selectCall = 0;

function makeThenable(result: unknown) {
  const p: Record<string, unknown> = {};
  const chain = () => p;
  p.from = chain;
  p.where = chain;
  p.set = chain;
  p.values = (v: unknown) => {
    insertValues(v);
    return p;
  };
  p.onConflictDoNothing = () => p;
  p.returning = () => Promise.resolve(result);
  p.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(result).then(res, rej);
  return p;
}

const selectSpy = vi.fn((..._args: unknown[]) => {
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
    select: (...args: unknown[]) => selectSpy(...args),
    insert: () => makeThenable([{ id: "run-webhook" }]),
    update: () => makeThenable(undefined),
  },
  eq: () => ({}),
  and: () => ({}),
  or: () => ({}),
  isNull: () => ({}),
  inArray: () => ({}),
  drizzleSql: () => ({}),
  automations: { id: "id", workspaceId: "workspace_id", runCount: 0 },
  automationRuns: {},
  automationClaims: { id: "id" },
  playbookAutomations: {},
  workspaceMembers: {},
  workspaces: {},
}));

const { handleAutomationTriggerMatch } =
  await import("./automation-trigger-matcher.js");

const SUB_ID = "sub-abc";
const OWNER_ID = "owner-1";

// The event the authenticated inbound ingress emits (subjectType.action.completed).
const WEBHOOK_EVENT = {
  eventType: "external_webhook.received.completed",
  subjectId: SUB_ID,
  userId: OWNER_ID,
  workspaceId: "ws-1",
  data: { subscriptionId: SUB_ID, payload: { order: 42, kind: "created" } },
} as const;

describe("webhook trigger ingress → run creation", () => {
  beforeEach(() => {
    bossSend.mockClear();
    selectSpy.mockClear();
    insertValues.mockClear();
    selectCall = 0;
    selectResults = [];
  });

  it("fires a matching active webhook automation through the run-creation door, exposing the body + running as owner", async () => {
    selectResults = [
      [], // event-typed automations: none
      [
        {
          id: "auto-webhook",
          triggerConfig: { webhookSubscriptionId: SUB_ID },
          workspaceId: "ws-1",
        },
      ],
    ];

    await handleAutomationTriggerMatch({ data: { ...WEBHOOK_EVENT } });

    // A run was dispatched through the canonical door.
    expect(bossSend).toHaveBeenCalledTimes(1);
    const [queue, payload] = bossSend.mock.calls[0] as [
      string,
      { runId: string; automationId: string; workspaceId: string },
    ];
    expect(queue).toBe("automation-execute");
    expect(payload.automationId).toBe("auto-webhook");
    expect(payload.runId).toBe("run-webhook");

    // The run row: run-as-owner + inbound body exposed at trigger.payload.body.
    const runValues = insertValues.mock.calls[0][0] as {
      automationId: string;
      triggeredBy: string;
      triggerPayload: Record<string, unknown>;
    };
    expect(runValues.automationId).toBe("auto-webhook");
    expect(runValues.triggeredBy).toBe(OWNER_ID); // subscription owner, not anon
    expect(runValues.triggerPayload).toMatchObject({
      type: "webhook",
      webhookSubscriptionId: SUB_ID,
      body: { order: 42, kind: "created" },
    });
  });

  it("creates no run when no webhook automation is bound to the subscription", async () => {
    selectResults = [
      [], // event-typed: none
      [], // webhook-typed: none (paused / non-webhook / wrong subscription filtered out by the DB query)
    ];

    await handleAutomationTriggerMatch({ data: { ...WEBHOOK_EVENT } });

    expect(bossSend).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("never selects webhook automations for a non-webhook event", async () => {
    // A plain entity event: the webhook branch is gated on the event type, so
    // only ONE select (the event-typed set) runs — no webhook select at all.
    selectResults = [
      [], // event-typed: none → early return before any webhook select
    ];

    await handleAutomationTriggerMatch({
      data: {
        eventType: "entity.create.completed",
        subjectId: "entity-1",
        userId: OWNER_ID,
        workspaceId: "ws-1",
        data: { profileSlug: "person" },
      },
    });

    expect(bossSend).not.toHaveBeenCalled();
    // Exactly one select (event-typed); the webhook select is never issued.
    expect(selectSpy).toHaveBeenCalledTimes(1);
  });
});
