/**
 * `attachSessionParticipants` / `withSessionParticipants` — the ONE session
 * roster derivation, shared by `focusSessions.list` and `focusSessions.get`.
 *
 * WHAT THIS FILE GUARDS, and why each one is here rather than implied:
 *
 *   - BATCH, never N+1 — asserted by COUNTING the store calls for a multi-row
 *     page, not by reading the source. A per-session loop passes every shape
 *     assertion and fails only a call count.
 *   - ORDER — the UI colours each party by INDEX and `SELECT DISTINCT` gives no
 *     ordering, so an unsorted union makes agents swap colours between polls.
 *     Invisible to `tsc` and to any test that only checks membership, so the
 *     fixtures below are built so that INSERTION order ≠ SORTED order: dropping
 *     `.sort()` changes the array, it does not merely reorder an already-sorted
 *     one.
 *   - UNION of both stores — one fixture session per quadrant (declared-only,
 *     derived-only, both, neither). The both-quadrant row is what rules out a
 *     union that double-counts; the declared-only and derived-only rows are what
 *     rule out an implementation that reads a single store.
 *   - NAMES RESOLVE — a bare uuid is a worse answer than the empty list this
 *     replaces, so the assertion is on the VALUE that arrives, not on the key
 *     being declared.
 *
 * WHAT IT DOES NOT COVER, measured:
 *   - `displayNameForUser` is MOCKED to `row.name ?? undefined`. This file
 *     proves the resolved name is threaded onto the participant and that an
 *     unnameable row falls back to the uuid prefix; it does NOT re-test that
 *     function's agent/email precedence, which is its own.
 *   - `userVisibleWhere` is mocked to a sentinel. The assertion is REACHABILITY
 *     — that the floor is built with the caller's id and handed to the query —
 *     not that the emitted SQL is correct; that predicate is tested where it
 *     lives. Postgres is not available in this suite, so no SQL is executed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;

const {
  selectDistinctMock,
  selectMock,
  userVisibleWhereMock,
  derivedRows,
  userRows,
} = vi.hoisted(() => ({
  selectDistinctMock: vi.fn(),
  selectMock: vi.fn(),
  userVisibleWhereMock: vi.fn(
    (_col: unknown, userId: string) => `visible(${userId})`
  ),
  derivedRows: { value: [] as Row[] },
  userRows: { value: [] as Row[] },
}));

/**
 * PARTIAL mock, not a total replacement — the form
 * `__tripwires__/database-mock-total-ratchet.test.ts` requires. A TOTAL mock of
 * this module (a factory taking no arguments) dies at COLLECTION time the moment
 * any source file in the import graph starts using an export the mock does not
 * list: the whole file goes dark, not one test.
 *
 * The prose above is deliberately paraphrased rather than quoting the offending
 * call shape: that ratchet greps RAW source, comments included, so spelling the
 * pattern out here made this very file register as an offender while the code
 * below was already compliant. (The same blindness runs the other way — a
 * commented-out total mock still counts against the baseline.)
 *
 * Keeping `...actual` also means
 * the REAL Drizzle `proposals` / `users` column objects and the real `and` /
 * `inArray` / `isNotNull` builders are exercised — only `db` is faked, which is
 * the single thing this suite cannot have (no Postgres here).
 */
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      selectDistinct: (...args: unknown[]) => {
        selectDistinctMock(...args);
        return {
          from: () => ({ where: async () => derivedRows.value }),
        };
      },
      select: (...args: unknown[]) => {
        selectMock(...args);
        return {
          from: () => ({ where: async () => userRows.value }),
        };
      },
    },
  };
});

vi.mock("../../../utils/user-visible-where.js", () => ({
  userVisibleWhere: userVisibleWhereMock,
}));

vi.mock("../../../routers/proposals/display.js", () => ({
  displayNameForUser: (row: { name: string | null }) => row.name ?? undefined,
}));

import {
  attachSessionParticipants,
  withSessionParticipants,
} from "../participants.js";

/** Every id here is a full uuid so the 8-char fallback is distinguishable. */
const ZOE = "ffffffff-0000-0000-0000-000000000001";
const ALICE = "11111111-0000-0000-0000-000000000001";
const BOB = "77777777-0000-0000-0000-000000000001";
const GHOST = "aaaaaaaa-dead-0000-0000-000000000001";

beforeEach(() => {
  vi.clearAllMocks();
  derivedRows.value = [];
  userRows.value = [
    {
      id: ZOE,
      name: "Zoe",
      email: "z@x",
      userType: "agent",
      agentMetadata: null,
    },
    {
      id: ALICE,
      name: "Alice",
      email: "a@x",
      userType: "agent",
      agentMetadata: null,
    },
    {
      id: BOB,
      name: "Bob",
      email: "b@x",
      userType: "agent",
      agentMetadata: null,
    },
  ];
});

describe("attachSessionParticipants — the union of the two stores", () => {
  it("covers all four quadrants: declared-only, derived-only, both, neither", async () => {
    derivedRows.value = [
      { sessionId: "s-derived", agentUserId: BOB },
      { sessionId: "s-both", agentUserId: ALICE },
    ];
    const rows = await attachSessionParticipants(
      [
        { id: "s-declared", agentIds: [ZOE] },
        { id: "s-derived", agentIds: [] },
        // `s-both` names ALICE in BOTH stores — the row that rules out a union
        // which double-counts an agent present in each.
        { id: "s-both", agentIds: [ALICE] },
        { id: "s-neither", agentIds: null },
      ],
      "user-1"
    );

    expect(rows.map((r) => r.participants.map((p) => p.id))).toEqual([
      [ZOE],
      [BOB],
      [ALICE],
      [],
    ]);
  });

  it("resolves NAMES — never a bare uuid for a known agent", async () => {
    derivedRows.value = [{ sessionId: "s1", agentUserId: BOB }];
    const [row] = await attachSessionParticipants(
      [{ id: "s1", agentIds: [ALICE] }],
      "user-1"
    );
    expect(row?.participants).toEqual([
      { id: ALICE, name: "Alice" },
      { id: BOB, name: "Bob" },
    ]);
  });

  it("an id with no nameable users row falls back to the uuid PREFIX, not the full uuid", async () => {
    const [row] = await attachSessionParticipants(
      [{ id: "s1", agentIds: [GHOST] }],
      "user-1"
    );
    expect(row?.participants).toEqual([{ id: GHOST, name: GHOST.slice(0, 8) }]);
    expect(row?.participants[0]?.name).not.toBe(GHOST);
  });

  it("ignores non-string / empty junk in the declared column", async () => {
    const [row] = await attachSessionParticipants(
      [{ id: "s1", agentIds: [ALICE, "", null, 42] }],
      "user-1"
    );
    expect(row?.participants.map((p) => p.id)).toEqual([ALICE]);
  });
});

describe("attachSessionParticipants — ORDER", () => {
  it("sorts the union, so insertion order cannot leak through", async () => {
    // Built so INSERTION order (declared first, then derived arrival) is
    // ZOE, BOB, ALICE — which is NOT the sorted order. Dropping `.sort()`
    // therefore changes the array rather than reordering an already-sorted one.
    derivedRows.value = [
      { sessionId: "s1", agentUserId: BOB },
      { sessionId: "s1", agentUserId: ALICE },
    ];
    const [row] = await attachSessionParticipants(
      [{ id: "s1", agentIds: [ZOE] }],
      "user-1"
    );
    const ids = row?.participants.map((p) => p.id) ?? [];
    expect(ids).toEqual([ALICE, BOB, ZOE]);
    expect(ids).toEqual([...ids].sort());
    // Non-vacuity: the fixture must actually be a scrambling, or the assertion
    // above would hold for an unsorted implementation too.
    expect(ids).not.toEqual([ZOE, BOB, ALICE]);
  });

  it("is STABLE across two identical calls whose store returns a different row order", async () => {
    derivedRows.value = [
      { sessionId: "s1", agentUserId: ZOE },
      { sessionId: "s1", agentUserId: ALICE },
    ];
    const first = await attachSessionParticipants(
      [{ id: "s1", agentIds: [BOB] }],
      "user-1"
    );
    // Same set, different SELECT DISTINCT order — Postgres guarantees nothing.
    derivedRows.value = [
      { sessionId: "s1", agentUserId: ALICE },
      { sessionId: "s1", agentUserId: ZOE },
    ];
    const second = await attachSessionParticipants(
      [{ id: "s1", agentIds: [BOB] }],
      "user-1"
    );
    expect(second[0]?.participants).toEqual(first[0]?.participants);
  });
});

describe("attachSessionParticipants — BATCH, never N+1", () => {
  it("a 6-row page costs exactly ONE proposals query and ONE users query", async () => {
    derivedRows.value = [
      { sessionId: "s3", agentUserId: ALICE },
      { sessionId: "s6", agentUserId: BOB },
    ];
    const page = Array.from({ length: 6 }, (_, i) => ({
      id: `s${i + 1}`,
      agentIds: i === 0 ? [ZOE] : [],
    }));

    const rows = await attachSessionParticipants(page, "user-1");

    expect(selectDistinctMock).toHaveBeenCalledTimes(1);
    expect(selectMock).toHaveBeenCalledTimes(1);
    // Non-vacuity: the page really did produce participants on more than one
    // row, so the counts above are not trivially 1 because nothing happened.
    expect(rows.filter((r) => r.participants.length > 0)).toHaveLength(3);
  });

  it("selects the session id, so ONE query can attribute rows back to a page", async () => {
    await attachSessionParticipants(
      [
        { id: "s1", agentIds: [] },
        { id: "s2", agentIds: [] },
      ],
      "user-1"
    );
    const selected = selectDistinctMock.mock.calls[0]?.[0] as
      Record<string, { name?: string }> | undefined;
    // A batch CANNOT attribute a proposal to its row without the session id in
    // the projection — an N+1 implementation is the only one that can omit it.
    // Asserted through the REAL Drizzle columns (partial mock), by key and by
    // the column's own name.
    expect(Object.keys(selected ?? {}).sort()).toEqual([
      "agentUserId",
      "sessionId",
    ]);
    expect(selected?.sessionId?.name).toBe("session_id");
    expect(selected?.agentUserId?.name).toBe("agent_user_id");
  });

  it("an empty page short-circuits — ZERO queries", async () => {
    const rows = await attachSessionParticipants([], "user-1");
    expect(rows).toEqual([]);
    expect(selectDistinctMock).not.toHaveBeenCalled();
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("skips the users query when the page has no participants at all", async () => {
    const rows = await attachSessionParticipants(
      [{ id: "s1", agentIds: [] }],
      "user-1"
    );
    expect(rows[0]?.participants).toEqual([]);
    expect(selectDistinctMock).toHaveBeenCalledTimes(1);
    expect(selectMock).not.toHaveBeenCalled();
  });
});

describe("attachSessionParticipants — access floor", () => {
  it("builds the visibility predicate with the CALLER's id", async () => {
    await attachSessionParticipants([{ id: "s1", agentIds: [] }], "user-42");
    expect(userVisibleWhereMock).toHaveBeenCalledTimes(1);
    expect(userVisibleWhereMock.mock.calls[0]?.[1]).toBe("user-42");
  });
});

describe("withSessionParticipants — the single-session form", () => {
  it("returns exactly what the batch form returns for the same row", async () => {
    derivedRows.value = [{ sessionId: "s1", agentUserId: BOB }];
    const single = await withSessionParticipants(
      { id: "s1", agentIds: [ZOE], goal: "ship" },
      "user-1"
    );
    derivedRows.value = [{ sessionId: "s1", agentUserId: BOB }];
    const [batched] = await attachSessionParticipants(
      [{ id: "s1", agentIds: [ZOE], goal: "ship" }],
      "user-1"
    );
    expect(single).toEqual(batched);
    // And it preserves the row it was handed.
    expect(single.goal).toBe("ship");
  });
});
