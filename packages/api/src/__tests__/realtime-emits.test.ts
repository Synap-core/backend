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
import { diffHermesLifecycle } from "../utils/hermes-lifecycle.js";

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

describe("hermes:task:queued — bridge wire shape", () => {
  it("ships a queued lifecycle event for a user-spawned task", async () => {
    await emitTyped(
      "hermes:task:queued",
      {
        taskId: "tsk_1",
        kind: "proactive_analysis",
        source: "user:user_1",
        queuedAt: "2026-05-05T10:00:00.000Z",
      },
      { userId: "user_1", workspaceId: "ws_1" }
    );

    expect(emitChatEventMock).toHaveBeenCalledOnce();
    const call = emitChatEventMock.mock.calls[0][0];
    expect(call.event).toBe("hermes:task:queued");
    expect(call.data).toMatchObject({
      taskId: "tsk_1",
      kind: "proactive_analysis",
      source: "user:user_1",
    });
  });
});

describe("diffHermesLifecycle — started / completed / failed transitions", () => {
  const fixedNow = new Date("2026-05-05T10:00:00.000Z");
  const startTime = new Date("2026-05-05T09:59:55.000Z");

  it("emits hermes:task:started on first lastRunAt stamp", () => {
    const emits = diffHermesLifecycle(
      {
        action: "proactive_analysis",
        workspaceId: "ws_1",
        lastRunAt: null,
        successCount: 0,
        failureCount: 0,
      },
      { taskId: "tsk_1", lastRunAt: startTime },
      fixedNow
    );

    expect(emits).toHaveLength(1);
    expect(emits[0].event).toBe("hermes:task:started");
    expect(emits[0].payload).toMatchObject({
      taskId: "tsk_1",
      kind: "proactive_analysis",
      startedAt: "2026-05-05T09:59:55.000Z",
    });
  });

  it("emits hermes:task:completed with durationMs when successCount goes up", () => {
    const emits = diffHermesLifecycle(
      {
        action: "pattern_detection",
        lastRunAt: startTime,
        successCount: 4,
        failureCount: 0,
      },
      { taskId: "tsk_2", successCount: 5 },
      fixedNow
    );

    expect(emits).toHaveLength(1);
    expect(emits[0].event).toBe("hermes:task:completed");
    expect(emits[0].payload).toMatchObject({
      taskId: "tsk_2",
      durationMs: 5_000,
      completedAt: "2026-05-05T10:00:00.000Z",
    });
  });

  it("emits hermes:task:failed when errorMessage lands and skips completed", () => {
    const emits = diffHermesLifecycle(
      {
        action: "lead.enrich",
        lastRunAt: startTime,
        successCount: 1,
        failureCount: 0,
      },
      {
        taskId: "tsk_3",
        // Defensive: even if successCount were also bumped, failed wins.
        successCount: 2,
        errorMessage: "OpenRouter rate limit hit",
        status: "error",
      },
      fixedNow
    );

    expect(emits).toHaveLength(1);
    expect(emits[0].event).toBe("hermes:task:failed");
    expect(emits[0].payload).toMatchObject({
      taskId: "tsk_3",
      error: "OpenRouter rate limit hit",
      failedAt: "2026-05-05T10:00:00.000Z",
    });
  });

  it("emits both started and completed when IS reports them in one update", () => {
    // E.g. a fast worker that stamps lastRunAt then increments successCount
    // in a single PATCH after the run finishes.
    const emits = diffHermesLifecycle(
      {
        action: "compaction",
        lastRunAt: null,
        successCount: 0,
        failureCount: 0,
      },
      { taskId: "tsk_4", lastRunAt: startTime, successCount: 1 },
      fixedNow
    );

    expect(emits.map((e) => e.event)).toEqual([
      "hermes:task:started",
      "hermes:task:completed",
    ]);
  });

  it("emits nothing when the input carries no lifecycle deltas", () => {
    const emits = diffHermesLifecycle(
      {
        action: "noop",
        lastRunAt: startTime,
        successCount: 1,
        failureCount: 0,
      },
      { taskId: "tsk_5" }, // e.g. just a metadata refresh
      fixedNow
    );

    expect(emits).toHaveLength(0);
  });
});
