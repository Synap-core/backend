/**
 * AN APPROVAL THAT WRITES NOTHING MUST NOT REPORT `applied`.
 *
 * THE DEFECT this pins: every inline branch of `applyProposalApproval` returned
 * a bare `{ success: true }` — a value authored by the SAME optimistic code path
 * that decided to return it. `governance.advisory` writes no row at all (by
 * design), and `governance.widen_lane` writes exactly one; both read GREEN and
 * IDENTICAL to the reviewer.
 *
 * The fix is the `ProposalEffect` receipt (execution-registry.ts) sourced from
 * the STORAGE ENGINE — `.returning()` rows, never a service-layer boolean —
 * plus the `no_effect` transport state on `CreateWriteReceipt`, related to it by
 * the ONE mapping `receiptStateForEffect`.
 *
 * Executable, no live Postgres (the api suite has none): the db stub RECORDS
 * the statements and hands back the rows a real driver's RETURNING would, so a
 * branch that stopped writing would report `rows: 0` here instead of passing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── mutable fixture state the db stub reads/records ────────────────────────
/** Rows the next INSERT ... RETURNING hands back (one entry per insert). */
let insertReturning: Array<Array<{ id: string }>> = [];
/** Rows the next UPDATE ... RETURNING hands back (one entry per update). */
let updateReturning: Array<Array<{ id: string }>> = [];
const inserts: Array<{ table: unknown; values: Record<string, unknown> }> = [];
const updates: Array<Record<string, unknown>> = [];

function nextInsertRows(): Array<{ id: string }> {
  return insertReturning.shift() ?? [];
}
function nextUpdateRows(): Array<{ id: string }> {
  return updateReturning.shift() ?? [];
}

/** A driver-shaped result: awaitable AND `.returning()`-able, same rows. */
function statementResult(rows: Array<{ id: string }>) {
  const p = Promise.resolve(rows) as Promise<Array<{ id: string }>> & {
    returning: () => Promise<Array<{ id: string }>>;
  };
  p.returning = async () => rows;
  return p;
}

const dbStub = {
  query: { proposals: { findFirst: async () => undefined } },
  insert: (table: unknown) => ({
    values: (values: Record<string, unknown>) => {
      inserts.push({ table, values });
      return statementResult(nextInsertRows());
    },
  }),
  update: (_table: unknown) => ({
    set: (values: Record<string, unknown>) => {
      updates.push(values);
      const result = statementResult(nextUpdateRows());
      return { where: () => result };
    },
  }),
};

// PARTIAL mocks. `@synap/database` and its `/schema` entry are imported by a
// long transitive chain (hub-protocol → channels → …); replacing either
// wholesale silently kills unrelated imports (the "total vi.mock" trap). Only
// the DB HANDLE and the one guideline write door are swapped — every table,
// enum and helper stays real, so a renamed column would still break here.
vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  db: dbStub,
  createGuideline: async () => guidelineRow,
}));

/** What the mocked `createGuideline` (the ONE guideline write door) returns. */
let guidelineRow: { id: string } | undefined;

// Heavy siblings that the two branches under test never reach.
vi.mock("../approve-executors.js", () => ({
  registerApproveExecutors: () => {},
}));
vi.mock("../graph-dispositions.js", () => ({
  applyGraphDispositions: () => ({}),
  survivingEntityDecisionSlices: () => ({}),
  survivingEntityFacetSlices: () => ({}),
  foldFacetsIntoOps: (ops: unknown) => ops,
}));
vi.mock("../../entities.js", () => ({ entitiesRouter: {} }));
vi.mock("../../relations.js", () => ({ relationsRouter: {} }));
vi.mock("../../../utils/materialize-composite.js", () => ({
  materializeCompositeGraph: async () => ({}),
}));
vi.mock("../../../services/proposals/reconcile-proposal-properties.js", () => ({
  reconcileApprovedProperties: async (a: unknown) => a,
}));
vi.mock("../../../services/proposals/complete-knowledge-proposal.js", () => ({
  completeKnowledgeProposalProperties: async (p: unknown) => p,
}));
vi.mock("../../../lib/ai-events.js", () => ({
  AI_KIND: { EXTRACT: "extract" },
}));
vi.mock("../../../utils/ai-feedback-events.js", () => ({
  emitAiCorrection: async () => {},
}));
vi.mock("../../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => {},
}));
vi.mock("../../../realtime/socket-events.js", () => ({
  SERVER_CONVERSATION_EVENTS: {},
}));
vi.mock("../../../utils/intelligence-routing.js", () => ({
  getDefaultActiveService: async () => null,
}));
vi.mock("@synap/events", () => ({
  emitSideEffects: () => {},
  getBoss: () => ({ send: async () => {} }),
}));
// The pod-admin floor for every `governance.*` proposal — kept as a REAL gate
// in production; stubbed to "passes" here so the branches under test run.
const podAdminChecks: string[] = [];
// PARTIAL mock — `trpc.js` is a real module the hub-protocol chain also imports
// (publicProcedure &c). Replacing it wholesale would kill those imports; only
// the floor is swapped.
vi.mock("../../../trpc.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertPodAdmin: async (userId: string) => {
    podAdminChecks.push(userId);
  },
}));

const { applyProposalApproval } = await import("../apply-approval.js");
const { receiptStateForEffect, buildCreateWriteReceipt } =
  await import("../../hub-protocol/write-receipt.js");

type ApplyArgs = Parameters<typeof applyProposalApproval>[0];

function approveArgs(
  proposalType: string,
  data: Record<string, unknown>
): ApplyArgs {
  return {
    proposal: {
      id: "prop-1",
      targetType: "governance",
      targetId: "target-1",
      proposalType,
      workspaceId: null,
      sessionId: null,
      projectId: null,
      agentUserId: "agent-1",
      sourceMessageId: null,
      correlationId: null,
      data,
    } as unknown as ApplyArgs["proposal"],
    userId: "human-approver",
    input: { proposalId: "prop-1" },
    ctx: {} as ApplyArgs["ctx"],
  };
}

beforeEach(() => {
  insertReturning = [];
  updateReturning = [];
  inserts.length = 0;
  updates.length = 0;
  podAdminChecks.length = 0;
  guidelineRow = { id: "guideline-1" };
});

// ───────────────────────────────────────────────────────────────────────────
// (a) AN APPROVAL THAT WRITES NOTHING → no_effect, with a reason.
// ───────────────────────────────────────────────────────────────────────────
describe("(a) an approval that writes nothing reports no_effect", () => {
  it("governance.advisory returns applied:'none' + a reason, and inserts NOTHING", async () => {
    const result = await applyProposalApproval(
      approveArgs("governance.advisory", {
        agentUserId: "agent-1",
        targetPattern: "entity/create",
      })
    );

    expect(result.success).toBe(true);
    expect(result.effect).toBeDefined();
    expect(result.effect!.applied).toBe("none");
    // An unexplained no-op is the defect itself — the reason is required.
    expect(
      (result.effect as { applied: "none"; reason: string }).reason
    ).toMatch(/acknowledgement-only/i);
    // Nothing but the proposal's own review bookkeeping was written.
    expect(inserts).toEqual([]);
    expect(updates[0]).toMatchObject({
      status: "approved",
      reviewedBy: "human-approver",
    });
    // The governance floor still ran — this change does not widen anything.
    expect(podAdminChecks).toEqual(["human-approver"]);
  });

  it("…and that effect maps to the transport state `no_effect`, never `applied`", () => {
    const receipt = buildCreateWriteReceipt({
      result: { status: "created", id: "e-1" },
      profileSlug: "person",
      effectiveWorkspaceId: null,
      effect: { applied: "none", reason: "acknowledgement-only" },
    });
    expect(receipt.state).toBe("no_effect");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (b) AN APPROVAL THAT WRITES → applied, with a NON-ZERO engine row count.
// ───────────────────────────────────────────────────────────────────────────
describe("(b) an approval that writes reports applied with a non-zero count", () => {
  it("governance.widen_lane returns applied:'verified' rows:1 + the engine's id", async () => {
    // The engine's RETURNING row for the governance_rules INSERT.
    insertReturning = [[{ id: "rule-1" }]];

    const result = await applyProposalApproval(
      approveArgs("governance.widen_lane", {
        agentUserId: "agent-1",
        targetKind: "action",
        targetPattern: "entity/create",
        scopeKind: "pod",
      })
    );

    expect(result.success).toBe(true);
    expect(result.effect).toEqual({
      applied: "verified",
      rows: 1,
      ids: ["rule-1"],
      subject: "governance_rules",
    });
    expect(inserts).toHaveLength(1);
    expect(inserts[0].values).toMatchObject({
      verdict: "auto",
      sourceProposalId: "prop-1",
    });
    expect(receiptStateForEffect(result.effect!)).toBe("applied");
  });

  it("the count comes from the STATEMENT: an insert that returns no row reports rows:0 → no_effect", async () => {
    // Same branch, same code path — only the ENGINE's answer differs. A count
    // computed by the optimistic path could not produce this.
    insertReturning = [[]];

    const result = await applyProposalApproval(
      approveArgs("governance.tighten_lane", {
        agentUserId: "agent-1",
        targetKind: "action",
        targetPattern: "entity/create",
        scopeKind: "pod",
      })
    );

    expect(result.effect).toMatchObject({ applied: "verified", rows: 0 });
    expect(receiptStateForEffect(result.effect!)).toBe("no_effect");
  });

  it("governance.raise_ceiling counts BOTH statements (supersede + insert)", async () => {
    updateReturning = [[{ id: "ceiling-old" }]]; // the supersede UPDATE
    insertReturning = [[{ id: "ceiling-new" }]]; // the new ceiling INSERT

    const result = await applyProposalApproval(
      approveArgs("governance.raise_ceiling", {
        agentUserId: "agent-1",
        proposedLimit: 200,
      })
    );

    expect(result.effect).toEqual({
      applied: "verified",
      rows: 2,
      ids: ["ceiling-new"],
      subject: "governance_ceilings",
    });
  });

  it("governance.tighten_posture sources its row from the ONE guideline door", async () => {
    const result = await applyProposalApproval(
      approveArgs("governance.tighten_posture", {
        channelId: "chan-1",
        clusterSize: 4,
        rejectRate: 0.8,
      })
    );

    expect(result.effect).toEqual({
      applied: "verified",
      rows: 1,
      ids: ["guideline-1"],
      subject: "config_settings(guideline)",
    });

    // …and when the door's INSERT ... RETURNING produced no row, the receipt
    // says so instead of claiming the guideline exists.
    guidelineRow = undefined;
    const empty = await applyProposalApproval(
      approveArgs("governance.tighten_posture", {
        channelId: "chan-1",
        clusterSize: 4,
        rejectRate: 0.8,
      })
    );
    expect(empty.effect).toMatchObject({ applied: "verified", rows: 0 });
    expect(receiptStateForEffect(empty.effect!)).toBe("no_effect");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (c) THE ONE MAPPING — effect vocabulary → transport state.
// ───────────────────────────────────────────────────────────────────────────
describe("(c) receiptStateForEffect is the single relation between the two halves", () => {
  it("deferred is `pending`, NOT applied — a handoff is not a write", () => {
    expect(
      receiptStateForEffect({ applied: "deferred", validatedEventId: "ev-1" })
    ).toBe("pending");
  });

  it("verified with rows > 0 is the ONLY route to `applied`", () => {
    expect(receiptStateForEffect({ applied: "verified", rows: 3 })).toBe(
      "applied"
    );
    expect(receiptStateForEffect({ applied: "verified", rows: 0 })).toBe(
      "no_effect"
    );
    expect(
      receiptStateForEffect({ applied: "none", reason: "acknowledged no-op" })
    ).toBe("no_effect");
  });

  it("a facet error still degrades a verified write to `partial`", () => {
    const receipt = buildCreateWriteReceipt({
      result: {
        status: "created",
        id: "e-1",
        facets: [{ slug: "client", outcome: "error", error: "boom" }],
      },
      profileSlug: "person",
      effectiveWorkspaceId: null,
      effect: { applied: "verified", rows: 1 },
    });
    expect(receipt.state).toBe("partial");
  });

  it("without an effect the legacy derivation is UNCHANGED", () => {
    expect(
      buildCreateWriteReceipt({
        result: { status: "created", id: "e-1" },
        profileSlug: "person",
        effectiveWorkspaceId: null,
      }).state
    ).toBe("applied");
    expect(
      buildCreateWriteReceipt({
        result: { status: "proposed", proposalId: "p-1" },
        profileSlug: "person",
        effectiveWorkspaceId: null,
      }).state
    ).toBe("pending");
  });
});
