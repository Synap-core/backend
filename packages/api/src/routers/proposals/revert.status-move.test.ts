/**
 * FB1020 B3 — a status move comes with Undo: the planner answers a move BACK
 * through the status door (`move-status-back`), read from the move's own
 * payload (`expectedFrom` → `to`), for the auto-approved receipt
 * (`entity.transition`, flat payload) and the approved proposal (`transition`,
 * request envelope). A move from no status has nothing to move back to. A
 * PENDING move is never predicted revertable: that prediction feeds the
 * swipe/batch gate (founder B3e — no batch approval beyond routine).
 *
 * The execution half (CAS + `moveStatus` as the person undoing) lives in the
 * `revert` procedure; this pins the decision only.
 */
import { describe, it, expect } from "vitest";
import { planProposalRevert, revertableForRow } from "./revert.js";

const move = {
  id: "e1",
  entityId: "e1",
  role: null,
  facetId: null,
  property: "status",
  expectedFrom: "todo",
  to: "done",
  reason: null,
};

describe("revert of a status move", () => {
  it("a receipt moves back to the status it came from", () => {
    expect(
      planProposalRevert({
        status: "auto_approved",
        targetType: "entity",
        targetId: "e1",
        proposalType: "entity.transition",
        data: { ...move, changeType: "move" },
      })
    ).toEqual({
      kind: "move-status-back",
      entityId: "e1",
      role: null,
      facetId: null,
      movedTo: "done",
      restoreTo: "todo",
    });
  });

  it("an approved proposal (request envelope) does too, and lists as revertable", () => {
    const row = {
      status: "approved",
      targetType: "entity",
      targetId: "e1",
      proposalType: "transition",
      data: {
        requestId: "r",
        targetType: "entity",
        changeType: "transition",
        data: { ...move, role: "lead", facetId: "f1" },
      },
    };
    expect(planProposalRevert(row)).toMatchObject({
      kind: "move-status-back",
      role: "lead",
      facetId: "f1",
    });
    expect(revertableForRow(row)).toBe(true);
  });

  it("a move from no status cannot be moved back", () => {
    expect(
      planProposalRevert({
        status: "auto_approved",
        targetType: "entity",
        targetId: "e1",
        proposalType: "entity.transition",
        data: { ...move, expectedFrom: null },
      }).kind
    ).toBe("unsupported");
  });

  it("a PENDING move is not predicted revertable (no swipe / batch for it)", () => {
    expect(
      revertableForRow({
        status: "pending",
        targetType: "entity",
        targetId: "e1",
        proposalType: "transition",
        data: {
          requestId: "r",
          targetType: "entity",
          changeType: "transition",
          data: move,
        },
      })
    ).toBe(false);
  });
});
