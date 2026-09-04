import { describe, it, expect, vi, beforeEach } from "vitest";

// Mutable mock state — configured per test.
const state = vi.hoisted(() => ({
  selectRows: [] as Array<{ id: string }>,
  /**
   * Rows the CHANNEL WRITE FLOOR lookup returns. Non-empty = the caller may see
   * (and therefore post to) the channel. Default visible so the ack-integrity
   * assertions below keep testing what they were written to test; the floor
   * itself is covered by `post-message.channel-floor.test.ts`.
   */
  channelRows: [{ id: "chan-1" }] as Array<{ id: string }>,
  insertRows: [] as Array<{ id: string }>,
  insertCalls: 0,
}));

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));

// The channel floor's predicate is the canonical `channelVisibilityWhere`; it is
// unit-tested at its own door. Stub it here so this file's DB mock does not have
// to model the whole channels/workspace-membership schema.
vi.mock("../../utils/channel-visibility.js", () => ({
  channelVisibilityWhere: () => undefined,
}));

vi.mock("@synap/database", () => {
  // Two distinct selects reach this mock: the channel floor
  // (`from().where().limit()`) and the dedup lookup (which also calls
  // `orderBy()`). Key off `orderBy` so each resolves its own rows.
  const makeSelectChain = () => {
    let ordered = false;
    const chain: Record<string, unknown> = {
      from: vi.fn(() => chain),
      where: vi.fn(() => chain),
      orderBy: vi.fn(() => {
        ordered = true;
        return chain;
      }),
      limit: vi.fn(() =>
        Promise.resolve(ordered ? state.selectRows : state.channelRows)
      ),
    };
    return chain;
  };
  return {
    db: {
      select: vi.fn(() => makeSelectChain()),
      insert: vi.fn(() => {
        state.insertCalls += 1;
        return {
          values: vi.fn().mockReturnThis(),
          onConflictDoNothing: vi.fn().mockReturnThis(),
          returning: vi.fn(() => Promise.resolve(state.insertRows)),
        };
      }),
    },
    // Channel WRITE floor (the door now authorizes `channelId` before writing).
    channels: { id: "channels.id" },
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
    // PRE-EXISTING GAP (not from the attribution change): the module has
    // imported `emitMessageEvent` since the keystone fact-write landed, but this
    // mock never exported it — so every test reaching the INSERT path (3 of 5)
    // was already failing at HEAD. The 2 that passed return early on the dedup
    // path before the call. Added so the ack-integrity suite runs for real.
    emitMessageEvent: async () => undefined,
    // Attribution: the insert stamps authorType (agent vs human) from the
    // acting principal — see `agentUserId` on PostChannelMessageParams.
    MessageAuthorType: {
      HUMAN: "human",
      AI_AGENT: "ai_agent",
      EXTERNAL: "external",
      BOT: "bot",
    },
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
  state.channelRows = [{ id: "chan-1" }];
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
