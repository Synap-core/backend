/**
 * The HUMAN-approval half stamps a session slot with the entity's PROFILE.
 *
 * `satisfyExpectedOutputs` needs `entityProfileSlug`: `targetType` can only say
 * "entity", while a slot is declared `kind: "knowledge"` / `"task"`. The
 * auto-approve half (`permission-check.ts`) already forwards it; until this
 * change `apply-approval.ts` did not, so a knowledge slot satisfied by a
 * PROPOSED capture stayed pending forever.
 *
 * SEAM: the real `applyProposalApproval` → the real
 * `readProposalEntityProfileSlug` → the door, with ONLY `satisfyExpectedOutputs`
 * spied (partial mock, importOriginal + spread). The proposal type is
 * `governance.advisory` purely because that branch succeeds with no executor in
 * this harness; the stamp runs after ANY successful approval, so the wiring
 * under test is type-agnostic. Harness copied verbatim from
 * `approval-no-effect-receipt.test.ts`.
 *
 * DOES NOT COVER: entity/update (its payload carries no profileSlug — the
 * executor resolves `targetEntity.profileId`; left undefined by design) and
 * the auto-approve half (covered in permission-check tests).
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
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
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

/** Every call the approval made into the stamp door. */
const stampCalls: Array<Record<string, unknown>> = [];
// PARTIAL mock — the reader stays REAL so the test crosses the whole seam.
vi.mock(
  "../../../services/focus-sessions/satisfy-expected-output.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    satisfyExpectedOutputs: async (args: Record<string, unknown>) => {
      stampCalls.push(args);
      return { satisfied: [] };
    },
  })
);

const { applyProposalApproval } = await import("../apply-approval.js");
const { readProposalEntityProfileSlug } =
  await import("../../../services/focus-sessions/satisfy-expected-output.js");

type ApplyArgs = Parameters<typeof applyProposalApproval>[0];

function sessionApproval(data: Record<string, unknown>): ApplyArgs {
  return {
    proposal: {
      id: "prop-1",
      targetType: "governance",
      targetId: "target-1",
      proposalType: "governance.advisory",
      workspaceId: null,
      sessionId: "session-1",
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

const ADVISORY = { agentUserId: "agent-1", targetPattern: "entity/create" };

beforeEach(() => {
  insertReturning = [];
  updateReturning = [];
  inserts.length = 0;
  updates.length = 0;
  podAdminChecks.length = 0;
  guidelineRow = { id: "guideline-1" };
  stampCalls.length = 0;
});

describe("human approval stamps the session slot with the entity PROFILE", () => {
  it("reads the CANONICAL nested envelope (`data.data.profileSlug`)", async () => {
    const result = await applyProposalApproval(
      sessionApproval({ ...ADVISORY, data: { profileSlug: "knowledge" } })
    );
    expect(result.success).toBe(true);
    expect(stampCalls).toHaveLength(1);
    expect(stampCalls[0]).toMatchObject({
      sessionId: "session-1",
      proposalId: "prop-1",
      entityProfileSlug: "knowledge",
    });
  });

  it("falls back to the LEGACY flat envelope (`data.profileSlug`)", async () => {
    await applyProposalApproval(
      sessionApproval({ ...ADVISORY, profileSlug: "task" })
    );
    expect(stampCalls[0]).toMatchObject({ entityProfileSlug: "task" });
  });

  it("forwards undefined when the payload names no profile (composite shape)", async () => {
    await applyProposalApproval(
      sessionApproval({ ...ADVISORY, operations: [] })
    );
    expect(stampCalls).toHaveLength(1);
    expect(stampCalls[0].entityProfileSlug).toBeUndefined();
  });

  it("still forwards the slot claim unchanged", async () => {
    await applyProposalApproval(
      sessionApproval({
        ...ADVISORY,
        expectedLabel: "Lesson",
        data: { profileSlug: "knowledge" },
      })
    );
    expect(stampCalls[0]).toMatchObject({
      expectedLabel: "Lesson",
      entityProfileSlug: "knowledge",
    });
  });
});

describe("readProposalEntityProfileSlug — the ONE reader", () => {
  it("prefers the nested envelope over a flat key", () => {
    expect(
      readProposalEntityProfileSlug({
        profileSlug: "flat",
        data: { profileSlug: "nested" },
      })
    ).toBe("nested");
  });

  it("refuses non-strings and blanks at either level", () => {
    expect(
      readProposalEntityProfileSlug({ data: { profileSlug: 42 } })
    ).toBeUndefined();
    expect(
      readProposalEntityProfileSlug({ profileSlug: "  " })
    ).toBeUndefined();
    expect(readProposalEntityProfileSlug(null)).toBeUndefined();
    expect(readProposalEntityProfileSlug("knowledge")).toBeUndefined();
  });
});
