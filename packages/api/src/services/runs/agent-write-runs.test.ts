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
    // LENS **or** OWNERSHIP. "What did MY agents execute?" is an ownership
    // question, so the lens is one BRANCH of an `or`, never the whole floor —
    // a receipt in an unjoinable workspace is still the caller's own run. The
    // lens branch must still be present: widening must not replace the floor.
    const floor = where.and.find(
      (c): c is { or: unknown[] } =>
        typeof c === "object" &&
        c !== null &&
        Array.isArray((c as { or?: unknown }).or) &&
        (c as { or: unknown[] }).or.some(
          (b) => JSON.stringify(b) === JSON.stringify({ __userVisible: USER })
        )
    );
    expect(floor).toBeDefined();
    // …and the other branch is the authorship predicate, not a second lens.
    expect(floor!.or.length).toBe(2);

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

  it("synthesises a REFUSED write from its event — the cap floor leaves no receipt", async () => {
    // Past the daily cap the write neither executes nor proposes, so there is
    // NO receipt row: the `agent_write` ai_decision event is the ONLY trace. A
    // capped agent and a dead agent were byte-identical from the UI before this.
    // Under a `blocked_by_policy` filter the RECEIPT half short-circuits before
    // its query (it can only ever produce "completed"), so the refusal events
    // read is the one and only round trip.
    mockDb.select.mockReturnValueOnce(
      selectChain([
        {
          id: "evt-capped-1",
          correlationId: "corr-capped-1",
          timestamp: new Date("2026-08-03T11:00:00Z"),
          data: {
            kind: "agent_write",
            outcome: "refused",
            refusalReason: "capped",
            subjectType: "entity",
            writeAction: "create",
            agentUserId: AGENT,
            workspaceId: "ws-1",
            reason: "Daily agent proposal limit reached (10/day).",
          },
        },
      ])
    );

    const runs = await listRuns({
      userId: USER,
      flowType: "agent_write",
      status: "blocked_by_policy",
    });

    // One query, not two — the receipt half never ran.
    expect(mockDb.select).toHaveBeenCalledTimes(1);

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: "corr-capped-1",
      flowType: "agent_write",
      flowName: "entity.create",
      // A governance OUTCOME, not a transport failure.
      status: "blocked_by_policy",
      triggeredBy: AGENT,
      workspaceId: "ws-1",
    });
    expect(runs[0]?.summary).toContain("capped");
    expect(runs[0]?.summary).toContain("Daily agent proposal limit");
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
