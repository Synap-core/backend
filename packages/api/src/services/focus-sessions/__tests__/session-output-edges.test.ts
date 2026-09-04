/**
 * "Blocked by an OUTPUT of another session" — the DERIVATION, and the two
 * things a caller depends on: the open-only rule and the owner floor.
 *
 * The join is pure, so most of this needs no database at all. The two async
 * readers are exercised against the same chainable db stub
 * `session-blocked-by.test.ts` uses.
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
    for (const m of ["select", "from", "where", "limit", "innerJoin"]) {
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
  };
  return { queue, calls, dbStub };
});

// PARTIAL mock: only `db` is replaced — a total replacement goes dark at
// COLLECTION time the moment the module imports one more export.
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return { ...actual, db: dbStub };
});

import {
  joinOutputDependencies,
  getSessionOutputDependencies,
  outputDependentsOf,
  openOutputBlockerIds,
  attachSessionOutputDependencies,
  type DependencyEdgeRow,
} from "../session-output-edges.js";

const A = "session-a";
const B = "session-b";
const X = "entity-x";

const targets = (sessionId: string, entityId = X, open = true) =>
  ({ sessionId, entityId, linkType: "targets", open }) as DependencyEdgeRow;
const produced = (sessionId: string, entityId = X, open = true) =>
  ({ sessionId, entityId, linkType: "produced", open }) as DependencyEdgeRow;

beforeEach(() => {
  queue.length = 0;
  calls.length = 0;
});

describe("joinOutputDependencies", () => {
  it("derives both directions from targets ∩ produced on the same entity", () => {
    const map = joinOutputDependencies([A, B], [targets(A), produced(B)]);
    expect(map.get(A)).toEqual({
      waitsOnOutputs: [{ entityId: X, producerSessionId: B }],
      outputsWaitedOnBy: [],
    });
    expect(map.get(B)).toEqual({
      waitsOnOutputs: [],
      outputsWaitedOnBy: [{ entityId: X, dependentSessionId: A }],
    });
  });

  it("reports the waiter even when the producer is OFF the page", () => {
    const map = joinOutputDependencies([A], [targets(A), produced(B)]);
    expect(map.get(A)!.waitsOnOutputs).toEqual([
      { entityId: X, producerSessionId: B },
    ]);
    expect(map.has(B)).toBe(false);
  });

  it("A ≠ B — a session targeting its own output is not blocked by itself", () => {
    const map = joinOutputDependencies([A], [targets(A), produced(A)]);
    expect(map.get(A)).toBeUndefined();
  });

  it("excludes a CLOSED producer — the output exists, nothing is waiting", () => {
    const map = joinOutputDependencies(
      [A, B],
      [targets(A), produced(B, X, false)]
    );
    expect(map.get(A)).toBeUndefined();
    expect(map.get(B)).toBeUndefined();
  });

  it("a targets edge with no producer, or a produced edge with no targeter, is not a dependency", () => {
    expect(joinOutputDependencies([A], [targets(A)]).size).toBe(0);
    expect(joinOutputDependencies([B], [produced(B)]).size).toBe(0);
  });

  it("dedupes duplicate edge rows onto ONE pair", () => {
    const map = joinOutputDependencies(
      [A],
      [targets(A), targets(A), produced(B), produced(B)]
    );
    expect(map.get(A)!.waitsOnOutputs).toHaveLength(1);
  });

  it("keeps distinct entities apart", () => {
    const map = joinOutputDependencies(
      [A],
      [
        targets(A, "e1"),
        produced(B, "e1"),
        targets(A, "e2"),
        produced("session-c", "e2"),
      ]
    );
    expect(map.get(A)!.waitsOnOutputs).toEqual([
      { entityId: "e1", producerSessionId: B },
      { entityId: "e2", producerSessionId: "session-c" },
    ]);
  });

  it("returns an empty map for an empty page", () => {
    expect(joinOutputDependencies([], [targets(A), produced(B)]).size).toBe(0);
  });
});

describe("getSessionOutputDependencies", () => {
  it("short-circuits without touching the db when the page is empty", async () => {
    expect((await getSessionOutputDependencies([], "u")).size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("short-circuits after the first query when the page touches no entity", async () => {
    queue.push([]); // no targets/produced edges for the page
    expect((await getSessionOutputDependencies([A], "u")).size).toBe(0);
    expect(calls.filter((c) => c.method === "from")).toHaveLength(1);
  });

  it("joins the second (owner-floored) query into both directions", async () => {
    queue.push([{ toId: X }]);
    queue.push([
      { sessionId: A, entityId: X, linkType: "targets", status: "active" },
      { sessionId: B, entityId: X, linkType: "produced", status: "active" },
    ]);
    const map = await getSessionOutputDependencies([A, B], "u");
    expect(map.get(A)!.waitsOnOutputs).toEqual([
      { entityId: X, producerSessionId: B },
    ]);
    expect(map.get(B)!.outputsWaitedOnBy).toEqual([
      { entityId: X, dependentSessionId: A },
    ]);
    // The counterparty side is reached through an owner-floored join, never a
    // bare links read — that predicate is the only thing keeping another
    // user's session ids out of the result.
    expect(calls.some((c) => c.method === "innerJoin")).toBe(true);
  });

  it("applies the open-only rule to the PRODUCER's real status", async () => {
    queue.push([{ toId: X }]);
    queue.push([
      { sessionId: A, entityId: X, linkType: "targets", status: "active" },
      { sessionId: B, entityId: X, linkType: "produced", status: "completed" },
    ]);
    const map = await getSessionOutputDependencies([A, B], "u");
    expect(map.size).toBe(0);
  });
});

describe("attachSessionOutputDependencies", () => {
  it("projects both keys onto every row, defaulting to empty", async () => {
    queue.push([{ toId: X }]);
    queue.push([
      { sessionId: A, entityId: X, linkType: "targets", status: "active" },
      { sessionId: B, entityId: X, linkType: "produced", status: "active" },
    ]);
    const rows = await attachSessionOutputDependencies(
      [
        { id: A, goal: "a" },
        { id: B, goal: "b" },
        { id: "c", goal: "c" },
      ],
      "u"
    );
    expect(rows[0]).toMatchObject({
      id: A,
      goal: "a",
      waitsOnOutputs: [{ entityId: X, producerSessionId: B }],
      outputsWaitedOnBy: [],
    });
    expect(rows[2]).toMatchObject({
      waitsOnOutputs: [],
      outputsWaitedOnBy: [],
    });
  });

  it("returns [] without querying for an empty page", async () => {
    expect(await attachSessionOutputDependencies([], "u")).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("outputDependentsOf", () => {
  it("reports waiters REGARDLESS of the producer's status (the reactor's read)", async () => {
    queue.push([{ toId: X }]); // produced by the now-CLOSED session
    queue.push([{ sessionId: A, entityId: X }]);
    expect(await outputDependentsOf(B, "u")).toEqual([
      { entityId: X, dependentSessionId: A },
    ]);
  });

  it("excludes the session itself and dedupes", async () => {
    queue.push([{ toId: X }]);
    queue.push([
      { sessionId: B, entityId: X },
      { sessionId: A, entityId: X },
      { sessionId: A, entityId: X },
    ]);
    expect(await outputDependentsOf(B, "u")).toEqual([
      { entityId: X, dependentSessionId: A },
    ]);
  });

  it("returns [] when the session produced nothing", async () => {
    queue.push([]);
    expect(await outputDependentsOf(B, "u")).toEqual([]);
  });
});

describe("openOutputBlockerIds", () => {
  it("returns the distinct OPEN producer sessions still owed", async () => {
    queue.push([{ toId: "e1" }, { toId: "e2" }]);
    queue.push([
      { sessionId: A, entityId: "e1", linkType: "targets", status: "active" },
      { sessionId: B, entityId: "e1", linkType: "produced", status: "active" },
      { sessionId: A, entityId: "e2", linkType: "targets", status: "active" },
      { sessionId: B, entityId: "e2", linkType: "produced", status: "active" },
    ]);
    expect(await openOutputBlockerIds(A, "u")).toEqual([B]);
  });
});
