import { describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import { EventNames } from "@synap-core/types/events";
import { createChatTurnFrameSequencer } from "./chat-turn-sse.js";
import { ChatTurnFailureError } from "./ai-failure-error.js";
import { describeAiFailure } from "./ai-failure.js";

/**
 * PINS THE WIRE CONTRACT for the terminal chat error frame.
 *
 * The bug: `frames.error()` hardcoded `recoverable: false` while
 * `describeAiFailure` had already computed the real verdict three call-frames
 * up, and `TRPCError` (code + message only) dropped it at the boundary. The
 * client gate is
 *
 *   showRetry = error.recoverable !== false && Boolean(onRetry)   // StreamError.tsx:64
 *
 * so the Retry button was structurally unreachable in the first-party app.
 *
 * Two things these tests must hold at once, and the second is the dangerous one:
 *   1. a retryable failure MUST reach the client as recoverable,
 *   2. a NON-retryable failure must NOT — an unearned Retry re-bills an
 *      out-of-credit provider or re-hammers rejected credentials.
 */

/**
 * The client's gate, mirrored verbatim from
 * `synap-app/packages/core/chat-ui/src/components/StreamError.tsx:64`.
 * Asserting through it (rather than on the raw field) is what makes these
 * tests fail if the frame ever renames the field the client actually reads —
 * emitting `retryable` instead of `recoverable` would typecheck, ship, and
 * leave the button exactly as dead as before.
 */
function clientWouldShowRetry(frame: Record<string, unknown>): boolean {
  return frame.recoverable !== false;
}

function startedSequencer() {
  const frames = createChatTurnFrameSequencer();
  frames.fromBroadcast({
    event: EventNames.CHAT_STREAM,
    data: {
      type: "start",
      threadId: "channel-1",
      triggerMessageId: "user-message-1",
    },
  });
  return frames;
}

describe("terminal error frame — carries the classification, not a constant", () => {
  it("a retryable failure reaches the client as recoverable (the button lives)", () => {
    const failure = describeAiFailure("timeout");
    expect(failure.retryable).toBe(true); // guard the fixture's premise

    const frame = startedSequencer().error(
      new ChatTurnFailureError({ message: failure.message, failure })
    );

    expect(frame.recoverable).toBe(true);
    expect(frame.code).toBe("timeout");
    expect(clientWouldShowRetry(frame)).toBe(true);
  });

  it("provider_no_credit (HTTP 402) must NEVER offer retry", () => {
    // Retrying an out-of-credit provider re-bills a wallet that is already
    // empty and cannot succeed. This is the case where getting it wrong is
    // worse than the original bug.
    const failure = describeAiFailure({ status: 402 });
    expect(failure.code).toBe("provider_no_credit");
    expect(failure.retryable).toBe(false);

    const frame = startedSequencer().error(
      new ChatTurnFailureError({ message: failure.message, failure })
    );

    expect(frame.recoverable).toBe(false);
    expect(frame.code).toBe("provider_no_credit");
    expect(frame.needsOperator).toBe(true);
    expect(clientWouldShowRetry(frame)).toBe(false);
  });

  it("provider_auth (401) must NEVER offer retry", () => {
    const failure = describeAiFailure({ status: 401 });
    expect(failure.code).toBe("provider_auth");

    const frame = startedSequencer().error(
      new ChatTurnFailureError({ message: failure.message, failure })
    );

    expect(frame.recoverable).toBe(false);
    expect(frame.needsOperator).toBe(true);
    expect(clientWouldShowRetry(frame)).toBe(false);
  });

  it("FAIL-SAFE: an unclassified throw stays non-recoverable", () => {
    const frame = startedSequencer().error(new Error("something exploded"));

    expect(frame.recoverable).toBe(false);
    expect(frame.code).toBe("unknown");
    expect(frame.message).toBe("something exploded");
    expect(clientWouldShowRetry(frame)).toBe(false);
  });

  it("FAIL-SAFE: a plain TRPCError carries no verdict and stays non-recoverable", () => {
    // The exact shape the canonical path used to throw.
    const frame = startedSequencer().error(
      new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "boom" })
    );

    expect(frame.recoverable).toBe(false);
    expect(frame.code).toBe("unknown");
  });

  it("a cancelled turn is labelled, and is not offered as a retry", () => {
    const frame = startedSequencer().error(
      new ChatTurnFailureError({
        message: "Chat turn cancelled",
        failure: null,
        cancelled: true,
      })
    );

    expect(frame.code).toBe("cancelled");
    expect(frame.cancelled).toBe(true);
    // Unchanged from before this fix: the user ended the turn deliberately.
    expect(frame.recoverable).toBe(false);
  });

  it("prefers the CLASSIFIED sentence over the raw error text", () => {
    const failure = describeAiFailure({ status: 402 });
    const frame = startedSequencer().error(
      new ChatTurnFailureError({ message: "raw provider gibberish", failure })
    );

    expect(frame.message).toBe(failure.message);
    expect(frame.message).toContain("out of credit");
  });

  it("stays a well-formed frame (seq/turnId/eventId) so the journal can persist it", () => {
    const frame = startedSequencer().error(new Error("boom"));
    expect(frame.type).toBe("error");
    expect(frame.turnId).toBe("user-message-1");
    expect(frame.seq).toBe(2);
    expect(typeof frame.eventId).toBe("string");
  });
});
