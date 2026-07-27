import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Workstream 1 (capability-run observability contract) — regression lock for
 * the "capability" flow the `capability.run` executor now stamps a
 * correlationId onto. Before this wave, an approved `capability.run` proposal
 * had NO ledger row: `listRuns`/`getRun` had no "capability" FlowType branch,
 * so the run was executed but unobservable (confirmed by the read-only
 * dossier). This proves:
 *   (a) `listCapabilityRuns` (via `listRuns({flowType:"capability"})`) reads
 *       `capability.run` proposals, maps ProposalStatus → RunStatus, and
 *       surfaces the stamped correlationId.
 *   (b) `getRun({flowType:"capability"})` joins `events` on that
 *       correlationId — the SAME join `getRun`'s "capture" branch uses.
 *
 * DB is mocked (no live Postgres here — mirrors index.test.ts /
 * batch-approve-registry.test.ts's documented no-DB style for this suite).
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
    inArray: vi.fn((column: unknown, values: unknown[]) => ({
      inArray: [column, values],
    })),
    drizzleSql: Object.assign(
      vi.fn((strings: TemplateStringsArray) => ({ sql: strings.join("?") })),
      { raw: vi.fn() }
    ),
  };
});

vi.mock("../../../utils/user-visible-where.js", () => ({
  userVisibleWhere: mockUserVisibleWhere,
  workspaceLensWhere: vi.fn(() => ({ workspaceLens: true })),
  ownerPrivateVisibleWhere: vi.fn(() => ({ ownerPrivate: true })),
}));

vi.mock("../../../utils/project-scope.js", () => ({
  accessScopeWhere: vi.fn(() => ({ accessScope: true })),
}));

import { ProposalStatus } from "@synap/database/schema";
import { listRuns, getRun } from "../index.js";

/** Chainable select() builder resolving to `rows` at `.limit()`. */
function selectChain(rows: unknown[]) {
  const chain = {
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return chain;
}

/**
 * Chainable select() builder for the `select().from().where()` shape (no
 * `.limit()`/`.orderBy()` — the events join `getRun`'s capture/capability
 * branch issues), resolving to `rows` when the `.where()` result is awaited.
 */
function selectChainNoLimit(rows: unknown[]) {
  const chain = {
    from: vi.fn(),
    where: vi.fn().mockResolvedValue(rows),
  };
  chain.from.mockReturnValue(chain);
  return chain;
}

const USER = "user-1";
const CORRELATION_ID = "corr-abc-123";
const PROPOSAL_ID = "proposal-1";

describe("listCapabilityRuns (via listRuns) — the capability.run ledger synthesiser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserVisibleWhere.mockReturnValue({ __userVisible: USER });
  });

  it("maps an APPROVED capability.run proposal to a completed run, carrying its stamped correlationId", async () => {
    mockDb.select.mockReturnValueOnce(
      selectChain([
        {
          id: PROPOSAL_ID,
          correlationId: CORRELATION_ID,
          status: ProposalStatus.APPROVED,
          createdAt: new Date("2026-01-01T00:00:00Z"),
          reviewedAt: new Date("2026-01-01T00:01:00Z"),
          workspaceId: "ws-1",
          projectId: null,
          data: { skillId: "skill-1", verbId: "gmail.send" },
        },
      ])
    );

    const runs = await listRuns({ userId: USER, flowType: "capability" });

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: PROPOSAL_ID,
      flowType: "capability",
      flowId: null,
      flowName: "gmail.send",
      status: "completed",
      correlationId: CORRELATION_ID,
      channelId: null,
    });
  });

  it("maps a PENDING capability.run proposal to a proposed run (not yet approved, no correlationId yet)", async () => {
    mockDb.select.mockReturnValueOnce(
      selectChain([
        {
          id: PROPOSAL_ID,
          correlationId: null,
          status: ProposalStatus.PENDING,
          createdAt: new Date("2026-01-01T00:00:00Z"),
          reviewedAt: null,
          workspaceId: "ws-1",
          projectId: null,
          data: { skillId: "skill-1" },
        },
      ])
    );

    const runs = await listRuns({ userId: USER, flowType: "capability" });

    expect(runs[0]?.status).toBe("proposed");
    expect(runs[0]?.correlationId).toBeNull();
  });
});

describe("getRun({flowType:'capability'}) — correlationId-keyed timeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserVisibleWhere.mockReturnValue({ __userVisible: USER });
  });

  it("joins events on the run's correlationId, exactly like the capture branch", async () => {
    // 1st select(): listCapabilityRuns' proposals read.
    mockDb.select.mockReturnValueOnce(
      selectChain([
        {
          id: PROPOSAL_ID,
          correlationId: CORRELATION_ID,
          status: ProposalStatus.APPROVED,
          createdAt: new Date("2026-01-01T00:00:00Z"),
          reviewedAt: new Date("2026-01-01T00:01:00Z"),
          workspaceId: "ws-1",
          projectId: null,
          data: { verbId: "gmail.send" },
        },
      ])
    );
    // 2nd select(): the events join, keyed by correlationId.
    mockDb.select.mockReturnValueOnce(
      selectChainNoLimit([
        {
          id: "evt-1",
          at: new Date("2026-01-01T00:00:30Z"),
          subjectType: "ai_decision",
          action: "capability_run",
          data: { kind: "capability_run", skillId: "skill-1" },
        },
      ])
    );

    const detail = await getRun({
      userId: USER,
      flowType: "capability",
      id: PROPOSAL_ID,
    });

    expect(detail?.run.correlationId).toBe(CORRELATION_ID);
    expect(detail?.activity).toHaveLength(1);
    expect(detail?.activity[0]).toMatchObject({
      id: "evt-1",
      kind: "capability_run",
      label: "capability_run",
    });
  });
});
