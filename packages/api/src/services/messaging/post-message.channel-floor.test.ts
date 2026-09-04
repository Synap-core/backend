/**
 * postChannelMessage CHANNEL WRITE FLOOR (P0 IDOR).
 *
 * The door took a caller-supplied `channelId` and inserted with NO
 * authorization: any key holding `mcp.write` plus a known channel UUID could
 * append to that channel and — with `triggerAI` — make its agent take a turn.
 *
 * These tests pin the three properties of the fix:
 *   1. an invisible channel throws (NOT_FOUND) and writes NOTHING,
 *   2. a non-UUID id is rejected before it reaches a Postgres `uuid` compare,
 *   3. the floor runs BEFORE any idempotency lookup or insert — it fails CLOSED,
 *      never falling through to the insert.
 *
 * The predicate itself (`channelVisibilityWhere`) is the canonical one and is
 * covered at its own door; it is stubbed here so this file's DB mock need not
 * model the channels/workspace-membership schema.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  /** Rows the channel-floor lookup returns — empty = caller cannot see it. */
  channelRows: [] as Array<{ id: string }>,
  selectCalls: 0,
  insertCalls: 0,
  visibilityUserIds: [] as string[],
}));

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));

vi.mock("../../utils/channel-visibility.js", () => ({
  channelVisibilityWhere: (userId: string) => {
    h.visibilityUserIds.push(userId);
    return undefined;
  },
}));

// PARTIAL mock (see the `database-mock-total-ratchet` tripwire): keep the real
// tables + operators, fake only `db` and the two effects.
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      select: () => {
        h.selectCalls += 1;
        const chain: Record<string, unknown> = {
          from: () => chain,
          where: () => chain,
          orderBy: () => chain,
          limit: async () => h.channelRows,
        };
        return chain;
      },
      insert: () => {
        h.insertCalls += 1;
        return {
          values: () => ({
            onConflictDoNothing: () => ({
              returning: async () => [{ id: "new-msg" }],
            }),
          }),
        };
      },
    },
    emitMessageEvent: async () => undefined,
    computeMessageHash: () => "hash",
  };
});

const triggerAutoRespond = vi.fn(async () => undefined);
vi.mock("../../utils/trigger-auto-respond.js", () => ({ triggerAutoRespond }));
vi.mock("../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: vi.fn(),
}));

import { postChannelMessage } from "./post-message.js";

const CHAN = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  h.channelRows = [];
  h.selectCalls = 0;
  h.insertCalls = 0;
  h.visibilityUserIds.length = 0;
  triggerAutoRespond.mockClear();
});

describe("postChannelMessage — channel write floor", () => {
  it("throws NOT_FOUND and writes NOTHING when the caller cannot see the channel", async () => {
    await expect(
      postChannelMessage({
        channelId: CHAN,
        content: "injected",
        userId: "attacker",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(h.insertCalls).toBe(0);
  });

  it("does not trigger an agent turn in a channel the caller cannot see", async () => {
    await expect(
      postChannelMessage({
        channelId: CHAN,
        content: "wake up",
        role: "user",
        triggerAI: true,
        userId: "attacker",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(h.insertCalls).toBe(0);
    expect(triggerAutoRespond).not.toHaveBeenCalled();
  });

  it("floors on the AUTHENTICATED caller, not on anything body-supplied", async () => {
    await expect(
      postChannelMessage({
        channelId: CHAN,
        content: "x",
        userId: "user-1",
        agentUserId: "agent-9",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(h.visibilityUserIds).toEqual(["user-1"]);
  });

  it("rejects a non-UUID channel id without issuing any query", async () => {
    await expect(
      postChannelMessage({
        channelId: "not-a-uuid",
        content: "x",
        userId: "user-1",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(h.selectCalls).toBe(0);
    expect(h.insertCalls).toBe(0);
  });

  it("proceeds to the write when the channel IS visible", async () => {
    h.channelRows = [{ id: CHAN }];
    const r = await postChannelMessage({
      channelId: CHAN,
      content: "hello",
      userId: "user-1",
      // Explicit key → skips the content-dedup lookup, so the only select is
      // the floor's.
      idempotencyKey: "k-1",
    });

    expect(r.ackState).toBe("applied");
    expect(h.insertCalls).toBe(1);
    expect(h.selectCalls).toBe(1);
  });
});
