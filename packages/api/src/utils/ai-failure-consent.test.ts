/**
 * IS provider gate refusal → hub client → pod classification → SSE error frame.
 *
 * The IS refuses Synap's AI service (DeepSeek, servers in China) for a pod
 * whose admin has not chosen who runs its AI (founder decision 2026-10-27),
 * with HTTP 403 and `failure.code: "ai_consent_required"`. Driven from that
 * REAL wire shape through the real `IntelligenceHubClient`, `describeAiFailure`
 * and the chat-turn error frame, as `channels/send-message.ts` does.
 *
 * What it pins: the code reaches the client frame (every surface opens the
 * choice on it), the words name the choice and its door (an agent reading the
 * message gets the pod's link), and nothing invites a retry or blames
 * "credentials" — which is what a bare 403 classified as before.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventNames } from "@synap-core/types/events";
import { IntelligenceHubClient } from "@synap/intelligence-client";
import { describeAiFailure } from "./ai-failure.js";
import { ChatTurnFailureError } from "./ai-failure-error.js";
import { createChatTurnFrameSequencer } from "./chat-turn-sse.js";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllEnvs();
});

function isRefuses(failure: Record<string, unknown>) {
  fetchMock.mockImplementation(
    async () =>
      new Response(JSON.stringify({ error: "refused", failure }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      })
  );
}

let seq = 0;
async function streamFailure(): Promise<unknown> {
  const client = new IntelligenceHubClient(
    `http://is-consent-${++seq}.test`,
    "k"
  );
  try {
    for await (const _ of client.sendMessageStream({
      query: "hi",
      threadId: "t",
      userId: "u",
    })) {
      // none
    }
  } catch (err) {
    return err;
  }
  throw new Error("expected a throw");
}

function errorFrame(err: unknown) {
  const failure = describeAiFailure(err);
  const frames = createChatTurnFrameSequencer();
  frames.fromBroadcast({
    event: EventNames.CHAT_STREAM,
    data: { type: "start", threadId: "c", triggerMessageId: "m" },
  });
  return {
    failure,
    frame: frames.error(
      new ChatTurnFailureError({ message: failure.message, failure })
    ),
  };
}

describe("IS provider gate (403 ai_consent_required)", () => {
  it("reaches the frame as ai_consent_required, not retryable, no operator", async () => {
    vi.stubEnv("PUBLIC_URL", "https://pod.example.com");
    isRefuses({ code: "ai_consent_required", retryable: false });
    const { failure, frame } = errorFrame(await streamFailure());
    expect(frame).toMatchObject({
      type: "error",
      code: "ai_consent_required",
      recoverable: false,
      needsOperator: false,
    });
    expect(failure.message).toMatch(/DeepSeek \(servers in China\)/);
    expect(failure.message).toMatch(/own provider/);
    expect(failure.message).toContain(
      "https://pod.example.com/open/settings/ai"
    );
    expect(failure.message).not.toMatch(/credential|operator|Sending again/i);
  });

  it("a choice the IS could not read is an outage, never a missing choice", async () => {
    isRefuses({ code: "ai_consent_unverified", retryable: true });
    const { failure } = errorFrame(await streamFailure());
    expect(failure.code).toBe("upstream_error");
    expect(failure.retryable).toBe(true);
    expect(failure.message).not.toMatch(/choose|DeepSeek/i);
  });
});
