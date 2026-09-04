/**
 * postChannelMessage ROLE GATE — only a USER message may kick off an agent turn.
 *
 * The MCP `synap_post_message` tool exposes BOTH `role` and `triggerAI`, so
 * without this gate `{ role: "assistant", triggerAI: true }` makes an agent
 * respond to an assistant message. Mirrors the Hub REST door
 * (`hub-protocol/rest/threads.ts`: `autoRespond === true && role === "user"`).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  inserted: [] as Array<Record<string, unknown>>,
  autoRespondCalls: [] as Array<Record<string, unknown>>,
  chatEvents: [] as Array<Record<string, unknown>>,
  priorRows: [] as Array<{ id: string }>,
}));

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));

// The channel WRITE floor's predicate is the canonical `channelVisibilityWhere`,
// unit-tested at its own door — stub it so this file's DB mock need not model
// the channels/workspace-membership schema. The floor itself is covered by
// `post-message.channel-floor.test.ts`.
vi.mock("../../utils/channel-visibility.js", () => ({
  channelVisibilityWhere: () => undefined,
}));

vi.mock("@synap/database", () => ({
  db: {
    // Two selects reach here: the channel floor (`from().where().limit()`,
    // default = visible) and the ack-integrity dedup lookup (which also calls
    // `orderBy()`; default no prior → proceed).
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ id: "chan-1" }],
          orderBy: () => ({ limit: async () => h.priorRows }),
        }),
      }),
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        h.inserted.push(v);
        return {
          onConflictDoNothing: () => ({
            // A fresh insert returns the row (length 1 → applied path).
            returning: async () => [{ id: v.id as string }],
          }),
        };
      },
    }),
  },
  channels: { id: "channels.id" },
  messages: {
    id: "messages.id",
    channelId: "channel_id",
    userId: "user_id",
    role: "role",
    content: "content",
    deletedAt: "deleted_at",
    timestamp: "timestamp",
  },
  MessageRole: { USER: "user", ASSISTANT: "assistant", SYSTEM: "system" },
  // PRE-EXISTING GAP (not introduced by the attribution change): the module has
  // imported `emitMessageEvent` since the keystone fact-write landed, but this
  // mock never exported it — so all 4 tests in this file were already failing at
  // HEAD with "No export is defined on the mock". Added so the role gate is
  // actually exercised again.
  emitMessageEvent: async () => undefined,
  MessageAuthorType: {
    HUMAN: "human",
    AI_AGENT: "ai_agent",
    EXTERNAL: "external",
    BOT: "bot",
  },
  computeMessageHash: (id: string, content: string) => `hash:${id}:${content}`,
  and: () => undefined,
  eq: () => undefined,
  gte: () => undefined,
  isNull: () => undefined,
  desc: () => undefined,
}));

vi.mock("../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: (e: Record<string, unknown>) => {
    h.chatEvents.push(e);
  },
}));

vi.mock("../../utils/trigger-auto-respond.js", () => ({
  triggerAutoRespond: async (args: Record<string, unknown>) => {
    h.autoRespondCalls.push(args);
  },
}));

import { postChannelMessage } from "./post-message.js";

// A real UUID: the door now rejects a non-UUID channel id at the write floor
// rather than binding it into a Postgres `uuid` comparison.
const CHAN = "11111111-1111-1111-1111-111111111111";

describe("postChannelMessage — triggerAI role gate", () => {
  beforeEach(() => {
    h.inserted.length = 0;
    h.autoRespondCalls.length = 0;
    h.chatEvents.length = 0;
  });

  it("triggers an agent turn for a user message", async () => {
    await postChannelMessage({
      channelId: CHAN,
      content: "hello",
      role: "user",
      triggerAI: true,
      userId: "user-1",
    });

    expect(h.inserted).toHaveLength(1);
    expect(h.autoRespondCalls).toHaveLength(1);
    expect(h.autoRespondCalls[0]).toMatchObject({
      channelId: CHAN,
      content: "hello",
      sourceUserId: "user-1",
    });
  });

  it("does NOT trigger a turn for an assistant message, even with triggerAI", async () => {
    await postChannelMessage({
      channelId: CHAN,
      content: "agent output",
      role: "assistant",
      triggerAI: true,
      userId: "user-1",
    });

    // The message is still written and still broadcast (UI hint) — only the
    // agent-turn kickoff is withheld.
    expect(h.inserted).toHaveLength(1);
    expect(h.chatEvents).toHaveLength(1);
    expect(h.autoRespondCalls).toHaveLength(0);
  });

  it("does NOT trigger a turn for a system message, or when role is omitted (defaults to assistant)", async () => {
    await postChannelMessage({
      channelId: CHAN,
      content: "system note",
      role: "system",
      triggerAI: true,
      userId: "user-1",
    });
    await postChannelMessage({
      channelId: CHAN,
      content: "no role",
      triggerAI: true,
      userId: "user-1",
    });

    expect(h.autoRespondCalls).toHaveLength(0);
  });

  it("never triggers a turn when triggerAI is absent", async () => {
    await postChannelMessage({
      channelId: CHAN,
      content: "hello",
      role: "user",
      userId: "user-1",
    });

    expect(h.inserted).toHaveLength(1);
    expect(h.autoRespondCalls).toHaveLength(0);
  });
});
