/**
 * An AGENT delegating a slot meets the ONE hand-off gate (ticket a6053f75).
 *
 * `POST /focus-sessions/:id/outputs/delegate` called `attachSessionAgent` and
 * `triggerAutoRespond` directly: an agent's key put ANOTHER agent on the
 * roster and woke it with no `focus_session/assign_agent` proposal, a paused
 * agent included, and the ask and slot move were recorded as the person's.
 * `delegateExpectedOutput` now asks `gateAgentHandOff` first when an agent
 * hands the slot to another agent: `denied` and `proposed` write nothing
 * (no post, no roster, no stamp, no turn); `granted` proceeds, with the post
 * and the slot move attributed to the agent.
 *
 * The gate itself (route refusal of a paused agent, propose by default) is
 * tested on PGlite in `agent-hand-off.pglite.test.ts`; here it is a spy, and
 * what is asserted is that this door REACHES it with the right hand-off and
 * obeys its answer. DB-free: `@synap/database` partially mocked as in
 * `routers/focus-sessions.delegate-output.test.ts`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const SESSION = "11111111-1111-4111-8111-111111111111";
const OWNER = "owner-1";
const CALLER_AGENT = "agent-caller";
const OTHER_AGENT = "agent-other";
const CHANNEL = "44444444-4444-4444-8444-444444444444";

const h = vi.hoisted(() => ({
  /** The agent USER the requested type resolves to. */
  delegate: { id: "agent-other" } as { id: string } | undefined,
  txSets: [] as Record<string, unknown>[],
  slotMoves: [] as Array<{ actor: unknown }>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const tx = {
    select: () => {
      const b: Record<string, unknown> = {
        from: () => b,
        where: () => b,
        for: async () => [
          { expectedOutputs: [{ kind: "document", label: "Draft" }] },
        ],
      };
      return b;
    },
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        h.txSets.push(patch);
        return { where: async () => undefined };
      },
    }),
  };
  return {
    ...actual,
    db: {
      transaction: async (cb: (t: unknown) => unknown) => cb(tx),
      query: new Proxy({} as Record<string, unknown>, {
        get: (_t, table) => {
          if (table === "focusSessions")
            return {
              findFirst: async () => ({
                id: SESSION,
                userId: OWNER,
                workspaceId: null,
                goal: "Ship it",
                title: "Ship it",
                channelId: CHANNEL,
                expectedOutputs: [{ kind: "document", label: "Draft" }],
              }),
            };
          if (table === "users") return { findFirst: async () => h.delegate };
          return { findFirst: async () => undefined };
        },
      }),
    },
    oweSlotTransitions: async (_tx: unknown, args: { actor: unknown }) => {
      h.slotMoves.push({ actor: args.actor });
    },
  };
});

const gateAgentHandOff = vi.fn();
vi.mock("../agent-hand-off.js", () => ({
  gateAgentHandOff: (...a: unknown[]) => gateAgentHandOff(...a),
}));
const attachSessionAgent = vi.fn(async () => ({ status: "attached" }));
vi.mock("../attach-session-agent.js", () => ({
  attachSessionAgent: (...a: unknown[]) =>
    (attachSessionAgent as unknown as (...x: unknown[]) => unknown)(...a),
}));
vi.mock("../ensure-session-channel.js", () => ({
  ensureSessionChannel: async () => CHANNEL,
}));
const postChannelMessage = vi.fn(async (_p: Record<string, unknown>) => ({
  success: true as const,
  messageId: "msg-1",
  channelId: CHANNEL,
}));
vi.mock("../../messaging/post-message.js", () => ({
  postChannelMessage: (...a: unknown[]) =>
    (postChannelMessage as unknown as (...x: unknown[]) => unknown)(...a),
}));
const triggerAutoRespond = vi.fn(async (_p: Record<string, unknown>) => true);
vi.mock("../../../utils/trigger-auto-respond.js", () => ({
  triggerAutoRespond: (...a: unknown[]) =>
    (triggerAutoRespond as unknown as (...x: unknown[]) => unknown)(...a),
}));

const { delegateExpectedOutput } = await import("../delegate-output.js");

const delegate = (actingAgentUserId: string | null) =>
  delegateExpectedOutput({
    sessionId: SESSION,
    userId: OWNER,
    expectedLabel: "Draft",
    agentType: "writer",
    actingAgentUserId,
  });

/** Nothing reached the room, the roster, the slot or a turn. */
function expectNothingWritten() {
  expect(postChannelMessage).not.toHaveBeenCalled();
  expect(attachSessionAgent).not.toHaveBeenCalled();
  expect(triggerAutoRespond).not.toHaveBeenCalled();
  expect(h.txSets).toEqual([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.delegate = { id: OTHER_AGENT };
  h.txSets.length = 0;
  h.slotMoves.length = 0;
});

describe("an agent handing a slot to ANOTHER agent goes through the hand-off gate", () => {
  it("asks the gate for exactly that hand-off", async () => {
    gateAgentHandOff.mockResolvedValue({
      status: "proposed",
      agentId: OTHER_AGENT,
      proposalId: "prop-1",
    });
    await delegate(CALLER_AGENT);
    expect(gateAgentHandOff).toHaveBeenCalledTimes(1);
    expect(gateAgentHandOff.mock.calls[0]![0]).toMatchObject({
      userId: OWNER,
      agentUserId: CALLER_AGENT,
      sessionId: SESSION,
      agentId: OTHER_AGENT,
    });
  });

  it("proposed (the default) → the proposal is the answer; nothing written", async () => {
    gateAgentHandOff.mockResolvedValue({
      status: "proposed",
      agentId: OTHER_AGENT,
      proposalId: "prop-1",
      reviewUrl: "https://pod/review/prop-1",
    });
    expect(await delegate(CALLER_AGENT)).toMatchObject({
      status: "proposed",
      proposalId: "prop-1",
    });
    expectNothingWritten();
  });

  it("refused (a paused agent, one not the owner's) → refused by name; nothing written", async () => {
    gateAgentHandOff.mockResolvedValue({
      status: "denied",
      agentId: OTHER_AGENT,
      reason: "This agent is paused.",
    });
    expect(await delegate(CALLER_AGENT)).toEqual({
      status: "refused",
      reason: "This agent is paused.",
    });
    expectNothingWritten();
  });

  it("granted (a rule says auto) → delegated, the ask and the slot move are the agent's", async () => {
    gateAgentHandOff.mockResolvedValue({
      status: "granted",
      agentId: OTHER_AGENT,
    });
    expect(await delegate(CALLER_AGENT)).toMatchObject({
      status: "delegated",
    });
    expect(postChannelMessage.mock.calls[0]![0]).toMatchObject({
      agentUserId: CALLER_AGENT,
    });
    expect(h.slotMoves[0]!.actor).toMatchObject({
      kind: "agent",
      agentUserId: CALLER_AGENT,
    });
    expect(triggerAutoRespond).toHaveBeenCalledTimes(1);
  });
});

describe("what is not a hand-off", () => {
  it("a person delegating: no gate, applied directly, recorded as the person's", async () => {
    expect(await delegate(null)).toMatchObject({ status: "delegated" });
    expect(gateAgentHandOff).not.toHaveBeenCalled();
    expect(postChannelMessage.mock.calls[0]![0]!.agentUserId).toBeUndefined();
    expect(h.slotMoves[0]!.actor).toMatchObject({ kind: "human" });
  });

  it("an agent delegating to its OWN type (itself): no gate", async () => {
    h.delegate = { id: CALLER_AGENT };
    expect(await delegate(CALLER_AGENT)).toMatchObject({ status: "delegated" });
    expect(gateAgentHandOff).not.toHaveBeenCalled();
  });
});
