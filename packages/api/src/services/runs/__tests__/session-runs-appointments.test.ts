import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AN APPOINTMENT IS NOT A RUN.
 *
 * A `scheduled` focus session is work (`session-kind.ts` classifies it so) and
 * carries no `playbook_runs` row, so the session flow of the unified run feed
 * used to select it and map it to `running` — a weekly appointment appeared in
 * the feed and in `synap diagnose` as a RUNNING run that had executed nothing.
 *
 * Driven through the real `listRuns` → `listSessionRuns`. The DB is mocked, but
 * the mock APPLIES the composed status predicates (`eq` / `ne` / `inArray` on
 * `focus_sessions.status`) to fixture rows, so the assertion is on which rows
 * come back, not on the shape of the WHERE.
 *
 * What it does NOT cover: every other predicate in the tree (owner floor,
 * `sessionKindWhere`, scope) evaluates as TRUE here — those are other guards'
 * business. It proves the status axis only.
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

vi.mock("../../../utils/user-visible-where.js", () => ({
  userVisibleWhere: vi.fn(() => ({ userVisible: true })),
  workspaceLensWhere: vi.fn(() => ({ workspaceLens: true })),
  ownerPrivateVisibleWhere: vi.fn(() => ({ ownerPrivate: true })),
}));

vi.mock("../../../utils/project-scope.js", () => ({
  accessScopeWhere: vi.fn(() => ({ accessScope: true })),
}));

import { focusSessions } from "@synap/database";
import { listRuns } from "../index.js";

type Node = Record<string, unknown>;
type Row = { id: string; status: string; startedAt: Date };

/** Apply the status predicates of a captured WHERE tree to one row. */
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

function sessionLedger(rows: Row[]) {
  const captured: { where?: unknown } = {};
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const m of ["from", "leftJoin", "orderBy"]) {
    chain[m] = vi.fn(() => chain);
  }
  chain.where = vi.fn((w: unknown) => {
    captured.where = w;
    return chain;
  });
  chain.limit = vi.fn(async () => rows.filter((r) => matches(captured.where, r)));
  return { chain, captured };
}

const ROWS: Row[] = [
  { id: "appointment", status: "scheduled", startedAt: new Date("2026-09-14T08:00:00Z") },
  { id: "live-work", status: "active", startedAt: new Date("2026-09-13T09:00:00Z") },
  { id: "done-work", status: "closed", startedAt: new Date("2026-09-12T09:00:00Z") },
];

describe("runs feed — a scheduled session (appointment) is not a run", () => {
  beforeEach(() => vi.clearAllMocks());

  it("the unfiltered session flow omits the appointment and keeps live work", async () => {
    const { chain } = sessionLedger(ROWS);
    mockDb.select.mockReturnValue(chain);

    const runs = await listRuns({ userId: "u1", flowType: "session" });

    expect(runs.map((r) => r.id)).toEqual(["live-work", "done-work"]);
    expect(runs.find((r) => r.id === "live-work")?.status).toBe("running");
  });

  it("the `running` filter returns the active session and never the appointment", async () => {
    const { chain } = sessionLedger(ROWS);
    mockDb.select.mockReturnValue(chain);

    const runs = await listRuns({
      userId: "u1",
      flowType: "session",
      status: "running",
    });

    expect(runs.map((r) => r.id)).toEqual(["live-work"]);
  });

  it("the `running` filter does not itself claim `scheduled` as a running state", async () => {
    // The ledger-level exclusion above would mask a `running` mapping that still
    // lists `scheduled`; this pins the reverse mapper independently.
    const { chain, captured } = sessionLedger(ROWS);
    mockDb.select.mockReturnValue(chain);

    await listRuns({ userId: "u1", flowType: "session", status: "running" });

    const found: string[][] = [];
    const walk = (node: unknown) => {
      if (!node || typeof node !== "object") return;
      const n = node as Node;
      if (Array.isArray(n.and)) n.and.forEach(walk);
      const pair = n.inArray as [unknown, string[]] | undefined;
      if (pair && pair[0] === focusSessions.status) found.push(pair[1]);
    };
    walk(captured.where);
    // Non-vacuity: the status filter was actually composed and seen.
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("active");
    expect(found[0]).not.toContain("scheduled");
  });
});
