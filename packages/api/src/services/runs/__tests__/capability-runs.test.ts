import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Workstream 1 (capability-run observability contract) — regression lock for
 * the "capability" flow. `listCapabilityRuns`/`getRun` synthesise a capability
 * run from TWO sources, unioned + deduped by correlationId:
 *   (1) a `capability.run` PROPOSAL (the propose→approve path — the executor
 *       stamps a correlationId + stores `data.runResult` on approval), and
 *   (2) a `capability_run` ai_decision EVENT (the DIRECT-run path —
 *       owner-bypass / read-only builtin / governance-auto-granted agent — which
 *       executeCapability now emits, with NO proposal).
 *
 * This proves:
 *   (a) an APPROVED `capability.run` proposal maps to a completed run carrying
 *       its stamped correlationId;
 *   (b) `getRun({flowType:"capability"})` joins `events` on that correlationId —
 *       the SAME join the "capture" branch uses;
 *   (c) a DIRECT run (event, no proposal) is itself resolvable by correlationId
 *       via getRun, and surfaces its event-carried runResult.
 *
 * DB is mocked (no live Postgres here — mirrors index.test.ts's documented
 * no-DB style for this suite). Each `db.select()` call is fed in order via
 * `mockReturnValueOnce`; the per-query builder shape (resolves at `.limit()` vs
 * at `.where()`) matches the query it stands in for.
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
const DIRECT_CORRELATION_ID = "corr-direct-999";

describe("listCapabilityRuns (via listRuns) — the capability-run ledger synthesiser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserVisibleWhere.mockReturnValue({ __userVisible: USER });
  });

  it("maps an APPROVED capability.run proposal to a completed run, carrying its stamped correlationId", async () => {
    mockDb.select
      // (1) listCapabilityRuns' proposals read.
      .mockReturnValueOnce(
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
      )
      // (2) the DIRECT-run events read — empty here (this run is proposal-backed).
      .mockReturnValueOnce(selectChain([]));

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
    mockDb.select
      .mockReturnValueOnce(
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
      )
      .mockReturnValueOnce(selectChain([]));

    const runs = await listRuns({ userId: USER, flowType: "capability" });

    expect(runs[0]?.status).toBe("proposed");
    expect(runs[0]?.correlationId).toBeNull();
  });

  it("synthesises a DIRECT run from a capability_run event (no proposal), keyed by its correlationId", async () => {
    mockDb.select
      // (1) proposals read — empty (a direct run has NO proposal).
      .mockReturnValueOnce(selectChain([]))
      // (2) the capability_run events read — the direct run's only trace.
      .mockReturnValueOnce(
        selectChain([
          {
            id: "evt-direct-1",
            correlationId: DIRECT_CORRELATION_ID,
            timestamp: new Date("2026-01-02T00:00:00Z"),
            data: {
              kind: "capability_run",
              skillId: "skill-9",
              verbId: "gmail.search",
              workspaceId: "ws-1",
              runResult: { messages: 3 },
            },
          },
        ])
      );

    const runs = await listRuns({ userId: USER, flowType: "capability" });

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      // A direct run's identity IS its correlationId (no proposal row id).
      id: DIRECT_CORRELATION_ID,
      flowType: "capability",
      flowName: "gmail.search",
      status: "completed",
      correlationId: DIRECT_CORRELATION_ID,
      workspaceId: "ws-1",
    });
    expect(runs[0]?.summary).toContain("messages");
  });

  it("dedupes a proposal-backed run against its own event by correlationId (proposal wins, appears once)", async () => {
    mockDb.select
      .mockReturnValueOnce(
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
      )
      // The approve-executor ALSO emits a capability_run event with the SAME
      // correlationId — it must NOT produce a second run row.
      .mockReturnValueOnce(
        selectChain([
          {
            id: "evt-dup",
            correlationId: CORRELATION_ID,
            timestamp: new Date("2026-01-01T00:00:30Z"),
            data: { kind: "capability_run", skillId: "skill-1" },
          },
        ])
      );

    const runs = await listRuns({ userId: USER, flowType: "capability" });

    expect(runs).toHaveLength(1);
    // Proposal-backed wins → the row id is the proposal id, not the event's.
    expect(runs[0]?.id).toBe(PROPOSAL_ID);
  });
});

describe("getRun({flowType:'capability'}) — correlationId-keyed timeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserVisibleWhere.mockReturnValue({ __userVisible: USER });
  });

  it("joins events on a proposal-backed run's correlationId, exactly like the capture branch", async () => {
    mockDb.select
      // (1) listCapabilityRuns' proposals read.
      .mockReturnValueOnce(
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
      )
      // (2) listCapabilityRuns' direct-run events read — empty.
      .mockReturnValueOnce(selectChain([]))
      // (3) getRun's proposalRow-by-id read (carries the stored runResult).
      .mockReturnValueOnce(selectChain([{ data: { runResult: { ok: true } } }]))
      // (4) getRun's events join, keyed by correlationId.
      .mockReturnValueOnce(
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
    expect(detail?.outputSummary).toMatchObject({ ok: true });
    expect(detail?.activity).toHaveLength(1);
    expect(detail?.activity[0]).toMatchObject({
      id: "evt-1",
      kind: "capability_run",
      label: "capability_run",
    });
  });

  it("resolves a DIRECT run by its correlationId and surfaces the event-carried runResult", async () => {
    const eventRow = {
      id: "evt-direct-1",
      correlationId: DIRECT_CORRELATION_ID,
      timestamp: new Date("2026-01-02T00:00:00Z"),
      data: {
        kind: "capability_run",
        skillId: "skill-9",
        verbId: "gmail.search",
        workspaceId: "ws-1",
        runResult: { messages: 3 },
      },
    };
    mockDb.select
      // (1) proposals read — empty (direct run, no proposal).
      .mockReturnValueOnce(selectChain([]))
      // (2) direct-run events read — the run's only source.
      .mockReturnValueOnce(selectChain([eventRow]))
      // (3) getRun's proposalRow-by-id read — empty (id is a correlationId).
      .mockReturnValueOnce(selectChain([]))
      // (4) getRun's events join, keyed by correlationId — the same event, in
      //     the join's `{ at, subjectType, action, data }` projection.
      .mockReturnValueOnce(
        selectChainNoLimit([
          {
            id: "evt-direct-1",
            at: new Date("2026-01-02T00:00:00Z"),
            subjectType: "ai_decision",
            action: "capability_run",
            data: {
              kind: "capability_run",
              skillId: "skill-9",
              runResult: { messages: 3 },
            },
          },
        ])
      );

    const detail = await getRun({
      userId: USER,
      flowType: "capability",
      id: DIRECT_CORRELATION_ID,
    });

    expect(detail).not.toBeNull();
    expect(detail?.run.correlationId).toBe(DIRECT_CORRELATION_ID);
    expect(detail?.run.id).toBe(DIRECT_CORRELATION_ID);
    // The runResult rides on the event (no proposal carried it) — getRun's
    // direct-run fallback pulls it into outputSummary.
    expect(detail?.outputSummary).toMatchObject({ messages: 3 });
    expect(detail?.activity).toHaveLength(1);
    expect(detail?.activity[0]).toMatchObject({
      id: "evt-direct-1",
      kind: "capability_run",
    });
  });
});
