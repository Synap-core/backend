/**
 * A document edit comes with Undo (decision 6c5e9642): the planner answers
 * `restore-document-edit` from the text record the write stamped
 * (`data.materialized.documentEdit`), for the approved proposal (request
 * envelope, every `DOCUMENT_PATCH_PROPOSAL_TYPES` type) and the auto-approved
 * receipt (`document.<action>`, flat payload). With no record it says why,
 * and a patch that sets the scope or the refresher is never undoable.
 *
 * The pending prediction (`wouldBeRevertable`) answers true for exactly the
 * patches the executor will stamp, so "Can't be undone" no longer shows on a
 * document edit governance calls reversible.
 *
 * The execution half (put back only what still holds the edit's text) is
 * `document-edit-undo.test.ts` and the PGlite suite of the patch door.
 */
import { describe, it, expect } from "vitest";
import { DOCUMENT_PATCH_PROPOSAL_TYPES } from "@synap-core/types/proposals/intent";
import {
  planProposalRevert,
  revertableForRow,
  wouldBeRevertable,
} from "./revert.js";

const ops = [{ op: "upsert_section", id: "a", title: "a", body: "x" }];
const documentEdit = {
  documentId: "d1",
  granularity: "sections" as const,
  changes: [{ sectionId: "a", title: "a", before: "old", after: "new" }],
};
const envelope = (extra: Record<string, unknown> = {}) => ({
  requestId: "r",
  targetType: "document",
  changeType: "update",
  data: { documentId: "d1", ops, baseRevision: 3, ...extra },
});

describe("revert of a document edit", () => {
  it.each(DOCUMENT_PATCH_PROPOSAL_TYPES)(
    "an approved '%s' with its record puts the text back",
    (proposalType) => {
      expect(
        planProposalRevert({
          status: "approved",
          targetType: "document",
          targetId: "d1",
          proposalType,
          data: { ...envelope(), materialized: { documentEdit } },
        })
      ).toEqual({ kind: "restore-document-edit", edit: documentEdit });
    }
  );

  it("an auto-approved receipt (flat payload, dotted type) does too", () => {
    for (const action of [
      "update",
      "section_update",
      "session_narrative_update",
      "refresher_section_update",
    ]) {
      expect(
        planProposalRevert({
          status: "auto_approved",
          targetType: "document",
          targetId: "d1",
          proposalType: `document.${action}`,
          data: { documentId: "d1", ops, materialized: { documentEdit } },
        }).kind
      ).toBe("restore-document-edit");
    }
  });

  it("a rename-only record is undoable too", () => {
    const rename = {
      documentId: "d1",
      granularity: "sections" as const,
      changes: [],
      rename: { before: "Plan", after: "Launch plan" },
    };
    expect(
      planProposalRevert({
        status: "approved",
        targetType: "document",
        targetId: "d1",
        proposalType: "update",
        data: { ...envelope(), materialized: { documentEdit: rename } },
      }).kind
    ).toBe("restore-document-edit");
  });

  it("no record (applied before records were kept) or an empty one says why", () => {
    const base = {
      status: "approved",
      targetType: "document",
      targetId: "d1",
      proposalType: "section_update",
    };
    expect(planProposalRevert({ ...base, data: envelope() })).toEqual({
      kind: "unsupported",
      reason: expect.stringMatching(/before undo records were kept/),
    });
    expect(
      planProposalRevert({
        ...base,
        data: {
          ...envelope(),
          materialized: { documentEdit: { ...documentEdit, changes: [] } },
        },
      })
    ).toEqual({
      kind: "unsupported",
      reason: expect.stringMatching(/changed nothing/),
    });
  });

  it("a scope or refresher change is never undoable — applied or pending", () => {
    const row = {
      targetType: "document",
      targetId: "d1",
      proposalType: "update",
      data: {
        ...envelope({ ops: [...ops, { op: "set_scope", scope: null }] }),
      },
    };
    expect(
      planProposalRevert({
        ...row,
        status: "approved",
        data: { ...row.data, materialized: { documentEdit } },
      })
    ).toEqual({
      kind: "unsupported",
      reason: expect.stringMatching(/scope or its refresher/),
    });
    expect(wouldBeRevertable(row)).toBe(false);
  });

  it("a PENDING document edit is predicted revertable (no 'Can't be undone' on it)", () => {
    for (const proposalType of DOCUMENT_PATCH_PROPOSAL_TYPES) {
      expect(
        revertableForRow({
          status: "pending",
          targetType: "document",
          targetId: "d1",
          proposalType,
          data: envelope(),
        })
      ).toBe(true);
    }
    // The pre-patch full-replace format is applied by a branch that records nothing.
    expect(
      wouldBeRevertable({
        targetType: "document",
        targetId: "d1",
        proposalType: "user_edit",
        data: { proposedContent: "new text" },
      })
    ).toBe(false);
  });

  it("a document CREATE and DELETE keep their own rules", () => {
    expect(
      planProposalRevert({
        status: "approved",
        targetType: "document",
        targetId: "d1",
        proposalType: "create",
        data: {},
      })
    ).toMatchObject({ kind: "delete-creations", documentIds: ["d1"] });
    expect(
      planProposalRevert({
        status: "approved",
        targetType: "document",
        targetId: "d1",
        proposalType: "delete",
        data: {},
      }).kind
    ).toBe("unsupported");
  });
});
