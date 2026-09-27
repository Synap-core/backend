/**
 * The W2 ask doors on the tRPC router — the half the service suite
 * (`ask-doors.pglite.test.ts`) cannot see: the agent-key floor on all three
 * person doors, the input contract (text OR value), and the refusal mapping
 * (`ask_changed:` → CONFLICT, `ask_invalid:` → BAD_REQUEST, attest on an
 * answer-ask → BAD_REQUEST `ask_invalid:`).
 *
 * The services are spies: each is driven for real in its own suite; what
 * matters here is that a refused caller never REACHES them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  answer: vi.fn(),
  attest: vi.fn(),
  ask: vi.fn(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: {
      query: new Proxy({} as Record<string, unknown>, {
        get: () => ({ findFirst: async () => undefined }),
      }),
      // The tRPC read-only guard upserts the sync-generation row per call.
      insert: () => {
        const chain: Record<string, unknown> = {
          values: () => chain,
          onConflictDoNothing: () => chain,
          onConflictDoUpdate: () => chain,
          returning: async () => [],
          then: (resolve: (v: unknown) => void) => resolve([]),
        };
        return chain;
      },
    },
  };
});
vi.mock(
  "../services/focus-sessions/session-answer.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../services/focus-sessions/session-answer.js")
      >();
    return {
      ...actual,
      answerSessionSlot: (...a: unknown[]) => m.answer(...a),
      attestSessionSlot: (...a: unknown[]) => m.attest(...a),
    };
  }
);
vi.mock(
  "../services/focus-sessions/ask-about-slot.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../services/focus-sessions/ask-about-slot.js")
      >();
    return { ...actual, askAboutSlot: (...a: unknown[]) => m.ask(...a) };
  }
);

const { focusSessionsRouter } = await import("./focus-sessions.js");

const SESSION = "11111111-1111-4111-8111-111111111111";
const person = () =>
  focusSessionsRouter.createCaller({
    userId: "user-1",
    authenticated: true,
  } as never);
const agentKey = () =>
  focusSessionsRouter.createCaller({
    userId: "user-1",
    agentUserId: "agent-1",
    authenticated: true,
  } as never);

beforeEach(() => {
  m.answer.mockReset();
  m.attest.mockReset();
  m.ask.mockReset();
});

describe("agent keys are refused on every person door", () => {
  it("answerOutput / attestOutput / askAboutSlot → FORBIDDEN, service never reached", async () => {
    await expect(
      agentKey().answerOutput({
        sessionId: SESSION,
        expectedLabel: "K",
        text: "yes",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      agentKey().attestOutput({ sessionId: SESSION, expectedLabel: "K" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      agentKey().askAboutSlot({ sessionId: SESSION, expectedLabel: "K" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(m.answer).not.toHaveBeenCalled();
    expect(m.attest).not.toHaveBeenCalled();
    expect(m.ask).not.toHaveBeenCalled();
  });
});

describe("answerOutput contract", () => {
  it("refuses an answer with neither text nor value", async () => {
    await expect(
      person().answerOutput({ sessionId: SESSION, expectedLabel: "K" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(m.answer).not.toHaveBeenCalled();
  });

  it("passes value + askFingerprint through to the service", async () => {
    m.answer.mockResolvedValue({ status: "answered", expectedLabel: "K" });
    await person().answerOutput({
      sessionId: SESSION,
      expectedLabel: "K",
      value: { type: "confirm", confirmed: true },
      askFingerprint: "abc",
    });
    expect(m.answer).toHaveBeenCalledWith(
      expect.objectContaining({
        value: { type: "confirm", confirmed: true },
        askFingerprint: "abc",
      })
    );
  });

  it("ask_changed → CONFLICT with the ask_changed: prefix", async () => {
    m.answer.mockResolvedValue({ status: "ask_changed" });
    await expect(
      person().answerOutput({
        sessionId: SESSION,
        expectedLabel: "K",
        text: "yes",
      })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringMatching(/^ask_changed:/),
    });
  });

  it("ask_invalid → BAD_REQUEST with the ask_invalid: prefix", async () => {
    m.answer.mockResolvedValue({
      status: "ask_invalid",
      code: "not_offered",
      message: '"X" is not one of the offered options.',
    });
    await expect(
      person().answerOutput({
        sessionId: SESSION,
        expectedLabel: "K",
        text: "yes",
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/^ask_invalid:/),
    });
  });
});

describe("attestOutput contract", () => {
  it("answer_required → BAD_REQUEST ask_invalid:", async () => {
    m.attest.mockResolvedValue({ status: "answer_required" });
    await expect(
      person().attestOutput({ sessionId: SESSION, expectedLabel: "K" })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/^ask_invalid:/),
    });
  });

  it("attested → the unchanged { ok, expectedLabel, kind } shape", async () => {
    m.attest.mockResolvedValue({
      status: "attested",
      expectedLabel: "K",
      kind: "document",
      messageId: "m",
      questionId: null,
      wokeAgentType: "researcher",
      triggered: true,
    });
    await expect(
      person().attestOutput({ sessionId: SESSION, expectedLabel: "K" })
    ).resolves.toEqual({ ok: true, expectedLabel: "K", kind: "document" });
  });
});

describe("askAboutSlot contract", () => {
  it("returns { channelId, messageId, threadId }", async () => {
    m.ask.mockResolvedValue({
      channelId: "c",
      messageId: "m",
      threadId: "m",
      seeded: true,
      triggered: true,
    });
    await expect(
      person().askAboutSlot({
        sessionId: SESSION,
        expectedLabel: "K",
        note: "why?",
      })
    ).resolves.toMatchObject({ channelId: "c", messageId: "m", threadId: "m" });
    expect(m.ask).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", note: "why?" })
    );
  });
});
