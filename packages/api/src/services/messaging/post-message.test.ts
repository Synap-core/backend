import { describe, it, expect, vi, beforeEach } from "vitest";

// Mutable mock state — configured per test.
const state = vi.hoisted(() => ({
  selectRows: [] as Array<{ id: string }>,
  insertRows: [] as Array<{ id: string }>,
  insertCalls: 0,
}));

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));

vi.mock("@synap/database", () => {
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn(() => Promise.resolve(state.selectRows)),
  };
  return {
    db: {
      select: vi.fn(() => selectChain),
      insert: vi.fn(() => {
        state.insertCalls += 1;
        return {
          values: vi.fn().mockReturnThis(),
          onConflictDoNothing: vi.fn().mockReturnThis(),
          returning: vi.fn(() => Promise.resolve(state.insertRows)),
        };
      }),
    },
    messages: {
      id: "id",
      channelId: "channel_id",
      userId: "user_id",
      role: "role",
      content: "content",
      deletedAt: "deleted_at",
      timestamp: "timestamp",
    },
    MessageRole: { USER: "user", ASSISTANT: "assistant", SYSTEM: "system" },
    computeMessageHash: () => "hash",
    and: vi.fn(),
    eq: vi.fn(),
    isNull: vi.fn(),
    desc: vi.fn(),
    drizzleSql: vi.fn((strings: TemplateStringsArray) => ({
      sql: strings.join("?"),
    })),
  };
});

import { postChannelMessage } from "./post-message.js";

const base = {
  channelId: "11111111-1111-1111-1111-111111111111",
  userId: "user-1",
  content: "hello world",
};

beforeEach(() => {
  state.selectRows = [];
  state.insertRows = [];
  state.insertCalls = 0;
  vi.clearAllMocks();
});

describe("postChannelMessage — ack integrity", () => {
  it("applies a fresh message (ackState=applied) and inserts once", async () => {
    state.insertRows = [{ id: "new-msg" }];
    const r = await postChannelMessage({ ...base });
    expect(r.ackState).toBe("applied");
    expect(r.messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(state.insertCalls).toBe(1);
  });

  it("no-key retry: a prior identical (non-triggering) message returns duplicate-ignored, no insert", async () => {
    state.selectRows = [{ id: "prior-msg" }];
    // A plain post (no triggerAI) → the short-window content lookup catches the retry.
    const r = await postChannelMessage({ ...base });
    expect(r.ackState).toBe("duplicate-ignored");
    expect(r.messageId).toBe("prior-msg");
    expect(r.priorMessageId).toBe("prior-msg");
    // At-most-once: no second row written.
    expect(state.insertCalls).toBe(0);
  });

  it("triggerAI post bypasses content-dedup: an identical prior row still inserts a fresh turn", async () => {
    // A same-text message that turns the AI ON is a DELIBERATE invocation, not an
    // accidental retry — content-dedup must NOT collapse it (that would silently
    // drop a distinct agent turn, e.g. two "yes" answers to two questions). Retry
    // safety for triggerAI lives on the explicit idempotencyKey path instead.
    state.selectRows = [{ id: "prior-msg" }];
    state.insertRows = [{ id: "fresh-msg" }];
    // role="assistant" keeps this a pure dedup-bypass assertion: the bypass lives
    // before the insert (independent of role), and an assistant post never reaches
    // the USER-gated triggerAutoRespond chain, so no autorespond mocks are needed.
    const r = await postChannelMessage({
      ...base,
      triggerAI: true,
      role: "assistant",
    });
    expect(r.ackState).toBe("applied");
    expect(state.insertCalls).toBe(1);
  });

  it("explicit-key retry: ON CONFLICT no-op returns duplicate-ignored", async () => {
    state.insertRows = []; // conflict → nothing returned
    const r = await postChannelMessage({ ...base, idempotencyKey: "k-1" });
    expect(r.ackState).toBe("duplicate-ignored");
    // Explicit key skips the content lookup and keys on the derived PK.
    expect(state.insertCalls).toBe(1);
  });

  it("explicit key derives a stable message id across retries", async () => {
    state.insertRows = [{ id: "ignored" }];
    const r1 = await postChannelMessage({ ...base, idempotencyKey: "k-9" });
    const r2 = await postChannelMessage({ ...base, idempotencyKey: "k-9" });
    // First returns applied with the derived id; both calls compute the SAME id.
    expect(r1.messageId).toBe(r2.messageId);
    expect(r1.messageId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
