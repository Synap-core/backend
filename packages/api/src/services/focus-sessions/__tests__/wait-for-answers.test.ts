import { describe, it, expect, vi } from "vitest";
import {
  WAIT_DEFAULT_SECONDS,
  WAIT_MAX_SECONDS,
  clampWaitSeconds,
  waitForSessionAnswers,
} from "../wait-for-answers.js";
import { stampPickedUp } from "../answer-pickup.js";
import type {
  SessionAnswerItem,
  SessionAnswersPage,
} from "../list-session-answers.js";
import type { ExpectedOutput } from "@synap/playbooks";

/**
 * The bounded long-poll behind `synap_wait_for_answer` and Hub
 * `GET /focus-sessions/:id/answers/wait` (V1 G4), and its "Picked up"
 * receipt (G5). Driven through injected deps: a fake clock, a fake wake
 * channel, and a scripted `listSessionAnswers`.
 */

const SID = "11111111-1111-4111-8111-111111111111";

const answer = (over: Partial<SessionAnswerItem> = {}): SessionAnswerItem => ({
  id: "a1",
  text: "Use the EU account",
  value: null,
  answeredAt: "2026-09-28T10:00:00.000Z",
  answeredBy: "u1",
  messageId: null,
  slot: { label: "Stripe account", kind: "decision", question: "Which?" },
  question: null,
  ...over,
});

const page = (answers: SessionAnswerItem[]): SessionAnswersPage => ({
  sessionId: SID,
  since: null,
  answers,
  nextSince: answers.at(-1)?.answeredAt ?? null,
  hasMore: false,
});

/** A wake channel the test can fire, like the NOTIFY listener. */
function wakeChannel() {
  const subs = new Set<() => void>();
  return {
    subscribe: (_id: string, fn: () => void) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    fire: () => [...subs].forEach((fn) => fn()),
    size: () => subs.size,
  };
}

describe("waitForSessionAnswers", () => {
  it("returns at once when an answer already exists — the same page shape as the poll", async () => {
    const list = vi.fn().mockResolvedValue(page([answer()]));
    const ch = wakeChannel();
    const r = await waitForSessionAnswers(
      { sessionId: SID, userId: "u1" },
      { list, subscribe: ch.subscribe, stamp: vi.fn() }
    );
    expect(r).toMatchObject({ status: "answered", answers: [{ id: "a1" }] });
    expect(list).toHaveBeenCalledTimes(1);
    expect(ch.size()).toBe(0); // unsubscribed
  });

  it("sleeps until the session-changed WAKE, then re-reads (no busy loop)", async () => {
    const ch = wakeChannel();
    const list = vi
      .fn()
      .mockResolvedValueOnce(page([]))
      .mockResolvedValueOnce(page([answer()]));
    const pending = waitForSessionAnswers(
      { sessionId: SID, userId: "u1", timeoutSeconds: 60 },
      // A fallback poll far beyond the test: only the wake can end the sleep.
      { list, subscribe: ch.subscribe, stamp: vi.fn(), pollMs: 3_600_000 }
    );
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    ch.fire();
    const r = await pending;
    expect(r?.status).toBe("answered");
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("times out with the cursor to wait on again — never throws, never answers", async () => {
    let t = 0;
    const list = vi.fn().mockImplementation(async () => {
      t += 1_000; // each read "takes" a second of the fake clock
      return { ...page([]), nextSince: "2026-09-28T09:00:00.000Z" };
    });
    const r = await waitForSessionAnswers(
      { sessionId: SID, userId: "u1", timeoutSeconds: 2 },
      {
        list,
        subscribe: wakeChannel().subscribe,
        stamp: vi.fn(),
        pollMs: 1,
        now: () => t,
      }
    );
    expect(r).toMatchObject({
      status: "timeout",
      sessionId: SID,
      nextSince: "2026-09-28T09:00:00.000Z",
    });
  });

  it("missing / not-yours is null (the poll door's floor), and a failed read THROWS", async () => {
    const ch = wakeChannel();
    await expect(
      waitForSessionAnswers(
        { sessionId: SID, userId: "u2" },
        { list: vi.fn().mockResolvedValue(null), subscribe: ch.subscribe }
      )
    ).resolves.toBeNull();
    await expect(
      waitForSessionAnswers(
        { sessionId: SID, userId: "u1" },
        {
          list: vi.fn().mockRejectedValue(new Error("db down")),
          subscribe: ch.subscribe,
        }
      )
    ).rejects.toThrow("db down");
    expect(ch.size()).toBe(0);
  });

  it("an AGENT's read stamps the receipt; a person's read never does; a failed receipt still returns the answer", async () => {
    const list = vi.fn().mockResolvedValue(page([answer()]));
    const ch = wakeChannel();

    const personStamp = vi.fn();
    await waitForSessionAnswers(
      { sessionId: SID, userId: "u1" },
      { list, subscribe: ch.subscribe, stamp: personStamp }
    );
    expect(personStamp).not.toHaveBeenCalled();

    const agentStamp = vi.fn().mockRejectedValue(new Error("lock timeout"));
    const r = await waitForSessionAnswers(
      { sessionId: SID, userId: "u1", stampReceipt: true },
      { list, subscribe: ch.subscribe, stamp: agentStamp }
    );
    expect(agentStamp).toHaveBeenCalledWith({
      sessionId: SID,
      answers: [expect.objectContaining({ id: "a1" })],
    });
    expect(r?.status).toBe("answered");
  });

  it("a caller that HUNG UP stamps nothing (nobody read the answer)", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const stamp = vi.fn();
    const r = await waitForSessionAnswers(
      { sessionId: SID, userId: "u1", stampReceipt: true, signal: ctl.signal },
      {
        list: vi.fn().mockResolvedValue(page([answer()])),
        subscribe: wakeChannel().subscribe,
        stamp,
      }
    );
    expect(r?.status).toBe("answered");
    expect(stamp).not.toHaveBeenCalled();
  });

  it("an abort ends the sleep at once (no waiting out the timeout)", async () => {
    const ctl = new AbortController();
    const list = vi.fn().mockResolvedValue(page([]));
    const pending = waitForSessionAnswers(
      { sessionId: SID, userId: "u1", timeoutSeconds: 60, signal: ctl.signal },
      { list, subscribe: wakeChannel().subscribe, pollMs: 3_600_000 }
    );
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    ctl.abort();
    expect((await pending)?.status).toBe("timeout");
  });

  it("NO since = UNREAD: skips picked-up slot answers, room answers only from the wait's start", async () => {
    const t0 = Date.parse("2026-09-28T12:00:00.000Z");
    let t = t0;
    const list = vi.fn().mockImplementation(async () => {
      t += 1_000;
      return page([]);
    });
    await waitForSessionAnswers(
      { sessionId: SID, userId: "u1", timeoutSeconds: 1 },
      { list, subscribe: wakeChannel().subscribe, pollMs: 1, now: () => t }
    );
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        since: null,
        skipPickedUp: true,
        roomSince: new Date(t0),
      })
    );

    // With a cursor, the cursor alone decides (the poll door's contract).
    const cursor = vi.fn().mockResolvedValue(page([answer()]));
    await waitForSessionAnswers(
      {
        sessionId: SID,
        userId: "u1",
        since: new Date("2026-09-28T09:00:00.000Z"),
      },
      { list: cursor, subscribe: wakeChannel().subscribe, stamp: vi.fn() }
    );
    const args = cursor.mock.calls[0]![0];
    expect(args).not.toHaveProperty("skipPickedUp");
    expect(args).not.toHaveProperty("roomSince");
  });

  it("clamps the wait to [1, 90] seconds, default 50", () => {
    expect(clampWaitSeconds(undefined)).toBe(WAIT_DEFAULT_SECONDS);
    expect(clampWaitSeconds(Number.NaN)).toBe(WAIT_DEFAULT_SECONDS);
    expect(clampWaitSeconds(0)).toBe(1);
    expect(clampWaitSeconds(9_999)).toBe(WAIT_MAX_SECONDS);
    expect(WAIT_MAX_SECONDS).toBe(90);
  });
});

describe("stampPickedUp (the receipt rule)", () => {
  const NOW = new Date("2026-09-28T12:00:00.000Z");
  const slot = (over: Partial<ExpectedOutput> = {}): ExpectedOutput =>
    ({
      label: "Stripe account",
      kind: "decision",
      owner: "agent",
      status: "pending",
      answer: {
        text: "EU",
        messageId: null,
        answeredBy: "u1",
        answeredAt: "2026-09-28T10:00:00.000Z",
      },
      ...over,
    }) as ExpectedOutput;

  it("stamps the slot whose CURRENT answer was read", () => {
    const { outputs, stamped } = stampPickedUp([slot()], [answer()], NOW);
    expect(stamped).toBe(1);
    expect(outputs[0]!.answerPickedUpAt).toBe(NOW.toISOString());
  });

  it("never marks a NEWER answer read (it landed after the read)", () => {
    const newer = slot({
      answer: {
        text: "US",
        messageId: null,
        answeredBy: "u1",
        answeredAt: "2026-09-28T11:00:00.000Z",
      },
    });
    const { stamped, outputs } = stampPickedUp([newer], [answer()], NOW);
    expect(stamped).toBe(0);
    expect(outputs[0]!.answerPickedUpAt).toBeUndefined();
  });

  it("keeps the FIRST receipt, and ignores slotless room answers", () => {
    const first = "2026-09-28T10:30:00.000Z";
    const { stamped } = stampPickedUp(
      [slot({ answerPickedUpAt: first })],
      [answer(), answer({ id: "a2", slot: null })],
      NOW
    );
    expect(stamped).toBe(0);
  });
});
