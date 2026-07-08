/**
 * Tests for `emitTyped`. Mocks the underlying `emitChatEvent` so we observe
 * what would have been POSTed to the bridge without performing real HTTP.
 *
 * The compile-time type test lives at the bottom — `// @ts-expect-error`
 * lines fail the test build if the wrong-shape payloads ever start
 * type-checking, which is the point of the typed registry.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { emitChatEventMock } = vi.hoisted(() => ({
  emitChatEventMock: vi.fn(),
}));

vi.mock("../chat-realtime-broadcast.js", () => ({
  emitChatEvent: emitChatEventMock,
}));

import { emitTyped } from "../event-emit.js";

describe("emitTyped — runtime behavior", () => {
  beforeEach(() => {
    emitChatEventMock.mockClear();
  });

  it("forwards a valid synap:reply:routed payload to the bridge", async () => {
    await emitTyped(
      "synap:reply:routed",
      {
        channelId: "ch_1",
        messageId: "msg_1",
        targetPlatform: "telegram",
        excerpt: "on it",
        routedAt: "2026-05-05T10:00:00Z",
      },
      { userId: "user_1" }
    );

    expect(emitChatEventMock).toHaveBeenCalledOnce();
    const call = emitChatEventMock.mock.calls[0][0];
    expect(call.event).toBe("synap:reply:routed");
    expect(call.userId).toBe("user_1");
    expect(call.workspaceId).toBeNull();
    expect(call.channelId).toBeNull();
    expect(call.data).toMatchObject({ channelId: "ch_1" });
  });

  it("rejects a malformed payload before reaching the bridge", async () => {
    await expect(
      emitTyped(
        "synap:reply:routed",
        // @ts-expect-error — exercising a runtime check the compiler also catches
        { channelId: "ch_1" },
        { userId: "user_1" }
      )
    ).rejects.toThrow(/payload validation failed/);

    expect(emitChatEventMock).not.toHaveBeenCalled();
  });

  it("throws when no target room is provided", async () => {
    await expect(
      emitTyped(
        "synap:reply:routed",
        {
          channelId: "ch_1",
          messageId: "msg_1",
          targetPlatform: "telegram",
          excerpt: "on it",
          routedAt: "2026-05-05T10:00:00Z",
        },
        {}
      )
    ).rejects.toThrow(/at least one target/);

    expect(emitChatEventMock).not.toHaveBeenCalled();
  });

  it("forwards openclaw:message:received with a channel target", async () => {
    await emitTyped(
      "openclaw:message:received",
      {
        channelId: "ch_1",
        messageId: "msg_1",
        platform: "telegram",
        excerpt: "hi",
        receivedAt: "2026-05-05T10:00:00Z",
      },
      { channelId: "ch_1", workspaceId: "ws_1" }
    );

    expect(emitChatEventMock).toHaveBeenCalledOnce();
    const call = emitChatEventMock.mock.calls[0][0];
    expect(call.channelId).toBe("ch_1");
    expect(call.workspaceId).toBe("ws_1");
  });
});

describe("emitTyped — compile-time type safety", () => {
  it("rejects unknown event names and wrong payload shapes at the type level", () => {
    // These calls never run — the test passes only if `tsc` accepts the
    // file. Each `@ts-expect-error` will fail the build if the pattern
    // starts type-checking unexpectedly, which is the safety net.
    const _checks = async () => {
      const target = { userId: "u" };

      // @ts-expect-error — unknown event name
      await emitTyped("not-an-event", {}, target);

      const wrongType: Parameters<typeof emitTyped<"import:file:progress">>[1] =
        {
          batchId: "b",
          path: "p",
          // @ts-expect-error — index typed as number, given string
          index: "fast",
          total: 1,
          status: "processing",
        };
      void wrongType;

      // @ts-expect-error — missing required field `total`
      const missingField: Parameters<
        typeof emitTyped<"import:file:progress">
      >[1] = { batchId: "b", path: "p", index: 0, status: "processing" };
      void missingField;
    };

    expect(_checks).toBeTypeOf("function");
  });
});
