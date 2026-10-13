import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * A post into a session's OWN room files under that session (ticket 539d2fc8).
 *
 * Live: an agent started a session, got its `channelId`, and posted there. With
 * a second session open, the post came back `{session:"none", ambiguous:true}`
 * — "filed under none of them" — although the room names its session as surely
 * as a `sessionId` would.
 *
 * Driven through the real `resolveSessionHandle` → real `resolveRoomSession` →
 * real `resolveWorkSession`; only the rows `@synap/database` returns are
 * scripted, one result per query in the order the resolvers issue them.
 */

const ROOM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const h = vi.hoisted(() => ({
  /** One scripted result per `.limit()` call, consumed in order. */
  results: [] as unknown[][],
  /** The selected column keys of every query, in order. */
  queries: [] as string[][],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    getDb: vi.fn(async () => ({})),
    db: {
      select: vi.fn((columns: Record<string, unknown>) => {
        h.queries.push(Object.keys(columns ?? {}));
        const chain: Record<string, unknown> = {};
        chain.from = () => chain;
        chain.where = () => chain;
        chain.orderBy = () => chain;
        chain.limit = async () => h.results.shift() ?? [];
        return chain;
      }),
    },
  };
});

const { resolveSessionHandle } = await import("../handlers/shared.js");

const roomRow = (userId: string) => ({
  id: "S-ROOM",
  userId,
  workspaceId: null,
  title: null,
  goal: null,
});

beforeEach(() => {
  h.results = [];
  h.queries = [];
});

describe("synap_post_message into a session's own room", () => {
  it("is attributed to that session even with several sessions open", async () => {
    h.results = [[roomRow("user-1")], [{ id: "S-ROOM" }]];
    const r = await resolveSessionHandle(
      "synap_post_message",
      { channelId: ROOM, content: "progress" },
      "user-1"
    );
    expect(r?.session).toEqual({
      sessionId: "S-ROOM",
      attribution: "explicit",
    });
    expect(r?.attribution).toEqual({
      session: "explicit",
      ambiguous: false,
      openCount: null,
    });
  });

  it("a room whose session is NOT the caller's is no claim — default resolution, nothing reported as dropped", async () => {
    h.results = [[roomRow("someone-else")], [{ id: "S-A" }, { id: "S-B" }]];
    const r = await resolveSessionHandle(
      "synap_post_message",
      { channelId: ROOM, content: "x" },
      "user-1"
    );
    expect(r?.attribution).toEqual({
      session: "none",
      ambiguous: true,
      openCount: 2,
    });
  });

  it("a room with no session falls back to the default resolution", async () => {
    h.results = [[], [{ id: "S-ONLY" }]];
    const r = await resolveSessionHandle(
      "synap_post_message",
      { channelId: ROOM, content: "x" },
      "user-1"
    );
    expect(r?.attribution).toMatchObject({
      session: "derived",
      via: "unclaimed",
    });
  });

  it("an explicit sessionId still wins — the room is never looked up", async () => {
    h.results = [[{ id: "S-NAMED" }]];
    const r = await resolveSessionHandle(
      "synap_post_message",
      { channelId: ROOM, sessionId: "S-NAMED", content: "x" },
      "user-1"
    );
    expect(r?.session?.sessionId).toBe("S-NAMED");
    expect(h.queries).toHaveLength(1);
    expect(h.queries[0]).not.toContain("goal");
  });
});
