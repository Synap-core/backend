/**
 * IS account-gate refusal → hub client → pod classification → SSE error frame.
 *
 * Driven from the REAL wire shape: the JSON body the IS account gate answers
 * (`lib/account-gate.ts` `accountRefusalBody`, HTTP 402) goes to the real
 * `IntelligenceHubClient`; the error it throws goes through the real
 * `describeAiFailure` and the real `chat-turn-sse` error frame, exactly as
 * `channels/send-message.ts` → `ChatTurnFailureError` → the sender SSE does.
 *
 * What it pins: the code, WHO acts (`actor`) and WHAT they do (`action`)
 * reach the client frame unchanged, and the words match the action — a member
 * is told to ask an admin, never to "top up" with a card they do not hold.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventNames } from "@synap-core/types/events";
import { IntelligenceHubClient } from "@synap/intelligence-client";
import { describeAiFailure } from "./ai-failure.js";
import { ChatTurnFailureError } from "./ai-failure-error.js";
import { createChatTurnFrameSequencer } from "./chat-turn-sse.js";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
afterEach(() => fetchMock.mockReset());

function isRefuses(failure: Record<string, unknown>) {
  fetchMock.mockImplementation(
    async () =>
      new Response(JSON.stringify({ error: "refused", failure }), {
        status: 402,
        headers: { "Content-Type": "application/json" },
      })
  );
}

let seq = 0;
async function streamFailure(): Promise<unknown> {
  const client = new IntelligenceHubClient(`http://is-gate-${++seq}.test`, "k");
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

const CASES = [
  {
    name: "payer, credits empty → top up",
    wire: { code: "credits_empty", actor: "payer", action: "top_up" },
    says: /out of AI credits.*Captures still save.*Top up credits/,
    never: /Ask a billing admin|operator|try again/i,
  },
  {
    name: "member, credits empty → ask admin",
    wire: { code: "credits_empty", actor: "payer", action: "ask_admin" },
    says: /out of AI credits.*Ask a billing admin/,
    never: /Top up|operator/i,
  },
  {
    name: "payer, payment failed → fix payment",
    wire: { code: "access_suspended", actor: "payer", action: "fix_payment" },
    says: /payment failed.*Update the payment method/,
    never: /Ask a billing admin|operator/i,
  },
  {
    name: "member, not entitled → ask admin",
    wire: { code: "not_entitled", actor: "payer", action: "ask_admin" },
    says: /plan does not include.*Ask a billing admin/,
    never: /Renew or change the plan|operator|credential/i,
  },
] as const;

describe("IS account gate (402) → frame carries code + actor + action", () => {
  it.each(CASES)("$name", async (c) => {
    isRefuses({ ...c.wire, retryable: false });
    const { failure, frame } = errorFrame(await streamFailure());
    expect(frame).toMatchObject({
      type: "error",
      code: c.wire.code,
      recoverable: false,
      needsOperator: false,
      actor: "payer",
      action: c.wire.action,
    });
    expect(failure.message).toMatch(c.says);
    expect(failure.message).not.toMatch(c.never);
  });
});

describe("never an invented actor or action", () => {
  it("no stated action ⇒ payer named, no action, no CTA sentence", async () => {
    isRefuses({ code: "credits_empty", retryable: false });
    const { frame, failure } = errorFrame(await streamFailure());
    expect(frame.actor).toBe("payer");
    expect(frame).not.toHaveProperty("action");
    expect(failure.message).not.toMatch(/Top up|Ask a billing admin/);
  });

  it("an unknown action on the wire is dropped, not rendered", async () => {
    isRefuses({ code: "credits_empty", retryable: false, action: "pray" });
    const { frame } = errorFrame(await streamFailure());
    expect(frame).not.toHaveProperty("action");
  });

  it("an operator state carries operator + none, even if the wire says top_up", async () => {
    isRefuses({
      code: "llm_budget_exceeded",
      retryable: false,
      actor: "payer",
      action: "top_up",
    });
    const { frame } = errorFrame(await streamFailure());
    expect(frame).toMatchObject({
      code: "llm_budget_exceeded",
      needsOperator: true,
      actor: "operator",
      action: "none",
    });
  });

  it("a transient fault names no actor", async () => {
    fetchMock.mockImplementation(
      async () => new Response("{}", { status: 503 })
    );
    const { frame } = errorFrame(await streamFailure());
    expect(frame).not.toHaveProperty("actor");
    expect(frame).not.toHaveProperty("action");
  });
});
