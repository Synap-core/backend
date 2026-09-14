/**
 * APPROVING AN AI DOCUMENT EDIT MUST NOT OVERWRITE A LATER HUMAN SAVE.
 *
 * THE DEFECT: the document-content branch of `applyProposalApproval` uploaded
 * `proposedContent` over current storage and wrote `version + 1` without
 * comparing anything. A person who saved the document after the AI filed its
 * edit lost that save, silently, the moment anyone approved.
 *
 * THE FIX: the filing door (`createDocumentProposal`) records `baseVersion`;
 * approval throws CONFLICT before any write when the document moved past it.
 *
 * Driven through the REAL `applyProposalApproval` with a recording db stub (same
 * harness as `approval-no-effect-receipt.test.ts`): a stale approval must write
 * NOTHING — no storage upload, no version row, no document update, no status
 * flip — and throw so the proposal stays pending.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

let documentRow: Record<string, unknown> | undefined;
const inserts: Array<Record<string, unknown>> = [];
const updates: Array<Record<string, unknown>> = [];
const uploads: string[] = [];

function statementResult(rows: Array<{ id: string }>) {
  const p = Promise.resolve(rows) as Promise<Array<{ id: string }>> & {
    returning: () => Promise<Array<{ id: string }>>;
  };
  p.returning = async () => rows;
  return p;
}

const dbStub = {
  query: {
    proposals: { findFirst: async () => undefined },
    documents: { findFirst: async () => documentRow },
  },
  insert: () => ({
    values: (values: Record<string, unknown>) => {
      inserts.push(values);
      return statementResult([{ id: "version-row" }]);
    },
  }),
  update: () => ({
    set: (values: Record<string, unknown>) => {
      updates.push(values);
      const result = statementResult([{ id: "doc-1" }]);
      return { where: () => result };
    },
  }),
};

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  db: dbStub,
  uploadDocumentVersionSnapshot: async () => ({
    storageUrl: "u",
    storageKey: "v",
    size: 1,
    mimeType: "text/markdown",
    checksum: "c",
    contentPreview: "",
  }),
}));
vi.mock("@synap/storage", () => ({
  storage: {
    upload: async (key: string) => {
      uploads.push(key);
      return { url: "u", path: key, size: 1 };
    },
  },
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

const { applyProposalApproval } = await import("../apply-approval.js");

type ApplyArgs = Parameters<typeof applyProposalApproval>[0];

function approveDocumentEdit(data: Record<string, unknown>): ApplyArgs {
  return {
    proposal: {
      id: "prop-1",
      targetType: "document",
      targetId: "doc-1",
      proposalType: "ai_edit",
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
  inserts.length = 0;
  updates.length = 0;
  uploads.length = 0;
  documentRow = {
    id: "doc-1",
    storageKey: "docs/doc-1.md",
    currentVersion: 4,
    mimeType: "text/markdown",
    type: "markdown",
  };
});

describe("document edit approval — base version", () => {
  it("REFUSES (CONFLICT) when a person saved after the edit was drafted, and writes nothing", async () => {
    const approval = applyProposalApproval(
      approveDocumentEdit({
        source: "agent",
        proposedContent: "AI text",
        baseVersion: 3,
      })
    );
    await expect(approval).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(approval).rejects.toThrow(/drafted against version 3, now version 4/);
    expect(uploads).toEqual([]);
    expect(inserts).toEqual([]);
    expect(updates).toEqual([]);
  });

  it("APPLIES when the document is still at the drafted version", async () => {
    const result = await applyProposalApproval(
      approveDocumentEdit({
        source: "agent",
        proposedContent: "AI text",
        baseVersion: 4,
      })
    );
    expect(result.success).toBe(true);
    expect(uploads).toEqual(["docs/doc-1.md"]);
    expect(inserts[0]).toMatchObject({ documentId: "doc-1", version: 5 });
    expect(updates[0]).toMatchObject({ currentVersion: 5 });
  });

  it("a proposal filed before base versions existed applies as before", async () => {
    const result = await applyProposalApproval(
      approveDocumentEdit({ source: "agent", proposedContent: "AI text" })
    );
    expect(result.success).toBe(true);
    expect(uploads).toEqual(["docs/doc-1.md"]);
  });
});
