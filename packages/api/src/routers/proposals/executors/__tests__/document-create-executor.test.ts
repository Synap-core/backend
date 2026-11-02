/**
 * `document/create` approval returns the id the document was written under
 * (`primaryId`), like the document edit executors, so the review page can
 * name and open what an approval made. The id is the proposal's `targetId`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  materialize: vi.fn(),
  updates: [] as unknown[],
}));

vi.mock(
  "../../../../services/proposals/materialize-approved-document.js",
  () => ({
    materializeApprovedDocument: h.materialize,
  })
);
vi.mock("../../../../services/document-scope/document-scope.js", () => ({
  podDocumentScopeFloor: () => ({}),
  resolveDocumentScopeFields: async () => ({}),
}));
vi.mock("../../../../services/document-patch/apply-document-patch.js", () => ({
  applyApprovedDocumentPatch: vi.fn(),
}));
vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  db: {},
  proposals: { id: "id", status: "status" },
  eq: () => true,
  transitionProposal: async (_db: unknown, args: unknown) => {
    h.updates.push(args);
  },
}));
vi.mock("@synap/database/schema", () => ({
  ProposalStatus: { APPROVED: "approved" },
}));
vi.mock("../shared.js", () => ({
  reportApproved: vi.fn(),
  storedProposalFields: (p: { data: { data: Record<string, unknown> } }) =>
    p.data.data,
}));

import { registerDocumentExecutors } from "../document.js";
import { proposalExecRegistry } from "../../execution-registry.js";

registerDocumentExecutors();
const exec = proposalExecRegistry.resolve("document/create", "create")!;

const DOC_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  h.materialize.mockReset();
  h.updates = [];
});

describe("document/create executor", () => {
  it("writes the document under targetId and returns it as primaryId", async () => {
    h.materialize.mockResolvedValue({ id: DOC_ID });
    const emit = vi.fn();
    const result = await exec.execute({
      proposal: {
        targetType: "document",
        proposalType: "create",
        targetId: DOC_ID,
        workspaceId: "w1",
        data: { data: { id: DOC_ID, title: "Plan", content: "# Plan" } },
      },
      payload: {},
      userId: "approver",
      input: { proposalId: "p1" },
      deps: { emitProposalReviewed: emit },
    } as never);

    expect(h.materialize).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: DOC_ID, title: "Plan" })
    );
    expect(result).toMatchObject({
      success: true,
      primaryId: DOC_ID,
      effect: { applied: "verified", ids: [DOC_ID], subject: "documents" },
    });
    expect(h.updates).toHaveLength(1);
  });
});
