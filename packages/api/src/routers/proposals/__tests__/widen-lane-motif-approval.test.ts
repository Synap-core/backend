/**
 * Per-motif widening (founder D8, F5) — the approval half and the seam to rung 2.8.
 *
 * The lane scanner files a `governance.widen_lane` whose payload names ONE motif
 * (`buildMotifWidenProposalData`, packages/jobs). This drives that payload
 * through the REAL `applyProposalApproval`, takes the row it INSERTED (nothing
 * hand-built between them), and hands it to the REAL
 * `resolveAgentGovernanceDecision` (rung-2.8 resolver + pure engine) as the
 * candidate the SQL would return:
 *   - the stored rule carries its lineage (`source_proposal_id`) and is scoped
 *     to that agent × pod × exact motif key;
 *   - it decides that motif at rung 2.8 (execute, naming the rule);
 *   - it decides nothing for any other motif;
 *   - an `auto` rule on a floored key (delete) still proposes: rung order.
 *
 * Harness mirrors widen-lane-floored-key.test.ts. The payload is a literal
 * mirror of the jobs builder (api cannot import @synap/jobs src in a unit test
 * without its dist); the jobs suite pins the builder's output to this shape.
 * NOT covered: the SQL principal/scope filter (no live PG).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

let insertReturning: Array<Array<{ id: string }>> = [];
const inserts: Array<Record<string, unknown>> = [];
const updates: Array<Record<string, unknown>> = [];

function statementResult(rows: Array<{ id: string }>) {
  const p = Promise.resolve(rows) as Promise<Array<{ id: string }>> & {
    returning: () => Promise<Array<{ id: string }>>;
  };
  p.returning = async () => rows;
  return p;
}

const dbStub = {
  query: { proposals: { findFirst: async () => undefined } },
  insert: (_table: unknown) => ({
    values: (values: Record<string, unknown>) => {
      inserts.push(values);
      return statementResult(insertReturning.shift() ?? []);
    },
  }),
  update: (_table: unknown) => ({
    set: (values: Record<string, unknown>) => {
      updates.push(values);
      const result = statementResult([]);
      return { where: () => result };
    },
  }),
};

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  db: dbStub,
}));
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
vi.mock("../../../trpc.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertPodAdmin: async () => {},
}));

const { applyProposalApproval } = await import("../apply-approval.js");

type ApplyArgs = Parameters<typeof applyProposalApproval>[0];

const { resolveAgentGovernanceDecision } = await import("@synap/database");

const AGENT = "agent-cc";
const PROPOSAL_ID = "prop-motif-1";

/** Mirror of `buildMotifWidenProposalData(AGENT, …)` for the hand-off motif. */
const motifWiden: ApplyArgs = {
  proposal: {
    id: PROPOSAL_ID,
    targetType: "governance",
    targetId: AGENT,
    proposalType: "governance.widen_lane",
    workspaceId: null,
    sessionId: null,
    projectId: null,
    agentUserId: null,
    sourceMessageId: null,
    correlationId: null,
    data: {
      agentUserId: AGENT,
      targetKind: "action",
      targetPattern: "focus_session.assign_agent",
      scopeKind: "pod",
      verdict: "auto",
      evidence: {
        total: 40,
        approveRate: 1,
        duplicateRate: 0,
        basis: "motif",
        motif: { targetType: "focus_session", proposalType: "assign_agent" },
      },
    },
  } as unknown as ApplyArgs["proposal"],
  userId: "human-approver",
  input: { proposalId: PROPOSAL_ID },
  ctx: {} as ApplyArgs["ctx"],
};

/** Same queue-of-results fake the database resolver tests use. */
function makeDb(resultsQueue: unknown[][]): any {
  return {
    select: () => ({
      from: () => ({
        where: () => {
          const rows = resultsQueue.shift() ?? [];
          return {
            limit: async () => rows,
            then: (resolve: (rows: unknown[]) => void) => resolve(rows),
          };
        },
      }),
    }),
  };
}

async function decide(
  subjectType: string,
  action: string,
  candidates: unknown[]
) {
  return resolveAgentGovernanceDecision({
    db: makeDb([
      [{ userType: "agent", agentMetadata: {} }],
      [{ settings: {}, workspaceType: "personal" }],
      candidates,
    ]),
    agentUserId: AGENT,
    workspaceId: "ws-1",
    subjectType,
    action,
    preferAgentMetadataAutoApproveFor: true,
  });
}

beforeEach(() => {
  insertReturning = [];
  inserts.length = 0;
  updates.length = 0;
});

describe("governance.widen_lane — a per-motif widen", () => {
  it("approval stores ONE rule for that motif, with its lineage", async () => {
    insertReturning = [[{ id: "rule-motif" }]];
    const result = await applyProposalApproval(motifWiden);

    expect(result.success).toBe(true);
    expect(inserts).toEqual([
      {
        principalKind: "agent",
        agentUserId: AGENT,
        scopeKind: "pod",
        workspaceId: null,
        targetKind: "action",
        targetPattern: "focus_session.assign_agent",
        targetProfile: null,
        verdict: "auto",
        sourceProposalId: PROPOSAL_ID,
        createdBy: "human-approver",
      },
    ]);
    expect(updates[0]).toMatchObject({ status: "approved" });
  });

  it("the stored rule decides that motif at rung 2.8 — and no other", async () => {
    insertReturning = [[{ id: "rule-motif" }]];
    await applyProposalApproval(motifWiden);
    // The row the approval inserted, as the resolver's SELECT returns it.
    const stored = { ...inserts[0], id: "rule-motif", createdAt: new Date() };

    // Without the rule a hand-off proposes; with it, rung 2.8 executes it.
    expect((await decide("focus_session", "assign_agent", [])).decision).toBe(
      "propose"
    );
    expect(await decide("focus_session", "assign_agent", [stored])).toEqual({
      decision: "execute",
      governanceRuleId: "rule-motif",
    });

    // Other motifs: the rule is in the candidate set yet changes nothing.
    for (const [subjectType, action] of [
      ["track", "assign_agent"],
      ["skill", "update"],
      ["focus_session", "delete"],
    ] as const) {
      const without = await decide(subjectType, action, []);
      const withRule = await decide(subjectType, action, [stored]);
      expect(withRule).toEqual(without);
      expect(withRule).not.toMatchObject({ governanceRuleId: "rule-motif" });
    }
  });

  it("an auto rule on a floored motif (delete) still proposes — floors sit above 2.8", async () => {
    const deleteRule = {
      id: "rule-delete",
      principalKind: "agent",
      scopeKind: "pod",
      targetKind: "action",
      targetPattern: "entity.delete",
      targetProfile: null,
      verdict: "auto",
      createdAt: new Date(),
    };
    const decided = await decide("entity", "delete", [deleteRule]);
    expect(decided).toMatchObject({
      decision: "propose",
      reasonCode: "DESTRUCTIVE_HARD_FLOOR",
    });
  });
});
