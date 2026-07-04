import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the DB client so these run without a live Postgres — we assert on the
// exact row values the helper would insert, not on persistence.
let capturedInsert: Record<string, unknown> | null = null;
let updateCalled = false;

vi.mock("../client-pg.js", () => ({
  db: {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        capturedInsert = v;
        return Promise.resolve();
      },
    }),
    update: () => ({
      set: () => ({
        where: () => {
          updateCalled = true;
          return Promise.resolve();
        },
      }),
    }),
  },
}));

const { persistAssistantReply } = await import("./persist-assistant-reply.js");
const { computeMessageHash } = await import("./message-hash.js");

beforeEach(() => {
  capturedInsert = null;
  updateCalled = false;
});

describe("persistAssistantReply", () => {
  it("derives previousHash from userMessageId+triggerContent and chains the hash", async () => {
    const r = await persistAssistantReply({
      channelId: "ch",
      userId: "u",
      content: "pong",
      userMessageId: "umsg",
      triggerContent: "ping",
      metadata: { a: 1 },
    });
    const expectedPrev = computeMessageHash("umsg", "ping");
    expect(r.previousHash).toBe(expectedPrev);
    expect(r.hash).toBe(computeMessageHash(r.assistantId, "pong", expectedPrev));
    expect(capturedInsert!.previousHash).toBe(expectedPrev);
    expect(capturedInsert!.hash).toBe(r.hash);
    expect(capturedInsert!.metadata).toEqual({ a: 1 });
    expect(updateCalled).toBe(true); // channels.updatedAt bumped
  });

  it("uses an explicit previousHash override (discord inbound-hash path)", async () => {
    const r = await persistAssistantReply({
      channelId: "ch",
      userId: "u",
      content: "hi",
      previousHash: "inbound-hash",
    });
    expect(r.previousHash).toBe("inbound-hash");
    expect(r.hash).toBe(computeMessageHash(r.assistantId, "hi", "inbound-hash"));
  });

  it("throws when neither previousHash nor userMessageId+triggerContent is given", async () => {
    await expect(
      persistAssistantReply({ channelId: "ch", userId: "u", content: "x" })
    ).rejects.toThrow(/previousHash or userMessageId/);
  });

  it("omits metadata / sessionId / routed / messageCategory when not provided", async () => {
    await persistAssistantReply({
      channelId: "ch",
      userId: "u",
      content: "x",
      previousHash: "p",
    });
    expect("metadata" in capturedInsert!).toBe(false); // NULL column, not {}
    expect("sessionId" in capturedInsert!).toBe(false);
    expect("routedTeammateId" in capturedInsert!).toBe(false);
    expect("messageCategory" in capturedInsert!).toBe(false);
  });
});
