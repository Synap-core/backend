/**
 * chat.sendMessage in a GROUP session room — driven through the REAL procedure
 * (real input schema, real routing engine, real silence gate).
 *
 * A session room is GROUP + `only_mentioned` (2026-09-24). What this proves:
 *  - EVERY @handle is read: "@bob … @researcher" summons the researcher even
 *    though the FIRST handle names a person (the old path read only the first
 *    handle and went silent);
 *  - a handle naming no AI roster member routes nowhere (restraint default);
 *  - THE REACH RULE: an EXTERNAL roster member (reach dispatch/pull) never
 *    gets an IS turn under its name — a mention of it WAKES it its own way
 *    (`wakeMentionedAgents`) and never falls through to a house agent;
 *  - when_confident through THE route (no AI picker): the single house agent
 *    answers; two or more ⇒ the person is asked (`offerRoomChoice`);
 *  - an anchored comment in a SILENT group room is still persisted with its
 *    anchor AND wakes the agent through the one door, naming the agent (the
 *    door refuses an un-named GROUP wake) — the group branch used to return
 *    before the anchored-comment trigger.
 *
 * Mocked as in `send-message.anchored-comment.test.ts` (IO edges, anchor gate,
 * planner, the auto-respond door, the room follow-through). The route and the
 * room rule are REAL. The roster query returns `m.roster`; the
 * routing verdict is observed through the TEAMMATE_ANSWERING presence event,
 * emitted after routing and before the (stubbed, throwing) IS stream.
 *
 * NOT covered: dispatching TWO agents for one message. The send door runs ONE
 * turn; with several AI members mentioned, the first (in writing order) wins.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  plan: vi.fn(),
  capture: vi.fn(async (): Promise<unknown> => null),
  trigger: vi.fn(async () => true),
  inserted: [] as Array<Record<string, unknown>>,
  channel: null as Record<string, unknown> | null,
  roster: [] as Array<{
    agentUserId: string;
    name: string | null;
    agentType: string | null;
  }>,
  wake: vi.fn(async (_p: { wake: unknown[] }) => undefined),
  ownerReply: { status: "no_session" } as Record<string, unknown>,
  offer: vi.fn(
    async (_p: { candidates: Array<{ agentUserId: string }> }) => undefined
  ),
  chatEvents: [] as Array<{ event: string; data: Record<string, unknown> }>,
  reach: {} as Record<string, "pod" | "dispatch" | "pull">,
  overrides: vi.fn(async (_k: unknown): Promise<unknown> => null),
  streamRequests: [] as Array<Record<string, unknown>>,
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
    agentOverridesForTurn: m.overrides,
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
vi.mock("../../services/intake/capture-room.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../services/intake/capture-room.js")
  >()),
  planCaptureCommentTurn: m.capture,
}));
vi.mock("../../utils/trigger-auto-respond.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../utils/trigger-auto-respond.js")
  >()),
  triggerAutoRespond: m.trigger,
}));
// THE reach rule's one door — a member's reach is whatever the case says
// (default 'pod'); the procedure must consult it, never re-derive it.
vi.mock(
  "../../services/agent-dispatch/agent-binding.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../services/agent-dispatch/agent-binding.js")
    >()),
    resolveAgentReachMany: vi.fn(
      async (ids: readonly string[]) =>
        new Map(ids.map((id) => [id, m.reach[id] ?? "pod"]))
    ),
  })
);
vi.mock("../../utils/intelligence-routing.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../utils/intelligence-routing.js")
  >()),
  resolveIntelligenceService: vi.fn(async () => ({
    // The stream is out of scope: routing is decided (and announced) before
    // it starts, so a client that throws ends the turn right after.
    client: {
      sendMessageStream: (req: Record<string, unknown>) => {
        m.streamRequests.push(req);
        throw new Error("stream not under test");
      },
      sendMessage: async () => {
        throw new Error("stream not under test");
      },
    },
    agentUserId: "service-agent",
  })),
}));
// The answer loop, at its door: what the owner's reply was (a "who should
// answer?" is never asked about a message that answered an agent's question).
vi.mock(
  "../../services/focus-sessions/session-answer.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../services/focus-sessions/session-answer.js")
    >()),
    recordOwnerRoomReply: vi.fn(async () => m.ownerReply),
  })
);
vi.mock("../../services/agent-dispatch/room-follow-through.js", () => ({
  wakeMentionedAgents: m.wake,
  offerRoomChoice: m.offer,
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
const CLAUDE_CODE = "a1b2c3d4-0000-4000-8000-000000000002";
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
  m.capture.mockResolvedValue(null);
  m.inserted.length = 0;
  m.chatEvents.length = 0;
  m.streamRequests.length = 0;
  m.overrides.mockResolvedValue(null);
  m.roster = [
    { agentUserId: RESEARCHER, name: "Researcher", agentType: "researcher" },
  ];
  m.reach = {};
  m.ownerReply = { status: "no_session" };
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

describe("chat.sendMessage — the agent's own config rides the IS turn", () => {
  const WS = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const row = {
    modelOverride: "openrouter/model-x",
    promptAppend: "Cite sources.",
    extraToolIds: [],
    disabledToolIds: [],
    maxStepsOverride: null,
  };

  it("reads agent_configs for (user, workspace, routed agentType) and forwards it", async () => {
    m.overrides.mockResolvedValue(row);
    await send({ content: "@researcher check this", workspaceId: WS });

    expect(m.overrides).toHaveBeenCalledWith({
      userId: "user-1",
      workspaceId: WS,
      agentType: "researcher",
    });
    expect(m.streamRequests).toHaveLength(1);
    expect(m.streamRequests[0]).toMatchObject({ agentOverrides: row });
    // The retired shape never rides along.
    expect(m.streamRequests[0]).not.toHaveProperty("workspaceSettings");
  });

  it("forwards null (looked, none) and omits a failed read", async () => {
    await send({ content: "@researcher check this", workspaceId: WS });
    expect(m.streamRequests[0]).toHaveProperty("agentOverrides", null);

    m.overrides.mockResolvedValue(undefined);
    await send({ content: "@researcher again", workspaceId: WS });
    expect(m.streamRequests[1]).not.toHaveProperty("agentOverrides");
  });
});

describe("chat.sendMessage — an EXTERNAL agent on the room roster", () => {
  // An external agent (Claude Code, Cursor…) joins a session room's roster
  // through `attachSessionAgent` / the session's own `agentIds`. The reach rule:
  // it NEVER gets an IS turn under its name.
  beforeEach(() => {
    m.roster = [
      { agentUserId: RESEARCHER, name: "Researcher", agentType: "researcher" },
      {
        agentUserId: CLAUDE_CODE,
        name: "Claude Code",
        agentType: "claude-code",
      },
    ];
    m.reach = { [CLAUDE_CODE]: "pull" };
  });

  it("an @mention of the external agent runs no IS turn under its name — it is woken", async () => {
    const out = await send({ content: "@claude-code can you pick this up" });

    expect(out).toEqual({ messageId: expect.any(String), channelId: CHANNEL });
    expect(answering()).toEqual([]);
    expect(m.wake).toHaveBeenCalledWith(
      expect.objectContaining({
        wake: [{ agentUserId: CLAUDE_CODE, reach: "pull" }],
      })
    );
  });

  it("a dispatch-reach agent is excluded the same way", async () => {
    m.reach = { [CLAUDE_CODE]: "dispatch" };

    await send({ content: "@claude-code can you pick this up" });

    expect(answering()).toEqual([]);
  });

  it("a house agent mentioned beside it still answers, and the external one is woken", async () => {
    await send({ content: "@claude-code and @researcher check this" });

    expect(answering()).toEqual([RESEARCHER]);
    expect(m.wake).toHaveBeenCalledWith(
      expect.objectContaining({
        wake: [{ agentUserId: CLAUDE_CODE, reach: "pull" }],
      })
    );
  });

  it("when_confident, no mention: the single HOUSE agent answers, never the external one", async () => {
    m.channel = { ...m.channel, aiReactionMode: AiReactionMode.WHEN_CONFIDENT };

    await send({ content: "anyone around to pick this up?" });

    expect(answering()).toEqual([RESEARCHER]);
    expect(m.offer).not.toHaveBeenCalled();
  });

  it("when_confident: a mention of the external agent never falls through to a house agent", async () => {
    m.channel = { ...m.channel, aiReactionMode: AiReactionMode.WHEN_CONFIDENT };

    await send({ content: "@claude-code can you pick this up" });

    expect(answering()).toEqual([]);
  });
});

describe("chat.sendMessage — several house agents, nobody named", () => {
  const WRITER = "a1b2c3d4-0000-4000-8000-000000000003";
  beforeEach(() => {
    m.roster = [
      { agentUserId: RESEARCHER, name: "Researcher", agentType: "researcher" },
      { agentUserId: WRITER, name: "Writer", agentType: "writer" },
    ];
  });

  it("when_confident: nobody answers and the person is asked who should", async () => {
    m.channel = { ...m.channel, aiReactionMode: AiReactionMode.WHEN_CONFIDENT };

    await send({ content: "what do you think?" });

    expect(answering()).toEqual([]);
    expect(m.offer).toHaveBeenCalledTimes(1);
    expect(
      m.offer.mock.calls[0]![0].candidates.map((c) => c.agentUserId)
    ).toEqual([RESEARCHER, WRITER]);
  });

  it("a reply that answered an agent's open question is never asked about", async () => {
    m.channel = { ...m.channel, aiReactionMode: AiReactionMode.WHEN_CONFIDENT };
    m.ownerReply = { status: "answered", questionId: "q1", woke: true };

    await send({ content: "use the March numbers" });

    expect(answering()).toEqual([]);
    expect(m.offer).not.toHaveBeenCalled();
  });

  it("only_mentioned: silence, and no question", async () => {
    await send({ content: "what do you think?" });

    expect(answering()).toEqual([]);
    expect(m.offer).not.toHaveBeenCalled();
  });

  it("a mention picks one of them — no question", async () => {
    m.channel = { ...m.channel, aiReactionMode: AiReactionMode.WHEN_CONFIDENT };

    await send({ content: "@writer draft this" });

    expect(answering()).toEqual([WRITER]);
    expect(m.offer).not.toHaveBeenCalled();
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

describe("chat.sendMessage — a plain comment in a CAPTURE room", () => {
  const entries = [
    { key: "capture.kind", value: "capture_room" },
    { key: "capture.note", value: "idea of content for synap" },
    {
      key: "capture.suggestions",
      value: ["Suggested · Post · Idea of content for Synap"],
    },
  ];

  it("wakes the orchestrator with the note and the current suggestions in its context", async () => {
    m.capture.mockResolvedValue({ agentType: "meta", entries });

    const out = await send({ content: "make it about relay instead" });

    expect(out).toEqual({ messageId: expect.any(String), channelId: CHANNEL });
    expect(m.capture).toHaveBeenCalledWith({
      channelId: CHANNEL,
      userId: "user-1",
    });
    expect(m.trigger).toHaveBeenCalledTimes(1);
    expect(m.trigger).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: CHANNEL,
        agentType: "meta",
        turnContext: { entries },
      })
    );
    // The note rides the TURN only; the stored comment carries none of it.
    expect(m.inserted[0]?.metadata).toBeUndefined();
  });

  it("a plain comment in a room that is not a capture room stays silent", async () => {
    await send({ content: "just a thought" });

    expect(m.trigger).not.toHaveBeenCalled();
  });
});
