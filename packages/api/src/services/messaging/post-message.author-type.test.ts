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
  inserted: [] as Array<Record<string, unknown>>,
  notifyRoomPost: vi.fn(async () => undefined),
}));

vi.mock("@synap-core/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap-core/core")>()),
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));

// The channel floor's predicate is the canonical `channelVisibilityWhere`; it is
// unit-tested at its own door. Stub it here so this file's DB mock does not have
// to model the whole channels/workspace-membership schema.
vi.mock("../../utils/channel-visibility.js", () => ({
  channelVisibilityWhere: () => undefined,
}));

vi.mock("@synap/database", async (importOriginal) => {
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
    ...(await importOriginal<typeof import("@synap/database")>()),
    db: {
      select: vi.fn(() => makeSelectChain()),
      insert: vi.fn(() => {
        state.insertCalls += 1;
        return {
          values: vi.fn((v: Record<string, unknown>) => {
            state.inserted.push(v);
            return {
              onConflictDoNothing: vi.fn().mockReturnThis(),
              returning: vi.fn(() => Promise.resolve(state.insertRows)),
            };
          }),
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
    // A comment post stamps `message_category` (Documents v2).
    MessageCategory: { CHAT: "chat", COMMENT: "comment" },
    MessageAuthorType: {
      HUMAN: "human",
      AI_AGENT: "ai_agent",
      EXTERNAL: "external",
      BOT: "bot",
    },
    // An AGENT post stamps routedSource (attribution) on the insert.
    RoutedSource: { DIRECT: "direct" },
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

vi.mock("./notify-room-post.js", () => ({
  notifyRoomPost: state.notifyRoomPost,
}));

import { postChannelMessage, authorTypeForPost } from "./post-message.js";

const base = {
  channelId: "11111111-1111-1111-1111-111111111111",
  userId: "owner-1",
  content: "hello world",
};

beforeEach(() => {
  state.channelRows = [{ id: "chan-1" }];
  state.selectRows = [];
  state.insertRows = [{ id: "new-msg" }];
  state.inserted = [];
  vi.clearAllMocks();
});

/** The author type the door STORED for one post. */
async function storedAuthor(extra: Record<string, unknown>): Promise<unknown> {
  state.inserted = [];
  await postChannelMessage({ ...base, ...extra } as never);
  expect(state.inserted).toHaveLength(1);
  return state.inserted[0]!.authorType;
}

describe("postChannelMessage — who wrote the row (authorType)", () => {
  it("the session-recall notice (role assistant, no agent, owner's userId) is the pod, never the person", async () => {
    // The exact shape `session-recall.ts` posts with.
    expect(
      await storedAuthor({
        role: "assistant",
        triggerAI: false,
        idempotencyKey: "session-recall:s1:abc",
      })
    ).toBe("bot");
  });

  it("every pod-authored role without an agent is a bot", async () => {
    expect(await storedAuthor({ role: "system" })).toBe("bot");
    expect(await storedAuthor({})).toBe("bot"); // role defaults to assistant
  });

  it("a person's post (role user) is still human", async () => {
    expect(await storedAuthor({ role: "user" })).toBe("human");
  });

  it("an agent key's post is ai_agent whatever the role", async () => {
    expect(
      await storedAuthor({ role: "assistant", agentUserId: "agent-1" })
    ).toBe("ai_agent");
  });

  it("the pure rule matches", () => {
    expect(authorTypeForPost({ role: "assistant" })).toBe("bot");
    expect(authorTypeForPost({ role: "user" })).toBe("human");
    expect(authorTypeForPost({ role: "user", agentUserId: "a" })).toBe(
      "ai_agent"
    );
  });
});
