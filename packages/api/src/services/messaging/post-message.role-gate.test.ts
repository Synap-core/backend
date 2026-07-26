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

vi.mock("@synap/database", () => ({
  db: {
    // Ack-integrity dedup lookup (no-key path): default no prior → proceed.
    select: () => ({
      from: () => ({
        where: () => ({
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

describe("postChannelMessage — triggerAI role gate", () => {
  beforeEach(() => {
    h.inserted.length = 0;
    h.autoRespondCalls.length = 0;
    h.chatEvents.length = 0;
  });

  it("triggers an agent turn for a user message", async () => {
    await postChannelMessage({
      channelId: "chan-1",
      content: "hello",
      role: "user",
      triggerAI: true,
      userId: "user-1",
    });

    expect(h.inserted).toHaveLength(1);
    expect(h.autoRespondCalls).toHaveLength(1);
    expect(h.autoRespondCalls[0]).toMatchObject({
      channelId: "chan-1",
      content: "hello",
      sourceUserId: "user-1",
    });
  });

  it("does NOT trigger a turn for an assistant message, even with triggerAI", async () => {
    await postChannelMessage({
      channelId: "chan-1",
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
      channelId: "chan-1",
      content: "system note",
      role: "system",
      triggerAI: true,
      userId: "user-1",
    });
    await postChannelMessage({
      channelId: "chan-1",
      content: "no role",
      triggerAI: true,
      userId: "user-1",
    });

    expect(h.autoRespondCalls).toHaveLength(0);
  });

  it("never triggers a turn when triggerAI is absent", async () => {
    await postChannelMessage({
      channelId: "chan-1",
      content: "hello",
      role: "user",
      userId: "user-1",
    });

    expect(h.inserted).toHaveLength(1);
    expect(h.autoRespondCalls).toHaveLength(0);
  });
});
