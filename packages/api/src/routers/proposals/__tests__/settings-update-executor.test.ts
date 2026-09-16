/**
 * Approving a `settings.update` proposal APPLIES the store write — the B5
 * executor. Drives the REAL `applyProposalApproval` with a statement-recording
 * db stub (harness mirrors widen-lane-floored-key.test.ts), so each test proves
 * which store row was written, not just that the branch ran without throwing.
 *
 * Covers the two most load-bearing paths — a ceiling SET (the at-cap agent's
 * own raise, the immediate need) and a ceiling REVOKE — plus one RULE set.
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

const settings = (data: Record<string, unknown>): ApplyArgs => ({
  proposal: {
    id: "prop-1",
    targetType: "settings",
    targetId: "target-1",
    proposalType: "settings.update",
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
});

beforeEach(() => {
  insertReturning = [];
  inserts.length = 0;
  updates.length = 0;
});

describe("settings.update approval — B5 executor", () => {
  it("set: a pending_proposal_cap ceiling raises the agent's cap", async () => {
    insertReturning = [[{ id: "ceiling-1" }]];
    const result = await applyProposalApproval(
      settings({
        store: "governance_ceilings",
        op: "set",
        axis: "pending_proposal_cap",
        limitValue: 50,
        agentUserId: "agent-1",
      })
    );
    expect(result.success).toBe(true);
    const ceilingInsert = inserts.find(
      (i) => i.axis === "pending_proposal_cap"
    );
    expect(ceilingInsert).toMatchObject({
      axis: "pending_proposal_cap",
      limitValue: 50,
      principalKind: "agent",
      agentUserId: "agent-1",
      scopeKind: "pod",
    });
    // The proposal itself is marked APPROVED.
    expect(updates.some((u) => u.status === "approved")).toBe(true);
  });

  it("revoke: soft-deletes the ceiling row", async () => {
    insertReturning = [];
    const result = await applyProposalApproval(
      settings({
        store: "governance_ceilings",
        op: "revoke",
        targetId: "ceiling-1",
      })
    );
    expect(result.success).toBe(true);
    expect(inserts).toEqual([]);
    expect(updates.some((u) => u.revokedAt instanceof Date)).toBe(true);
  });

  it("set: a governance_rules row with verdict auto is written", async () => {
    insertReturning = [[{ id: "rule-1" }]];
    const result = await applyProposalApproval(
      settings({
        store: "governance_rules",
        op: "set",
        verdict: "auto",
        targetKind: "action",
        targetPattern: "entity.create",
      })
    );
    expect(result.success).toBe(true);
    const ruleInsert = inserts.find((i) => i.verdict === "auto");
    expect(ruleInsert).toMatchObject({
      verdict: "auto",
      targetPattern: "entity.create",
      targetKind: "action",
    });
  });

  // The unified door now carries EVERY recommender's rule write, so the floor
  // check the legacy `governance.widen_lane` branch performed has to live here
  // too — otherwise this door is the one way to store an `auto` rule that can
  // never fire (rung 2.8 sits below the floor). Same refusal, same message.
  it("refuses an `auto` rule behind a NON-WIDENABLE floor — writes nothing", async () => {
    await expect(
      applyProposalApproval(
        settings({
          store: "governance_rules",
          op: "set",
          verdict: "auto",
          targetKind: "action",
          targetPattern: "profile.create",
        })
      )
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message:
        'NON_WIDENABLE_FLOOR (AGENT_SCHEMA_DEFINITION): "profile.create" always needs review — no governance rule can auto-approve it.',
    });
    expect(inserts).toEqual([]);
    expect(updates).toEqual([]);
  });

  // The floor only forbids WIDENING. A `propose` rule on the same key is the
  // tighten direction — it pins to review, which no floor can object to.
  it("still writes a `propose` rule on the same floored key", async () => {
    insertReturning = [[{ id: "rule-1" }]];
    const result = await applyProposalApproval(
      settings({
        store: "governance_rules",
        op: "set",
        verdict: "propose",
        targetKind: "action",
        targetPattern: "profile.create",
      })
    );
    expect(result.success).toBe(true);
    expect(inserts.find((i) => i.verdict === "propose")).toMatchObject({
      verdict: "propose",
      targetPattern: "profile.create",
    });
  });
});
