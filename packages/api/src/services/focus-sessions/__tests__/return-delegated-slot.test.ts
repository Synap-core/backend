/**
 * REJECTION RETURNS THE SLOT — the third corner of the delegation loop.
 *
 * Approval stamps `done` (`satisfyExpectedOutputs`); delegation stamps
 * `delegatedTo` (`delegateExpectedOutput`); rejection had NOTHING. The reason a
 * reviewer typed went into a proposals column nothing on the session board
 * reads, and the slot stayed marked as delegated to an agent that had already
 * been told no — so the board showed "in progress" forever and the single most
 * actionable sentence in the loop reached nobody.
 *
 * Two properties are worth pinning and they are both about restraint:
 *   • EXACTLY ONE message per rejection, and none at all when there is nothing
 *     to hand back. A rejection that chatters into the room is worse than one
 *     that is silent.
 *   • The slot comes back PENDING. No fourth status value: `status !== "done"`
 *     is what `complete-session.ts`'s close warning and `session-outputs.ts`'s
 *     `pendingExpected` both read, and a `returned` value would fork them.
 *
 * The stamp is read off the real `set()` payload, so the claim is about the
 * JSONB that reaches the column.
 *
 * DB-free: `@synap/database` is partially mocked; the message door is a spy.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const SESSION = "11111111-1111-4111-8111-111111111111";
const CHANNEL = "44444444-4444-4444-8444-444444444444";

let sessionRow: Record<string, unknown> | undefined;
let lockedOutputs: unknown[] = [];
const txSets: Record<string, unknown>[] = [];

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const tx = {
    select: () => {
      const b: Record<string, unknown> = {
        from: () => b,
        where: () => b,
        for: async () => [{ expectedOutputs: lockedOutputs }],
      };
      return b;
    },
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        txSets.push(patch);
        return { where: async () => undefined };
      },
    }),
  };
  return {
    ...actual,
    db: {
      transaction: async (cb: (t: unknown) => unknown) => cb(tx),
      query: {
        focusSessions: { findFirst: async () => sessionRow },
      },
    },
  };
});

const postChannelMessage = vi.fn(async (_p: Record<string, unknown>) => ({
  success: true as const,
  messageId: "msg-1",
  channelId: CHANNEL,
  ackState: "applied" as const,
}));
vi.mock("../../messaging/post-message.js", () => ({
  postChannelMessage: (...a: unknown[]) =>
    (postChannelMessage as unknown as (...x: unknown[]) => unknown)(...a),
}));

const { returnDelegatedSlot } = await import("../return-delegated-slot.js");

const DELEGATED = [
  { kind: "document", label: "Spec" },
  {
    kind: "document",
    label: "Summary",
    delegatedTo: "workspace-builder",
    delegatedAt: "2026-09-01T00:00:00.000Z",
  },
];

const written = () =>
  txSets.at(-1)!.expectedOutputs as Record<string, unknown>[];

beforeEach(() => {
  vi.clearAllMocks();
  txSets.length = 0;
  lockedOutputs = DELEGATED;
  sessionRow = {
    id: SESSION,
    userId: "user-1",
    channelId: CHANNEL,
    expectedOutputs: DELEGATED,
  };
  postChannelMessage.mockResolvedValue({
    success: true,
    messageId: "msg-1",
    channelId: CHANNEL,
    ackState: "applied",
  });
});

describe("returnDelegatedSlot — one message, one un-delegation", () => {
  it("posts EXACTLY ONE message carrying the reason", async () => {
    const result = await returnDelegatedSlot({
      sessionId: SESSION,
      expectedLabel: "Summary",
      reason: "The numbers are from last quarter",
    });

    expect(result).toMatchObject({ returned: true, messageId: "msg-1" });
    expect(postChannelMessage).toHaveBeenCalledTimes(1);
    const post = postChannelMessage.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(post.channelId).toBe(CHANNEL);
    expect(post.content).toContain("Summary");
    expect(post.content).toContain("The numbers are from last quarter");
    // A return is a RECORD of a decision, not a new instruction — and `system`
    // is also the role no message door will start an agent turn from, so a
    // rejection can never kick off work by itself.
    expect(post.role).toBe("system");
    expect(post.triggerAI).toBe(false);
    // Posted as the session OWNER: a workspace admin rejecting someone else's
    // proposal may not be able to see that person's session room at all.
    expect(post.userId).toBe("user-1");
  });

  it("clears the delegation and records the return, leaving the slot PENDING", async () => {
    await returnDelegatedSlot({
      sessionId: SESSION,
      expectedLabel: "Summary",
      reason: "Too long",
    });

    const slot = written()[1]!;
    expect(slot).toMatchObject({
      label: "Summary",
      returnedReason: "Too long",
    });
    expect(typeof slot.returnedAt).toBe("string");
    // The un-delegation — the half that unsticks the board.
    expect(slot).not.toHaveProperty("delegatedTo");
    expect(slot).not.toHaveProperty("delegatedAt");
    // NO new status value, and certainly not `done`.
    expect(slot).not.toHaveProperty("status");
    // Every other slot untouched.
    expect(written()[0]).toEqual({ kind: "document", label: "Spec" });
  });

  it("still returns the slot when the reviewer gave no reason", async () => {
    await returnDelegatedSlot({ sessionId: SESSION, expectedLabel: "Summary" });
    expect(postChannelMessage).toHaveBeenCalledTimes(1);
    const slot = written()[1]!;
    expect(slot).not.toHaveProperty("returnedReason");
    expect(typeof slot.returnedAt).toBe("string");
  });

  it("matches the label case-insensitively and reports the DECLARED casing", async () => {
    await returnDelegatedSlot({
      sessionId: SESSION,
      expectedLabel: "  summary ",
      reason: "nope",
    });
    const post = postChannelMessage.mock.calls[0]![0] as { content: string };
    expect(post.content).toContain('"Summary"');
  });
});

describe("returnDelegatedSlot — silence is the default", () => {
  it("says nothing when the claim names no declared slot", async () => {
    const result = await returnDelegatedSlot({
      sessionId: SESSION,
      expectedLabel: "Board memo",
      reason: "nope",
    });
    expect(result).toEqual({ returned: false });
    expect(postChannelMessage).not.toHaveBeenCalled();
    expect(txSets).toHaveLength(0);
  });

  it("does NOT hand back a slot that is already satisfied", async () => {
    // Its `done` came from a DIFFERENT, approved proposal. A later rejection of
    // something else is not evidence against it.
    const done = [{ kind: "document", label: "Summary", status: "done" }];
    sessionRow = { ...sessionRow!, expectedOutputs: done };
    lockedOutputs = done;

    const result = await returnDelegatedSlot({
      sessionId: SESSION,
      expectedLabel: "Summary",
      reason: "nope",
    });
    expect(result).toEqual({ returned: false });
    expect(postChannelMessage).not.toHaveBeenCalled();
    expect(txSets).toHaveLength(0);
  });

  it("stamps the board but posts nothing when the session has no room", async () => {
    // No room is minted here: a return into a fresh empty channel nobody reads
    // is noise, and the stamp already carries the reason to the board.
    sessionRow = { ...sessionRow!, channelId: null };
    const result = await returnDelegatedSlot({
      sessionId: SESSION,
      expectedLabel: "Summary",
      reason: "nope",
    });
    expect(result).toMatchObject({ returned: true });
    expect(result.messageId).toBeUndefined();
    expect(postChannelMessage).not.toHaveBeenCalled();
    expect(written()[1]).toMatchObject({ returnedReason: "nope" });
  });

  it("swallows a failing message door — the rejection has already happened", async () => {
    postChannelMessage.mockRejectedValueOnce(new Error("channel gone"));
    await expect(
      returnDelegatedSlot({
        sessionId: SESSION,
        expectedLabel: "Summary",
        reason: "nope",
      })
    ).resolves.toEqual({ returned: false });
  });

  it("says nothing about a session that does not exist", async () => {
    sessionRow = undefined;
    const result = await returnDelegatedSlot({
      sessionId: SESSION,
      expectedLabel: "Summary",
    });
    expect(result).toEqual({ returned: false });
    expect(postChannelMessage).not.toHaveBeenCalled();
  });
});
