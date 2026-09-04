/**
 * `session --blocked_by--> session` — the producer's owner floor and drop
 * semantics, and the reader's TWO-DIRECTION batch projection.
 *
 * The db is a chainable stub: every builder method returns the same thenable,
 * which resolves to the next queued result. That is enough to assert the shape
 * of what the reader returns and WHETHER the producer wrote at all — the two
 * things a caller depends on.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { queue, calls, dbStub } = vi.hoisted(() => {
  const queue: unknown[][] = [];
  const calls: Array<{ method: string; args: unknown[] }> = [];

  function chain(): Record<string, unknown> {
    const node: Record<string, unknown> = {
      then(resolve: (v: unknown) => unknown) {
        return Promise.resolve(queue.shift() ?? []).then(resolve);
      },
    };
    for (const m of [
      "select",
      "from",
      "where",
      "limit",
      "innerJoin",
      "values",
      "onConflictDoNothing",
      "returning",
    ]) {
      node[m] = (...args: unknown[]) => {
        calls.push({ method: m, args });
        return node;
      };
    }
    return node;
  }

  const shared = chain();
  const dbStub = {
    select: (...a: unknown[]) =>
      (shared.select as (...x: unknown[]) => unknown)(...a),
    insert: (...a: unknown[]) => {
      calls.push({ method: "insert", args: a });
      return shared;
    },
    delete: (...a: unknown[]) => {
      calls.push({ method: "delete", args: a });
      return shared;
    },
  };
  return { queue, calls, dbStub };
});

// PARTIAL mock: only `db` is replaced. A total replacement goes dark at
// COLLECTION time the moment the module under test imports one more export
// (`__tripwires__/database-mock-total-ratchet.test.ts` ratchets those down).
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return { ...actual, db: dbStub };
});

import {
  addSessionBlocker,
  removeSessionBlocker,
  getSessionEdges,
  attachSessionEdges,
  openBlockerIds,
} from "../session-blocked-by.js";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

beforeEach(() => {
  queue.length = 0;
  calls.length = 0;
});

describe("addSessionBlocker (producer)", () => {
  it("refuses a self-blocker without touching the db", async () => {
    expect(
      await addSessionBlocker({
        sessionId: A,
        blockerSessionId: A,
        userId: "u",
      })
    ).toEqual({
      linked: false,
      reason: "self_blocker",
    });
    expect(calls).toHaveLength(0);
  });

  it("DROPS a malformed handle before it can reach Postgres as a 22P02 throw", async () => {
    expect(
      await addSessionBlocker({
        sessionId: A,
        blockerSessionId: "not-a-uuid",
        userId: "u",
      })
    ).toEqual({ linked: false, reason: "not_found" });
    expect(calls).toHaveLength(0);
  });

  it("drops the edge when the owner floor does not return BOTH endpoints", async () => {
    queue.push([{ id: A }]); // only one of the two is owned
    expect(
      await addSessionBlocker({
        sessionId: A,
        blockerSessionId: B,
        userId: "u",
      })
    ).toEqual({
      linked: false,
      reason: "not_found",
    });
    expect(calls.some((c) => c.method === "insert")).toBe(false);
  });

  it("writes the edge — idempotently — when both endpoints are owned", async () => {
    queue.push([{ id: A }, { id: B }]);
    queue.push([]);
    expect(
      await addSessionBlocker({
        sessionId: A,
        blockerSessionId: B,
        userId: "u",
      })
    ).toEqual({
      linked: true,
    });
    expect(calls.some((c) => c.method === "insert")).toBe(true);
    expect(calls.some((c) => c.method === "onConflictDoNothing")).toBe(true);
  });
});

describe("removeSessionBlocker (producer)", () => {
  it("reports no_edge rather than pretending it removed one", async () => {
    queue.push([{ id: A }, { id: B }]);
    queue.push([]); // returning() → nothing deleted
    expect(
      await removeSessionBlocker({
        sessionId: A,
        blockerSessionId: B,
        userId: "u",
      })
    ).toEqual({
      removed: false,
      reason: "no_edge",
    });
  });

  it("reports removed when an edge was actually there", async () => {
    queue.push([{ id: A }, { id: B }]);
    queue.push([{ id: "link-1" }]);
    expect(
      await removeSessionBlocker({
        sessionId: A,
        blockerSessionId: B,
        userId: "u",
      })
    ).toEqual({
      removed: true,
    });
  });
});

describe("getSessionEdges (reader)", () => {
  it("projects BOTH directions from ONE query", async () => {
    // A --blocked_by--> B : A is blockedBy B, and B unblocks A.
    queue.push([{ fromId: A, toId: B }]);
    const map = await getSessionEdges([A, B]);
    expect(map.get(A)).toEqual({ blockedBy: [B], unblocks: [] });
    expect(map.get(B)).toEqual({ blockedBy: [], unblocks: [A] });
    expect(calls.filter((c) => c.method === "select")).toHaveLength(1);
  });

  it("an empty page short-circuits without a query", async () => {
    expect(await getSessionEdges([])).toEqual(new Map());
    expect(calls).toHaveLength(0);
  });
});

describe("attachSessionEdges (the list projection)", () => {
  it("stamps every row, defaulting an edgeless session to two empty arrays", async () => {
    queue.push([{ fromId: A, toId: B }]);
    const rows = await attachSessionEdges([
      { id: A, goal: "blocked" },
      { id: B, goal: "blocker" },
      { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", goal: "unrelated" },
    ]);
    expect(rows[0]).toEqual({
      id: A,
      goal: "blocked",
      blockedBy: [B],
      unblocks: [],
    });
    expect(rows[1]).toEqual({
      id: B,
      goal: "blocker",
      blockedBy: [],
      unblocks: [A],
    });
    expect(rows[2]!.blockedBy).toEqual([]);
    expect(rows[2]!.unblocks).toEqual([]);
  });
});

describe("openBlockerIds (the derivation — nothing stores blocked-ness)", () => {
  it("returns only blockers the join found still open", async () => {
    queue.push([{ blockerId: B }]);
    expect(await openBlockerIds(A)).toEqual([B]);
    expect(calls.some((c) => c.method === "innerJoin")).toBe(true);
  });

  it("is empty when every blocker has closed — that is 'unblocked'", async () => {
    queue.push([]);
    expect(await openBlockerIds(A)).toEqual([]);
  });
});
