import { beforeEach, describe, expect, it, vi } from "vitest";

const { getDb, predicate, scopedDb, accessFrom } = vi.hoisted(() => {
  const predicate = vi.fn(() => ({ visible: true }));
  return {
    getDb: vi.fn(),
    predicate,
    scopedDb: vi.fn(() => ({ predicate })),
    accessFrom: vi.fn((ctx: unknown) => ({ ctx })),
  };
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    getDb,
    and: vi.fn((...conditions: unknown[]) => ({
      and: conditions.filter((condition) => condition !== undefined),
    })),
    or: vi.fn((...conditions: unknown[]) => ({
      or: conditions.filter((condition) => condition !== undefined),
    })),
    eq: vi.fn((column: unknown, value: unknown) => ({ eq: [column, value] })),
    gt: vi.fn((column: unknown, value: unknown) => ({ gt: [column, value] })),
    lt: vi.fn((column: unknown, value: unknown) => ({ lt: [column, value] })),
    isNull: vi.fn((column: unknown) => ({ isNull: column })),
    asc: vi.fn((column: unknown) => ({ asc: column })),
    desc: vi.fn((column: unknown) => ({ desc: column })),
  };
});

vi.mock("../access/index.js", () => ({
  AccessContext: { from: accessFrom },
  scopedDb,
}));

// Proven against real SQL in `workers.pglite.test.ts`; here each row gets
// what the page-wide read answers for it.
const HEALTH = {
  state: "healthy",
  marks: [],
  consecutiveFailures: 0,
  offReason: null,
};
vi.mock("../services/playbooks/workers.js", () => ({
  automationGoalsAndHealth: vi.fn(
    async ({ automations }: { automations: { id: string }[] }) =>
      new Map(
        automations.map((a, i) => [
          a.id,
          {
            goal: i === 0 ? { id: "goal-1", name: "Ship" } : null,
            health: HEALTH,
          },
        ])
      )
  ),
}));

import { automationsRouter } from "./automations.js";
import { decodeDefinitionCursor } from "../utils/keyset-cursor.js";

const WORKSPACE = "00000000-0000-4000-8000-000000000010";
const AT = new Date("2026-07-31T00:00:00.000Z");

function selectChain(rows: unknown[]) {
  const captured: { where?: unknown } = {};
  const chain = {
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn().mockResolvedValue(rows),
    captured,
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockImplementation((where: unknown) => {
    captured.where = where;
    return chain;
  });
  chain.orderBy.mockReturnValue(chain);
  return chain;
}

describe("automations.listPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    predicate.mockReturnValue({ visible: true });
  });

  it("keeps the access floor and continues equal timestamps by id", async () => {
    const rows = [
      {
        id: "00000000-0000-4000-8000-000000000001",
        updatedAt: AT,
      },
      {
        id: "00000000-0000-4000-8000-000000000002",
        updatedAt: AT,
      },
      {
        id: "00000000-0000-4000-8000-000000000003",
        updatedAt: AT,
      },
    ];
    const chain = selectChain(rows);
    getDb.mockResolvedValue({ select: vi.fn(() => chain) });

    const caller = automationsRouter.createCaller({
      authenticated: true,
      userId: "user-1",
      workspaceId: WORKSPACE,
    } as never);
    const page = await caller.listPage({ workspaceId: WORKSPACE, limit: 2 });

    expect(page.automations).toEqual([
      {
        ...rows[0],
        servesGoal: { id: "goal-1", name: "Ship" },
        runHealth: HEALTH,
      },
      { ...rows[1], servesGoal: null, runHealth: HEALTH },
    ]);
    expect(decodeDefinitionCursor(page.nextCursor!)).toEqual({
      at: AT.toISOString(),
      id: rows[1]!.id,
    });
    expect(predicate).toHaveBeenCalledTimes(1);
    const where = chain.captured.where as { and: unknown[] };
    expect(where.and).toContainEqual({ visible: true });
  });
});
