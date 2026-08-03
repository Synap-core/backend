import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `agent_write` — the unified feed's catch-all for a plain agent write.
 *
 * A CLI `synap capture` / MCP `create_entity` that auto-approves leaves an
 * AUTO_APPROVED proposal receipt and belongs to no automation, playbook, chat
 * turn or capability run. Before this flow type existed it matched NO ledger
 * query and was invisible in `listRuns` — the "you did something on the pod, I
 * got no way to see it" gap.
 *
 * DB is mocked (mirrors ./index.test.ts): the assertions are on the COMPOSED
 * query — that the agent floor + user floor actually land in the `.where(and(…))`
 * tree — and on the pure row→UnifiedRun mapping.
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
    or: vi.fn((...conditions: unknown[]) => ({
      or: conditions.filter((c) => c !== undefined),
    })),
    isNull: vi.fn((column: unknown) => ({ isNull: column })),
    gt: vi.fn((column: unknown, value: unknown) => ({ gt: [column, value] })),
    lt: vi.fn((column: unknown, value: unknown) => ({ lt: [column, value] })),
    asc: vi.fn((column: unknown) => ({ asc: column })),
    desc: vi.fn((column: unknown) => ({ desc: column })),
    drizzleSql: Object.assign(
      vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
        sql: strings.join("?"),
        values,
      })),
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

import { listRuns } from "./index.js";

const USER = "user-1";
const AGENT = "agent-7";

/** Chainable select() builder resolving at `.limit()`. */
function selectChain(rows: unknown[]) {
  const captured: { where?: unknown } = {};
  const chain = {
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn().mockResolvedValue(rows),
    _captured: captured,
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockImplementation((w: unknown) => {
    captured.where = w;
    return chain;
  });
  chain.orderBy.mockReturnValue(chain);
  return chain;
}

const RECEIPT_ROW = {
  id: "prop-1",
  correlationId: "corr-1",
  proposalType: "entity.create",
  targetType: "entity",
  agentUserId: AGENT,
  createdAt: new Date("2026-08-03T10:00:00Z"),
  workspaceId: "ws-1",
  projectId: null,
  data: { reasoning: "User asked me to remember this" },
};

describe("runs.listRuns — agent_write flow type", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserVisibleWhere.mockReturnValue({ __userVisible: USER });
  });

  it("maps an auto-approved agent receipt to a UnifiedRun keyed by correlationId", async () => {
    mockDb.select.mockReturnValue(selectChain([RECEIPT_ROW]));

    const runs = await listRuns({ userId: USER, flowType: "agent_write" });

    expect(runs).toEqual([
      expect.objectContaining({
        // Identity is the correlationId (mirrors capture), NOT the proposal row id.
        id: "corr-1",
        flowType: "agent_write",
        flowId: null,
        flowName: "entity.create",
        status: "completed",
        correlationId: "corr-1",
        workspaceId: "ws-1",
        // The AGENT is what did this — the whole point of the flow type.
        triggeredBy: AGENT,
        // A volunteered rationale beats the bare action label.
        summary: "User asked me to remember this",
      }),
    ]);
  });

  it("falls back to the proposal row id and the action label when correlationId / reasoning are absent", async () => {
    mockDb.select.mockReturnValue(
      selectChain([{ ...RECEIPT_ROW, correlationId: null, data: {} }])
    );

    const runs = await listRuns({ userId: USER, flowType: "agent_write" });

    expect(runs[0]).toMatchObject({
      id: "prop-1",
      correlationId: null,
      summary: "entity.create",
    });
  });

  it("applies the user floor AND the agent floor in the composed WHERE", async () => {
    const chain = selectChain([RECEIPT_ROW]);
    mockDb.select.mockReturnValue(chain);

    await listRuns({ userId: USER, flowType: "agent_write" });

    // userVisibleWhere(proposals.workspaceId, userId) — same column + user every
    // other ledger floors on. Not silently dropped from the WHERE tree.
    expect(mockUserVisibleWhere).toHaveBeenCalledTimes(1);
    const [column, userId] = mockUserVisibleWhere.mock.calls[0]!;
    expect(userId).toBe(USER);
    expect(column).toMatchObject({ name: "workspace_id" });

    const where = chain._captured.where as { and: unknown[] };
    expect(where.and).toContainEqual({ __userVisible: USER });

    // Only AUTO_APPROVED receipts — a pending proposal is a queue item, not a
    // record of something that happened.
    expect(where.and).toContainEqual(
      expect.objectContaining({
        eq: [expect.objectContaining({ name: "status" }), "auto_approved"],
      })
    );

    // stepRunId IS NULL — an automation step's write already renders inside its
    // automation run's timeline; without this it would be double-counted.
    expect(where.and).toContainEqual(
      expect.objectContaining({
        isNull: expect.objectContaining({ name: "step_run_id" }),
      })
    );
  });

  it("contributes nothing when the caller filters a status this ledger cannot produce", async () => {
    mockDb.select.mockReturnValue(selectChain([RECEIPT_ROW]));

    const runs = await listRuns({
      userId: USER,
      flowType: "agent_write",
      status: "failed",
    });

    expect(runs).toEqual([]);
    // Short-circuited BEFORE the query — no wasted round trip.
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("contributes nothing under an entity-focus scope (a write receipt has no entity subject)", async () => {
    mockDb.select.mockReturnValue(selectChain([RECEIPT_ROW]));

    const runs = await listRuns({
      userId: USER,
      flowType: "agent_write",
      scope: { subjectEntityId: "ent-1" },
    });

    expect(runs).toEqual([]);
    expect(mockDb.select).not.toHaveBeenCalled();
  });
});
