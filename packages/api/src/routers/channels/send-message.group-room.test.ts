/**
 * chat.sendMessage in a GROUP session room — driven through the REAL procedure
 * (real input schema, real routing engine, real silence gate).
 *
 * A session room is GROUP + `only_mentioned` (2026-09-24). What this proves:
 *  - EVERY @handle is read: "@bob … @researcher" summons the researcher even
 *    though the FIRST handle names a person (the old path read only the first
 *    handle and went silent);
 *  - a handle naming no AI roster member routes nowhere (restraint default);
 *  - an anchored comment in a SILENT group room is still persisted with its
 *    anchor AND wakes the agent through the one door, naming the agent (the
 *    door refuses an un-named GROUP wake) — the group branch used to return
 *    before the anchored-comment trigger.
 *
 * Mocked as in `send-message.anchored-comment.test.ts` (IO edges, anchor gate,
 * planner, the auto-respond door). The roster query returns `m.roster`; the
 * routing verdict is observed through the TEAMMATE_ANSWERING presence event,
 * emitted after routing and before the (stubbed, throwing) IS stream.
 *
 * NOT covered: dispatching TWO agents for one message. The send door runs ONE
 * turn; with several AI members mentioned, the first (in writing order) wins.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  plan: vi.fn(),
  trigger: vi.fn(async () => true),
  inserted: [] as Array<Record<string, unknown>>,
  channel: null as Record<string, unknown> | null,
  roster: [] as Array<{ memberId: string; agentType: string | null }>,
  chatEvents: [] as Array<{ event: string; data: Record<string, unknown> }>,
}));

vi.mock("../../trpc.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../trpc.js")>();
  return { ...actual, protectedProcedure: actual.t.procedure };
});
vi.mock("../../middleware/ai-rate-limit.js", async (importOriginal) => {
  const { t } =
    await vi.importActual<typeof import("../../trpc.js")>("../../trpc.js");
  return {
    ...(await importOriginal<
      typeof import("../../middleware/ai-rate-limit.js")
    >()),
    aiRateLimitMiddleware: t.middleware(({ next }) => next()),
  };
});
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const chain = () => {
    const b: Record<string, unknown> = {};
    for (const k of ["from", "where", "limit", "innerJoin", "orderBy"]) {
      b[k] = () => b;
    }
    (b as { then: unknown }).then = (resolve: (v: unknown) => void) =>
      resolve(m.roster);
    return b;
  };
  return {
    ...actual,
    db: {
      query: {
        channels: { findFirst: vi.fn(async () => m.channel) },
        focusSessions: { findFirst: vi.fn(async () => ({ id: "session-1" })) },
      },
      select: vi.fn(() => chain()),
      insert: vi.fn(() => ({
        values: vi.fn(async (row: Record<string, unknown>) => {
          m.inserted.push(row);
        }),
      })),
    },
  };
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/events")>()),
  emitSideEffects: vi.fn(async () => undefined),
  getBoss: vi.fn(),
}));
vi.mock("../../utils/message-anchor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/message-anchor.js")>()),
  assertMessageAnchorAllowed: vi.fn(async () => undefined),
}));
vi.mock("../../utils/anchored-comment-turn.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../utils/anchored-comment-turn.js")
  >()),
  planAnchoredCommentTurn: m.plan,
}));
vi.mock("../../utils/trigger-auto-respond.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../utils/trigger-auto-respond.js")
  >()),
  triggerAutoRespond: m.trigger,
}));
vi.mock("../../utils/intelligence-routing.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../utils/intelligence-routing.js")
  >()),
  resolveIntelligenceServiceByAgentId: vi.fn(async () => ({
    // The stream is out of scope: routing is decided (and announced) before
    // it starts, so a client that throws ends the turn right after.
    client: {
      sendMessageStream: () => {
        throw new Error("stream not under test");
      },
      sendMessage: async () => {
        throw new Error("stream not under test");
      },
    },
    agentUserId: "service-agent",
  })),
}));
vi.mock("../../utils/emit-message-observation.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../utils/emit-message-observation.js")
  >()),
  emitMessageObservation: vi.fn(async () => undefined),
}));
vi.mock("../../utils/chat-realtime-broadcast.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../utils/chat-realtime-broadcast.js")
  >()),
  emitChatEvent: vi.fn((e: { event: string; data: Record<string, unknown> }) =>
    m.chatEvents.push(e)
  ),
}));
vi.mock("./helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./helpers.js")>()),
  resolveAgentId: vi.fn(async () => "9b0f7a52-3c61-4d0e-8f7e-5a1c2b3d4e5f"),
  ensureAgentUser: vi.fn(async () => "agent-user"),
  usesInternalSessionBoundary: () => false,
}));

import { router } from "../../trpc.js";
import { ChannelType, ChannelStatus } from "@synap/database/schema";
import { sendMessageProcedure } from "./send-message.js";
import { AiReactionMode } from "@synap/database/schema";
import { SERVER_CONVERSATION_EVENTS } from "../../realtime/socket-events.js";

const CHANNEL = "5f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f";
const PROPOSAL = "7d4f6c0e-6a1b-4a8e-9a53-3f2b1c0d9e11";
const RESEARCHER = "a1b2c3d4-0000-4000-8000-000000000001";
const anchor = {
  proposalId: PROPOSAL,
  opRef: "t2",
  field: "position",
  contentVersion: 1,
};
const resolved = {
  version: 1,
  resolution: "resolved",
  proposalId: PROPOSAL,
  stale: false,
};

const send = (input: Record<string, unknown>) =>
  router({ send: sendMessageProcedure })
    .createCaller({
      userId: "user-1",
      authenticated: true,
      workspaceId: null,
    } as never)
    .send({ channelId: CHANNEL, ...input } as never)
    // Past the routing verdict the stubbed IS stream throws — not under test.
    .catch((err: unknown) => ({ error: err }));

const answering = () =>
  m.chatEvents
    .filter((e) => e.event === SERVER_CONVERSATION_EVENTS.TEAMMATE_ANSWERING)
    .map((e) => e.data.teammateId);

beforeEach(() => {
  vi.clearAllMocks();
  m.inserted.length = 0;
  m.chatEvents.length = 0;
  m.roster = [{ memberId: RESEARCHER, agentType: "researcher" }];
  m.channel = {
    id: CHANNEL,
    userId: "user-1",
    workspaceId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    channelType: ChannelType.GROUP,
    aiReactionMode: AiReactionMode.ONLY_MENTIONED,
    status: ChannelStatus.ACTIVE,
    assignedAgentId: null,
    senderAgentId: null,
    contextObjectType: "focus_session",
    contextObjectId: "session-1",
  };
});

describe("chat.sendMessage — GROUP session room mentions", () => {
  it("a SECOND @handle naming a roster agent routes to it (first names a person)", async () => {
    await send({ content: "@bob can you and @researcher check this" });

    expect(answering()).toEqual([RESEARCHER]);
  });

  it("a handle naming no AI roster member stays silent", async () => {
    const out = await send({ content: "@bob can you check this" });

    expect(out).toEqual({ messageId: expect.any(String), channelId: CHANNEL });
    expect(answering()).toEqual([]);
    expect(m.trigger).not.toHaveBeenCalled();
  });
});

describe("chat.sendMessage — anchored comment in a silent GROUP room", () => {
  it("persists the anchor and wakes the planned agent through the one door", async () => {
    m.plan.mockResolvedValue({
      context: resolved,
      decision: {
        trigger: true,
        reason: "intake_run",
        agentType: "capture-analyst",
      },
    });

    const out = await send({
      content: "this position is wrong",
      metadata: { anchor },
    });

    expect(out).toEqual({ messageId: expect.any(String), channelId: CHANNEL });
    expect(m.inserted[0]?.metadata).toEqual({
      turnContext: { anchor: resolved },
      anchor,
    });
    expect(m.trigger).toHaveBeenCalledTimes(1);
    expect(m.trigger).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: CHANNEL,
        agentType: "capture-analyst",
        turnContext: { anchor: resolved },
      })
    );
  });

  it("names the orchestrator when the plan records no agent (a GROUP wake must be named)", async () => {
    m.plan.mockResolvedValue({
      context: resolved,
      decision: { trigger: true, reason: "session_proposal" },
    });

    await send({ content: "why this?", metadata: { anchor } });

    expect(m.trigger).toHaveBeenCalledTimes(1);
    expect(m.trigger).toHaveBeenCalledWith(
      expect.objectContaining({ agentType: "meta" })
    );
  });
});
