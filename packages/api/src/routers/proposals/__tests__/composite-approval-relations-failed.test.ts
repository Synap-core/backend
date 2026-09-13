/**
 * AN APPROVED GRAPH WHOSE EDGES FAILED MUST SAY SO — through the approval door.
 *
 * THE DEFECT this pins: `materializeCompositeGraph` names every relation op that
 * did not land in `relationsFailed[]`, and `applyProposalApproval`'s composite
 * branch destructured every field of that result EXCEPT it. A human approving a
 * 12-entity / 7-edge graph whose every edge failed got `{ success: true }` —
 * the failure lived only in a `logger.warn`.
 *
 * REACHABILITY, not shape: this drives a real composite payload through the
 * real `applyProposalApproval`, with only the materializer (and the DB handle)
 * stubbed, and asserts the failure VALUE — with its reason — arrives on the
 * result. A source grep for the field name would pass with the value dropped.
 *
 * No live Postgres (the api suite has none) — same seam as
 * `approval-no-effect-receipt.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const updates: Array<Record<string, unknown>> = [];

function statementResult(rows: unknown[]) {
  const p = Promise.resolve(rows) as Promise<unknown[]> & {
    returning: () => Promise<unknown[]>;
    onConflictDoNothing: () => Promise<unknown[]>;
  };
  p.returning = async () => rows;
  p.onConflictDoNothing = async () => rows;
  return p;
}

const dbStub = {
  query: { proposals: { findFirst: async () => undefined } },
  insert: () => ({ values: () => statementResult([]) }),
  update: () => ({
    set: (values: Record<string, unknown>) => {
      updates.push(values);
      return { where: () => statementResult([]) };
    },
  }),
};

/** What the stubbed materializer reports for the next approval. */
let materializeResult: Record<string, unknown> = {};

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  db: dbStub,
}));
vi.mock("../approve-executors.js", () => ({
  registerApproveExecutors: () => {},
}));
vi.mock("../graph-dispositions.js", () => ({
  applyGraphDispositions: (ops: unknown) => ops,
  survivingEntityDecisionSlices: () => [],
  survivingEntityFacetSlices: () => ({}),
  foldFacetsIntoOps: (ops: unknown) => ops,
}));
vi.mock("../../entities.js", () => ({
  entitiesRouter: { createCaller: () => ({}) },
}));
vi.mock("../../relations.js", () => ({
  relationsRouter: { createCaller: () => ({}) },
}));
vi.mock("../../../utils/materialize-composite.js", () => ({
  materializeCompositeGraph: async () => materializeResult,
}));
vi.mock("../../../services/proposals/reconcile-proposal-properties.js", () => ({
  reconcileApprovedProperties: async (a: unknown) => a,
}));
vi.mock("../../../services/proposals/complete-knowledge-proposal.js", () => ({
  // No properties on the fixture ops ⇒ the reconcile loop is skipped.
  completeKnowledgeProposalProperties: () => undefined,
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

const { applyProposalApproval } = await import("../apply-approval.js");
type ApplyArgs = Parameters<typeof applyProposalApproval>[0];

/** A pod-wide composite graph: two entities and one edge between them. */
function compositeArgs(): ApplyArgs {
  return {
    proposal: {
      id: "prop-graph-1",
      targetType: "entity",
      targetId: "target-1",
      proposalType: "import.graph",
      workspaceId: null,
      sessionId: null,
      projectId: null,
      agentUserId: "agent-1",
      sourceMessageId: null,
      correlationId: null,
      data: {
        operations: [
          {
            op: "create_entity",
            ref: "p1",
            profileSlug: "person",
            title: "Ada",
          },
          {
            op: "create_entity",
            ref: "c1",
            profileSlug: "company",
            title: "Acme",
          },
          {
            op: "create_relation",
            sourceRef: "p1",
            targetRef: "c1",
            type: "part_of",
          },
        ],
      },
    } as unknown as ApplyArgs["proposal"],
    userId: "human-approver",
    input: { proposalId: "prop-graph-1" },
    ctx: {} as ApplyArgs["ctx"],
  };
}

/** Entities LINKED (not created) so project-membership stamping is a no-op. */
const ENTITIES = [
  { ref: "p1", entityId: "ent-p1", linked: true },
  { ref: "c1", entityId: "ent-c1", linked: true },
];

beforeEach(() => {
  updates.length = 0;
});

describe("composite approval reports the edges that did not land", () => {
  it("a failed edge reaches the approval result WITH its reason", async () => {
    materializeResult = {
      created: 0,
      linked: 0,
      primaryId: "ent-p1",
      refToRealId: { p1: "ent-p1", c1: "ent-c1" },
      entities: ENTITIES,
      relations: [],
      relationsFailed: [
        {
          sourceRef: "p1",
          targetRef: "c1",
          type: "part_of",
          reason:
            'Unknown relation type: "part_of". Must be a workspace relation definition.',
        },
      ],
    };

    const result = await applyProposalApproval(compositeArgs());

    // The approval itself still applied — entities are kept.
    expect(result.success).toBe(true);
    // …and the caller is TOLD which edge did not, and why.
    expect(result.relationsFailed).toEqual([
      {
        sourceRef: "p1",
        targetRef: "c1",
        type: "part_of",
        reason: expect.stringMatching(/Unknown relation type: "part_of"/),
      },
    ]);
    // The branch under test really ran to completion (proposal marked approved).
    expect(updates.some((u) => u.status === "approved")).toBe(true);
  });

  it("a graph whose every edge landed carries no relationsFailed key", async () => {
    materializeResult = {
      created: 0,
      linked: 1,
      primaryId: "ent-p1",
      refToRealId: { p1: "ent-p1", c1: "ent-c1" },
      entities: ENTITIES,
      relations: [
        {
          sourceEntityId: "ent-p1",
          targetEntityId: "ent-c1",
          type: "works_at",
        },
      ],
      relationsFailed: [],
    };

    const result = await applyProposalApproval(compositeArgs());

    expect(result.success).toBe(true);
    expect(result).not.toHaveProperty("relationsFailed");
  });
});
