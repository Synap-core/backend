/**
 * The revert planner over AUTO-APPROVE RECEIPTS — rows whose `proposalType` is
 * the gate's DOTTED event key (`entity.create`, `document.create`,
 * `link.create`, `entity.delete`), not the bare verb a pending proposal stores.
 *
 * Live 2026-09-28: every `@reversible` auto-approved create read "Can't be
 * undone" — the dotted type was never classified as a create, so it fell to
 * `unsupported`. The fixture below is the live receipt 3b0d64cb… reduced to
 * its load-bearing fields: flat (not request-shaped) data whose `id` is the
 * gate's pre-minted guess, NOT the row the door wrote.
 *
 * Rows are chosen where candidate rules DISAGREE:
 *   - stamped dotted create: "only bare `create` is a create" (the old rule)
 *     says unsupported; the right rule plans the STAMPED id;
 *   - UNSTAMPED dotted create: "a dotted create is a create, legacy fallback
 *     to targetId" (the half fix) plans the pre-minted, never-created id —
 *     which then fails NOT_FOUND at revert; the right rule says unsupported;
 *   - dotted delete: "only bare `delete` is a delete" says unsupported; the
 *     right rule restores the entity (entity deletes are soft).
 */

import { describe, it, expect } from "vitest";
import { planProposalRevert, revertableForRow } from "./revert.js";

const PRE_MINTED = "c3d53123-0000-4000-8000-000000000000";
const CREATED = "8059774b-8d0d-4dc6-bc4e-9b3356d27053";

/** The live auto-approve receipt shape (`permission-check.ts` execute branch). */
function receipt(
  over: Partial<{
    status: string;
    targetType: string;
    proposalType: string;
    materialized: unknown;
  }> = {}
) {
  const targetType = over.targetType ?? "entity";
  return {
    status: over.status ?? "auto_approved",
    targetType,
    targetId: PRE_MINTED,
    proposalType: over.proposalType ?? `${targetType}.create`,
    data: {
      id: PRE_MINTED,
      title: "Ada",
      profileSlug: "person",
      properties: {},
      agentUserId: "agent-1",
      _autoApprove: {
        matchedPattern: "@reversible",
        approvedBy: "system:auto_approve",
      },
      ...(over.materialized !== undefined
        ? { materialized: over.materialized }
        : {}),
    },
  };
}

describe("a stamped dotted create receipt plans the STAMPED rows", () => {
  it("entity.create → delete-creations of the stamped id, never targetId", () => {
    const plan = planProposalRevert(
      receipt({ materialized: { entityIds: [CREATED] } })
    );
    expect(plan.kind).toBe("delete-creations");
    if (plan.kind !== "delete-creations") return;
    expect(plan.entityIds).toEqual([CREATED]);
    expect(JSON.stringify(plan)).not.toContain(PRE_MINTED);
  });

  it.each([
    ["document", "documentIds"],
    ["relation", "relationIds"],
    ["link", "linkIds"],
  ] as const)("%s.create → delete-creations of %s", (targetType, field) => {
    const plan = planProposalRevert(
      receipt({ targetType, materialized: { [field]: [CREATED] } })
    );
    expect(plan.kind).toBe("delete-creations");
    if (plan.kind !== "delete-creations") return;
    expect(plan[field]).toEqual([CREATED]);
    expect(JSON.stringify(plan)).not.toContain(PRE_MINTED);
  });

  it("the list's revertable agrees: stamped ⇒ true", () => {
    expect(
      revertableForRow(receipt({ materialized: { entityIds: [CREATED] } }))
    ).toBe(true);
  });
});

describe("an UNSTAMPED dotted create receipt never falls back to targetId", () => {
  it.each(["entity", "document"])(
    "%s.create with no record ⇒ unsupported (the pre-minted id may name nothing)",
    (targetType) => {
      const plan = planProposalRevert(receipt({ targetType }));
      expect(plan.kind).toBe("unsupported");
      if (plan.kind === "unsupported") {
        expect(plan.reason).toMatch(/never recorded/);
      }
      expect(revertableForRow(receipt({ targetType }))).toBe(false);
    }
  );

  it("a stamp saying it created nothing (dedup) ⇒ unsupported, nothing to undo", () => {
    const plan = planProposalRevert(receipt({ materialized: {} }));
    expect(plan.kind).toBe("unsupported");
    if (plan.kind === "unsupported") {
      expect(plan.reason).toMatch(/created no new rows/);
    }
  });

  it("a PENDING bare `create` still predicts from its target (unchanged)", () => {
    // The fallback stays for the bare verb: the approval executor stamps its
    // record, and the prediction is what the reviewer decides on.
    expect(
      revertableForRow({
        status: "pending",
        targetType: "entity",
        targetId: PRE_MINTED,
        proposalType: "create",
        data: {
          requestId: "r",
          targetType: "entity",
          changeType: "create",
          data: { id: PRE_MINTED },
        },
      })
    ).toBe(true);
  });
});

describe("a dotted delete receipt is classified as a delete", () => {
  it("entity.delete ⇒ restore the soft-deleted entity (same as bare delete)", () => {
    expect(
      planProposalRevert({
        status: "auto_approved",
        targetType: "entity",
        targetId: CREATED,
        proposalType: "entity.delete",
        data: { id: CREATED },
      })
    ).toEqual({ kind: "restore-delete", entityId: CREATED });
  });

  it("relation.delete ⇒ unsupported (hard delete, same as bare delete)", () => {
    const plan = planProposalRevert({
      status: "auto_approved",
      targetType: "relation",
      targetId: CREATED,
      proposalType: "relation.delete",
      data: { id: CREATED },
    });
    expect(plan.kind).toBe("unsupported");
    if (plan.kind === "unsupported") {
      expect(plan.reason).toMatch(/no recoverable soft-delete/);
    }
  });
});
