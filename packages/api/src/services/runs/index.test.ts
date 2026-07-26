import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression lock: `listRunGroups` (the grouped/collapsed runs view — one row
 * per automation/playbook) MUST apply the SAME `userVisibleWhere` user-floor
 * predicate that `listRuns` applies per-row. Without it, a group's counts
 * (runCount/completedCount/latestRunId/...) would silently fold in runs from
 * workspaces the caller cannot see — a cross-workspace leak invisible to the
 * UI (it just shows a bigger, wrong number).
 *
 * DB is mocked (no live Postgres here, mirroring
 * `automations.match-for-entity.test.ts` / `relations.get-connections.test.ts`):
 * the assertions are on the COMPOSED query — that `userVisibleWhere` is
 * invoked with the exact same column+userId `listAutomationRuns`/
 * `listPlaybookRuns` use, and that the returned predicate actually lands in
 * the `.where(and(...))` tree passed to the DB (not silently dropped).
 */

const { mockDb, mockUserVisibleWhere } = vi.hoisted(() => ({
  mockDb: { select: vi.fn() },
  mockUserVisibleWhere: vi.fn(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: mockDb,
    and: vi.fn((...conditions: unknown[]) => ({
      and: conditions.filter((c) => c !== undefined),
    })),
    eq: vi.fn((column: unknown, value: unknown) => ({ eq: [column, value] })),
    desc: vi.fn((column: unknown) => ({ desc: column })),
    drizzleSql: Object.assign(
      vi.fn((strings: TemplateStringsArray) => ({ sql: strings.join("?") })),
      { raw: vi.fn() }
    ),
  };
});

vi.mock("../../utils/user-visible-where.js", () => ({
  userVisibleWhere: mockUserVisibleWhere,
  workspaceLensWhere: vi.fn(() => ({ workspaceLens: true })),
  ownerPrivateVisibleWhere: vi.fn(() => ({ ownerPrivate: true })),
}));

vi.mock("../../utils/project-scope.js", () => ({
  accessScopeWhere: vi.fn(() => ({ accessScope: true })),
}));

import { listRunGroups } from "./index.js";

/** Chainable select() builder — supports the automation/playbook groupBy shape. */
function selectChain(rows: unknown[]) {
  const captured: { where?: unknown } = {};
  const chain = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn(),
    groupBy: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn().mockResolvedValue(rows),
    _captured: captured,
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.where.mockImplementation((w: unknown) => {
    captured.where = w;
    return chain;
  });
  chain.groupBy.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return chain;
}

const USER = "user-1";

describe("runs.listRunGroups — user-floor parity with listRuns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserVisibleWhere.mockReturnValue({ __userVisible: USER });
  });

  it("groupAutomationRuns applies userVisibleWhere(automationRuns.workspaceId, userId) in its WHERE", async () => {
    const chain = selectChain([
      {
        flowId: "auto-1",
        flowName: "Onboard",
        runCount: 3,
        completedCount: 2,
        failedCount: 1,
        hasRunning: false,
        latestStartedAt: new Date("2026-01-02"),
        latestRunId: "run-3",
        latestStatus: "failed",
      },
    ]);
    mockDb.select.mockReturnValue(chain);

    const groups = await listRunGroups({
      userId: USER,
      flowType: "automation",
    });

    expect(groups).toEqual([
      expect.objectContaining({
        flowType: "automation",
        flowId: "auto-1",
        runCount: 3,
      }),
    ]);

    // Same predicate call `listAutomationRuns` (listRuns' per-row ledger) makes:
    // userVisibleWhere(automationRuns.workspaceId, userId) — same column, same user.
    expect(mockUserVisibleWhere).toHaveBeenCalledTimes(1);
    const [column, userId] = mockUserVisibleWhere.mock.calls[0]!;
    expect(userId).toBe(USER);
    expect(column).toMatchObject({ name: "workspace_id" });

    // The floor actually reaches the composed WHERE — not silently dropped.
    const where = chain._captured.where as { and: unknown[] };
    expect(where.and).toContainEqual({ __userVisible: USER });
  });

  it("groupPlaybookRuns applies userVisibleWhere(playbookRuns.workspaceId, userId) in its WHERE", async () => {
    const chain = selectChain([
      {
        flowId: "pb-1",
        flowName: "Weekly digest",
        runCount: 5,
        completedCount: 5,
        failedCount: 0,
        hasRunning: false,
        latestStartedAt: new Date("2026-01-03"),
        latestRunId: "run-9",
        latestStatus: "completed",
      },
    ]);
    mockDb.select.mockReturnValue(chain);

    const groups = await listRunGroups({ userId: USER, flowType: "playbook" });

    expect(groups).toEqual([
      expect.objectContaining({
        flowType: "playbook",
        flowId: "pb-1",
        runCount: 5,
      }),
    ]);

    expect(mockUserVisibleWhere).toHaveBeenCalledTimes(1);
    const [column, userId] = mockUserVisibleWhere.mock.calls[0]!;
    expect(userId).toBe(USER);
    expect(column).toMatchObject({ name: "workspace_id" });

    const where = chain._captured.where as { and: unknown[] };
    expect(where.and).toContainEqual({ __userVisible: USER });
  });

  it("never returns groups when the user-floor predicate would exclude every row (DB does the real filtering)", async () => {
    // With a real Postgres, a userId the caller can't see any workspace for
    // yields zero rows from the ledger — assert listRunGroups just forwards
    // that (no client-side fallback that would re-admit unfiltered rows).
    const chain = selectChain([]);
    mockDb.select.mockReturnValue(chain);

    const groups = await listRunGroups({
      userId: USER,
      flowType: "automation",
    });

    expect(groups).toEqual([]);
  });

  it("merges automation+playbook groups and sorts them when latestStartedAt arrives as a STRING (postgres.js reality)", async () => {
    // `max(startedAt)` comes back from postgres.js as a STRING, not a Date. The
    // merge-sort did `latestStartedAt.getTime()` on it → "getTime is not a
    // function", which broke the diagnose door LIVE (it calls listRunGroups with
    // no flowType, so both ledgers merge and this sort runs). Feed strings and
    // assert: no throw, coerced to real Dates, newest-first order.
    mockDb.select
      .mockReturnValueOnce(
        selectChain([
          {
            flowId: "auto-1",
            flowName: "Onboard",
            runCount: 1,
            completedCount: 1,
            failedCount: 0,
            hasRunning: false,
            latestStartedAt: "2026-01-02T00:00:00.000Z", // STRING, older
            latestRunId: "run-a",
            latestStatus: "completed",
          },
        ])
      )
      .mockReturnValueOnce(
        selectChain([
          {
            flowId: "pb-1",
            flowName: "Digest",
            runCount: 1,
            completedCount: 1,
            failedCount: 0,
            hasRunning: false,
            latestStartedAt: "2026-03-05T00:00:00.000Z", // STRING, newer
            latestRunId: "run-b",
            latestStatus: "completed",
          },
        ])
      );

    const groups = await listRunGroups({ userId: USER });

    // Newest-first: the playbook group (03-05) sorts before the automation (01-02).
    expect(groups.map((g) => g.flowId)).toEqual(["pb-1", "auto-1"]);
    // Coerced to a real Date so every downstream Date consumer is honored.
    expect(groups[0]!.latestStartedAt).toBeInstanceOf(Date);
  });
});
