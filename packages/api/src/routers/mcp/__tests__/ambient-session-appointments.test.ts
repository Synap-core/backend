import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A FUTURE APPOINTMENT IS NEVER WHERE A PRESENT WRITE BELONGS.
 *
 * `resolveAmbientSession` files an agent's write under the user's newest open
 * WORK session, ordered by `started_at desc`. An appointment (`scheduled`) is
 * work, and `materializeScheduledSession` inserts it through
 * `instantiateSession` WITHOUT a `startedAt` — so the column's `defaultNow()`
 * stamps the materialisation time. The 08:00 cron therefore makes a future
 * appointment the NEWEST open work session, and the next write lands in it
 * instead of the person's real current work.
 *
 * Driven through the real `resolveAmbientSession` → `listOpenFocusSessions`.
 * The DB is mocked, but the mock APPLIES the composed status predicates
 * (`eq` / `ne` / `inArray` on `focus_sessions.status`) and the `desc` order to
 * fixture rows, so the assertion is on which session is chosen.
 *
 * What it does NOT cover: the owner and `sessionKindWhere` predicates evaluate
 * as TRUE here — `session-kind.test.ts` pins the work narrowing separately.
 */

const { mockDb } = vi.hoisted(() => ({ mockDb: { select: vi.fn() } }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: mockDb,
    and: vi.fn((...c: unknown[]) => ({ and: c.filter((x) => x !== undefined) })),
    or: vi.fn((...c: unknown[]) => ({ or: c.filter((x) => x !== undefined) })),
    eq: vi.fn((col: unknown, v: unknown) => ({ eq: [col, v] })),
    ne: vi.fn((col: unknown, v: unknown) => ({ ne: [col, v] })),
    inArray: vi.fn((col: unknown, v: unknown) => ({ inArray: [col, v] })),
    desc: vi.fn((col: unknown) => ({ desc: col })),
    drizzleSql: Object.assign(
      vi.fn((s: TemplateStringsArray) => ({ sql: s.join("?") })),
      { raw: vi.fn(() => ({ raw: true })) }
    ),
  };
});

import { focusSessions } from "@synap/database";
import { resolveAmbientSession } from "../handlers/shared.js";

type Node = Record<string, unknown>;
type Row = { id: string; goal: string; status: string; startedAt: Date };

function matches(node: unknown, row: Row): boolean {
  if (!node || typeof node !== "object") return true;
  const n = node as Node;
  if (Array.isArray(n.and)) return n.and.every((c) => matches(c, row));
  if (Array.isArray(n.or)) return n.or.some((c) => matches(c, row));
  for (const op of ["eq", "ne", "inArray"] as const) {
    const pair = n[op] as [unknown, unknown] | undefined;
    if (!pair || pair[0] !== focusSessions.status) continue;
    if (op === "eq") return row.status === pair[1];
    if (op === "ne") return row.status !== pair[1];
    return (pair[1] as string[]).includes(row.status);
  }
  return true;
}

function openSessionsQuery(rows: Row[]) {
  const captured: { where?: unknown; order?: unknown } = {};
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn((w: unknown) => {
    captured.where = w;
    return chain;
  });
  chain.orderBy = vi.fn((o: unknown) => {
    captured.order = o;
    return chain;
  });
  chain.limit = vi.fn(async (n: number) => {
    // Non-vacuity: the resolver still orders newest-started first, which is the
    // precondition for the defect this guards.
    expect(captured.order).toEqual({ desc: focusSessions.startedAt });
    return rows
      .filter((r) => matches(captured.where, r))
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, n)
      .map(({ id, goal, startedAt }) => ({ id, goal, startedAt }));
  });
  return chain;
}

describe("ambient session attribution — a scheduled appointment never captures a write", () => {
  beforeEach(() => vi.clearAllMocks());

  it("picks the OLDER active work session over a NEWER scheduled one", async () => {
    mockDb.select.mockReturnValue(
      openSessionsQuery([
        {
          id: "live-work",
          goal: "Ship the fix",
          status: "active",
          startedAt: new Date("2026-09-14T07:30:00Z"),
        },
        {
          // Materialised by the 08:00 cron: started_at = defaultNow() = newest.
          id: "monday-appointment",
          goal: "Weekly review",
          status: "scheduled",
          startedAt: new Date("2026-09-14T08:00:00Z"),
        },
      ])
    );

    const resolved = await resolveAmbientSession("u1");

    expect(resolved?.sessionId).toBe("live-work");
    expect(resolved?.openCount).toBe(1);
  });

  it("with only an appointment open, nothing is ambient", async () => {
    mockDb.select.mockReturnValue(
      openSessionsQuery([
        {
          id: "monday-appointment",
          goal: "Weekly review",
          status: "scheduled",
          startedAt: new Date("2026-09-14T08:00:00Z"),
        },
      ])
    );

    expect(await resolveAmbientSession("u1")).toBeUndefined();
  });
});
