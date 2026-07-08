/**
 * Phase 3B emits — coverage for the six new realtime events landed alongside
 * the typed event registry.
 *
 * Strategy: each test loads the *call-site helper* (the pure decision
 * function) where one exists, otherwise it exercises `emitTyped` with a
 * mocked bridge to assert the wire shape. End-to-end (real DB + tRPC) is
 * intentionally out of scope — the integration surface is verified through
 * the existing per-router tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted mock for the bridge — lets each emitTyped call we make in tests
// accumulate on the spy without performing a real HTTP POST.
const { emitChatEventMock } = vi.hoisted(() => ({
  emitChatEventMock: vi.fn(),
}));

vi.mock("../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: emitChatEventMock,
}));

import { emitTyped } from "../utils/event-emit.js";
import { makeExcerpt, EXCERPT_MAX_LEN } from "../utils/excerpt.js";

beforeEach(() => {
  emitChatEventMock.mockClear();
});

describe("makeExcerpt — privacy-preserving truncation", () => {
  it("returns empty string for empty/undefined input", () => {
    expect(makeExcerpt(undefined)).toBe("");
    expect(makeExcerpt(null)).toBe("");
    expect(makeExcerpt("")).toBe("");
  });

  it("passes short messages through unchanged", () => {
    expect(makeExcerpt("hi there")).toBe("hi there");
  });

  it("truncates messages longer than EXCERPT_MAX_LEN with ellipsis", () => {
    const long = "x".repeat(EXCERPT_MAX_LEN + 50);
    const out = makeExcerpt(long);
    expect(out.length).toBe(EXCERPT_MAX_LEN + 1); // +1 for ellipsis
    expect(out.endsWith("…")).toBe(true);
  });

  it("collapses whitespace so excerpts stay readable", () => {
    expect(makeExcerpt("  hello\n\nworld  ")).toBe("hello world");
  });
});

describe("openclaw:message:received — bridge wire shape", () => {
  it("ships a valid telegram inbound through the typed bridge", async () => {
    await emitTyped(
      "openclaw:message:received",
      {
        channelId: "ch_external_1",
        messageId: "msg_1",
        platform: "telegram",
        excerpt: makeExcerpt("Hey from Telegram!"),
        receivedAt: "2026-05-05T10:00:00.000Z",
      },
      {
        channelId: "ch_external_1",
        workspaceId: "ws_1",
        userId: "user_1",
      }
    );

    expect(emitChatEventMock).toHaveBeenCalledOnce();
    const call = emitChatEventMock.mock.calls[0][0];
    expect(call.event).toBe("openclaw:message:received");
    expect(call.data).toMatchObject({
      channelId: "ch_external_1",
      messageId: "msg_1",
      platform: "telegram",
      excerpt: "Hey from Telegram!",
    });
    expect(call.workspaceId).toBe("ws_1");
    expect(call.channelId).toBe("ch_external_1");
  });

  it("rejects payloads with unknown platforms before reaching the bridge", async () => {
    await expect(
      emitTyped(
        "openclaw:message:received",
        {
          channelId: "ch_1",
          messageId: "msg_1",
          // @ts-expect-error — exercise runtime validation; "slack" is not in OpenClawPlatform
          platform: "slack",
          excerpt: "x",
          receivedAt: "2026-05-05T10:00:00Z",
        },
        { channelId: "ch_1" }
      )
    ).rejects.toThrow(/payload validation failed/);

    expect(emitChatEventMock).not.toHaveBeenCalled();
  });
});

describe("synap:reply:routed — bridge wire shape", () => {
  it("ships an internal Synap routing decision through the typed bridge", async () => {
    await emitTyped(
      "synap:reply:routed",
      {
        channelId: "ch_personal",
        messageId: "msg_user_1",
        targetPlatform: "synap",
        excerpt: makeExcerpt("Continuing in the Marketing Project channel."),
        routedAt: "2026-05-05T10:00:00.000Z",
      },
      {
        channelId: "ch_personal",
        userId: "user_1",
        workspaceId: "ws_1",
      }
    );

    expect(emitChatEventMock).toHaveBeenCalledOnce();
    const call = emitChatEventMock.mock.calls[0][0];
    expect(call.event).toBe("synap:reply:routed");
    expect(call.data.targetPlatform).toBe("synap");
    expect(call.data.routedAt).toBe("2026-05-05T10:00:00.000Z");
  });
});

describe("synap:reply:routed — bridge wire shape (user target)", () => {
  it("ships a routed reply event scoped to a user", async () => {
    await emitTyped(
      "synap:reply:routed",
      {
        channelId: "ch_personal",
        messageId: "msg_1",
        targetPlatform: "synap",
        excerpt: "on it",
        routedAt: "2026-05-05T10:00:00.000Z",
      },
      { userId: "user_1", workspaceId: "ws_1" }
    );

    expect(emitChatEventMock).toHaveBeenCalledOnce();
    const call = emitChatEventMock.mock.calls[0][0];
    expect(call.event).toBe("synap:reply:routed");
    expect(call.data).toMatchObject({
      channelId: "ch_personal",
      messageId: "msg_1",
      targetPlatform: "synap",
    });
  });
});
