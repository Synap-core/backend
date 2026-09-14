/**
 * Approving a `governance.widen_lane` on a key behind a NON-WIDENABLE floor
 * stores NO rule and says why — the same refusal `governanceRules.create`
 * gives (B3). Before: the approval inserted an `auto` rule that could never
 * fire, reported as `applied`.
 *
 * Drives the REAL `applyProposalApproval` and the REAL `nonWidenableFloorFor`
 * (engine not mocked); only the db handle records statements. Harness mirrors
 * approval-no-effect-receipt.test.ts.
 *
 * NOT covered: non-`action` granularities (profile/agent/global/capability) —
 * `nonWidenableFloorFor` only judges an exact action key, same as `create`.
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

const widen = (targetPattern: string): ApplyArgs => ({
  proposal: {
    id: "prop-1",
    targetType: "governance",
    targetId: "target-1",
    proposalType: "governance.widen_lane",
    workspaceId: null,
    sessionId: null,
    projectId: null,
    agentUserId: "agent-1",
    sourceMessageId: null,
    correlationId: null,
    data: {
      agentUserId: "agent-1",
      targetKind: "action",
      targetPattern,
      scopeKind: "pod",
    },
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

describe("governance.widen_lane approval — non-widenable keys", () => {
  for (const [key, floor] of [
    ["automation.create", "AGENT_STRUCTURE_WRITE"],
    ["profile.create", "AGENT_SCHEMA_DEFINITION"],
    ["pod_hygiene.cleanup_pack", "HUMAN_GATE"],
  ] as const) {
    it(`${key}: refused with create's reason, no rule stored, proposal not approved`, async () => {
      await expect(applyProposalApproval(widen(key))).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: `NON_WIDENABLE_FLOOR (${floor}): "${key}" always needs review — no governance rule can auto-approve it.`,
      });
      expect(inserts).toEqual([]);
      expect(updates).toEqual([]);
    });
  }

  it("control: a widenable key still stores its auto rule", async () => {
    insertReturning = [[{ id: "rule-1" }]];
    const result = await applyProposalApproval(widen("entity.create"));
    expect(result.success).toBe(true);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      verdict: "auto",
      targetPattern: "entity.create",
    });
  });
});
