/**
 * `external_message.received` automations must honor `triggerConfig.channelId`.
 *
 * The defect this locks: `matchTriggerSpecificFilters` gated the channelId
 * check behind `eventType.startsWith("channel_message.")` only. An
 * `external_message.received` event CARRIES `data.channelId` (the inbound
 * recorder's emitSideEffects puts it there), so a per-channel extraction
 * automation could be CONFIGURED with a channel binding that the matcher then
 * ignored — it fired for every inbound channel in the lens.
 *
 * Behavioural, not shape-only: the db is mocked and the assertions are on which
 * automations actually reached `fireAutomation` (an inserted run + an enqueued
 * `automation-execute` job).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const bossSend = vi.fn().mockResolvedValue(undefined);
const insertValues = vi.fn();

let selectResults: Array<
  Array<{
    id: string;
    triggerConfig: Record<string, unknown>;
    workspaceId: string | null;
  }>
> = [];
let selectCall = 0;

function makeThenable(result: unknown) {
  const p: Record<string, unknown> = {};
  const chain = () => p;
  p.from = chain;
  p.set = chain;
  p.where = () => p;
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
    // The run insert returns a row, then the CLAIM insert must also return one
    // (a falsy claim marks the run skipped and never enqueues).
    insert: () => makeThenable([{ id: "run-1" }]),
    update: () => makeThenable(undefined),
  },
  eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
  and: (...args: unknown[]) => ({ op: "and", args }),
  or: (...args: unknown[]) => ({ op: "or", args }),
  isNull: (col: unknown) => ({ op: "isNull", col }),
  inArray: (col: unknown, vals: unknown) => ({ op: "inArray", col, vals }),
  drizzleSql: () => ({}),
  automations: {
    id: "id",
    workspaceId: "workspace_id",
    createdBy: "created_by",
    runCount: 0,
  },
  automationRuns: {},
  automationClaims: { id: "id" },
  playbookAutomations: {},
  workspaceMembers: { workspaceId: "ws_member_workspace_id", userId: "uid" },
  workspaces: { id: "ws_id", settings: "settings" },
}));

const { handleAutomationTriggerMatch } =
  await import("./automation-trigger-matcher.js");

const INBOUND_EVENT = {
  eventType: "external_message.received.completed",
  subjectId: "chan-A",
  userId: "user-1",
  workspaceId: "ws-1",
  data: {
    channelId: "chan-A",
    provider: "discord",
    entityId: null,
    messageId: "msg-1",
  },
} as const;

/** Automation ids that actually opened a run. */
function firedAutomationIds(): string[] {
  return insertValues.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((v) => typeof v?.automationId === "string")
    .map((v) => v.automationId as string);
}

describe("external_message channelId binding", () => {
  beforeEach(() => {
    bossSend.mockClear();
    selectSpy.mockClear();
    insertValues.mockClear();
    selectCall = 0;
    selectResults = [];
  });

  it("fires an automation bound to THIS channel", async () => {
    selectResults = [
      [
        {
          id: "auto-bound",
          workspaceId: "ws-1",
          triggerConfig: {
            eventPattern: "external_message.received.completed",
            channelId: "chan-A",
          },
        },
      ],
    ];

    await handleAutomationTriggerMatch({ data: { ...INBOUND_EVENT } });

    expect(firedAutomationIds()).toEqual(["auto-bound"]);
    expect(bossSend).toHaveBeenCalledWith(
      "automation-execute",
      expect.objectContaining({ automationId: "auto-bound" })
    );
  });

  it("does NOT fire an automation bound to a DIFFERENT channel (the bug)", async () => {
    selectResults = [
      [
        {
          id: "auto-other",
          workspaceId: "ws-1",
          triggerConfig: {
            eventPattern: "external_message.received.completed",
            channelId: "chan-B",
          },
        },
      ],
    ];

    await handleAutomationTriggerMatch({ data: { ...INBOUND_EVENT } });

    expect(firedAutomationIds()).toEqual([]);
    expect(bossSend).not.toHaveBeenCalled();
  });

  it("still fires an UNBOUND (workspace-wide) external_message automation", async () => {
    selectResults = [
      [
        {
          id: "auto-wide",
          workspaceId: "ws-1",
          triggerConfig: { eventPattern: "external_message.*" },
        },
      ],
    ];

    await handleAutomationTriggerMatch({ data: { ...INBOUND_EVENT } });

    expect(firedAutomationIds()).toEqual(["auto-wide"]);
  });

  it("leaves channel_message binding behaviour unchanged", async () => {
    selectResults = [
      [
        {
          id: "auto-chanmsg",
          workspaceId: "ws-1",
          triggerConfig: {
            eventPattern: "channel_message.created.completed",
            channelId: "chan-B",
          },
        },
      ],
    ];

    await handleAutomationTriggerMatch({
      data: {
        ...INBOUND_EVENT,
        eventType: "channel_message.created.completed",
      },
    });

    expect(firedAutomationIds()).toEqual([]);
  });
});
