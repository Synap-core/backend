/**
 * `revertable` on `proposals.list` rows — the per-row status matrix.
 *
 * The field used to be `false` for every row that was not already APPLIED. The
 * only rows a reviewer DECIDES on are pending ones, so every pending card read as
 * irreversible: swipe-to-approve (which requires `revertable === true`) was
 * permanently off, every decidable card wore "Can't be undone", and the in-card
 * Undo never appeared. Every client test hand-built a `revertable: true` row, so
 * the whole suite stayed green over a wire that never produced one.
 *
 * Rows are chosen where the candidate rules DISAGREE:
 *   - "false unless applied" (the old rule) vs the right one → a pending CREATE;
 *   - "true for every live row" (the lazy fix) vs the right one → a pending
 *     `edit` / non-entity update, which nothing stamps and must stay false
 *     (an ENTITY update is true: its executor stamps an apply-time diff);
 *   - a COMPOSITE, which only the prediction path can answer (its created ids
 *     are stamped at approval);
 *   - every terminal status, which must stay false.
 *
 * The list procedure batch-joins the DB and cannot run here, so the handler is
 * pinned by a CALL-SITE scan below: the matrix is a pure function exactly so a
 * test can drive the code the wire uses.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { revertableForRow, wouldBeRevertable } from "./revert.js";

const row = (
  status: string,
  over: Partial<{
    targetType: string;
    targetId: string;
    proposalType: string;
    data: unknown;
  }> = {}
) => ({
  status,
  targetType: "entity",
  targetId: "11111111-1111-1111-1111-111111111111",
  proposalType: "create",
  data: {},
  ...over,
});

const COMPOSITE = {
  operations: [{ op: "create_entity", profileSlug: "note", title: "N" }],
};

describe("a LIVE row answers 'would revert succeed once applied?'", () => {
  it("a pending CREATE is revertable (the old rule said false)", () => {
    expect(revertableForRow(row("pending"))).toBe(true);
  });

  it("a failed-approval CREATE is revertable too (still live, still decidable)", () => {
    expect(revertableForRow(row("approval_failed"))).toBe(true);
  });

  it("a pending ENTITY update is revertable — the `entity/update` executor stamps its apply-time diff", () => {
    expect(revertableForRow(row("pending", { proposalType: "update" }))).toBe(
      true
    );
  });

  it("an update nothing stamps is NOT revertable (the lazy 'all live = true' fix fails here)", () => {
    // `edit` routes to no entity/update executor; a non-entity update has no
    // before-snapshot writer at all.
    expect(revertableForRow(row("pending", { proposalType: "edit" }))).toBe(
      false
    );
    expect(
      revertableForRow(
        row("pending", { proposalType: "update", targetType: "cell" })
      )
    ).toBe(false);
  });

  it("an APPLIED entity update answers from its stamp: stamped → true, legacy (no stamp) → false", () => {
    const stamped = {
      materialized: {
        propertyDiffs: [
          {
            entityId: "11111111-1111-1111-1111-111111111111",
            before: { stage: "lead" },
            after: { stage: "client" },
            absentBefore: [],
          },
        ],
      },
    };
    expect(
      revertableForRow(
        row("approved", { proposalType: "update", data: stamped })
      )
    ).toBe(true);
    // An auto-approve receipt names its type `<subject>.<action>`.
    expect(
      revertableForRow(
        row("auto_approved", { proposalType: "entity.update", data: stamped })
      )
    ).toBe(true);
    expect(revertableForRow(row("approved", { proposalType: "update" }))).toBe(
      false
    );
    expect(
      revertableForRow(
        row("auto_approved", { proposalType: "entity.update", data: {} })
      )
    ).toBe(false);
  });

  it("a pending entity DELETE is revertable (soft delete); a non-entity delete is not", () => {
    expect(revertableForRow(row("pending", { proposalType: "delete" }))).toBe(
      true
    );
    expect(
      revertableForRow(
        row("pending", { proposalType: "delete", targetType: "document" })
      )
    ).toBe(false);
  });

  it("a pending COMPOSITE is revertable — only the prediction can say so (no stamped record yet)", () => {
    expect(revertableForRow(row("pending", { data: COMPOSITE }))).toBe(true);
    // The planner alone, asked about the same unstamped row, says unsupported —
    // which is exactly why the prediction path exists.
    expect(revertableForRow({ ...row("approved", { data: COMPOSITE }) })).toBe(
      false
    );
  });

  it("an external/unmapped proposal type is not revertable", () => {
    expect(
      revertableForRow(
        row("pending", {
          targetType: "capability",
          proposalType: "run",
          targetId: "",
        })
      )
    ).toBe(false);
  });
});

describe("terminal statuses stay false", () => {
  it.each(["rejected", "withdrawn", "expired", "reverted"])(
    "%s → false",
    (status) => {
      // A create that WOULD be revertable if it were live — the status is the only difference.
      expect(revertableForRow(row(status))).toBe(false);
    }
  );
});

describe("an APPLIED row still asks the real planner over the stamped record", () => {
  it("approved create with no record and a non-entity target is unsupported", () => {
    expect(
      revertableForRow(
        row("approved", {
          targetType: "workspace",
          targetId: "",
          proposalType: "create",
        })
      )
    ).toBe(false);
  });

  it("approved create on an entity target falls back to the target and is revertable", () => {
    expect(revertableForRow(row("approved"))).toBe(true);
    expect(revertableForRow(row("auto_approved"))).toBe(true);
  });
});

describe("wouldBeRevertable does not read the status it is handed", () => {
  it("is a function of type/target/data alone", () => {
    const { status: _s, ...noStatus } = row("pending");
    expect(wouldBeRevertable(noStatus)).toBe(true);
  });
});

/**
 * ROUND-2: `materialized: {}` is a STATEMENT, not an absence.
 *
 * `executors/entity.ts` stamps `materialized: {}` on purpose when an
 * `entity/create` DEDUPED onto a pre-existing entity — "revert can never delete
 * a row this proposal did not create". The planner's empty-record fallback did
 * not distinguish that from a legacy row that never stamped anything, so it
 * re-added the PRE-MINTED `targetId`: `revertable` read true before AND after
 * approval, and the real revert then deleted an id nothing ever created →
 * NOT_FOUND → "Revert failed".
 *
 * These are the rows where the old fallback and the corrected rule DISAGREE —
 * the ones no fixture above had, because every one of them either omits
 * `materialized` (agrees) or stamps ids (agrees).
 */
describe("a stamped-but-EMPTY materialized record fails loud", () => {
  const deduped = (status: string) =>
    row(status, { data: { materialized: {} } });

  it("non-vacuity: the SAME row WITHOUT the stamp is still revertable", () => {
    // Proves the fixtures below discriminate the stamp, not the status or
    // the target type — the old rule answered `true` for both.
    expect(revertableForRow(row("approved"))).toBe(true);
    expect(revertableForRow(row("pending"))).toBe(true);
  });

  it("an APPLIED entity create that deduped is NOT revertable", () => {
    expect(revertableForRow(deduped("approved"))).toBe(false);
    expect(revertableForRow(deduped("auto_approved"))).toBe(false);
  });

  it("…and the same holds for the live prediction", () => {
    expect(revertableForRow(deduped("pending"))).toBe(false);
    const { status: _s, ...noStatus } = deduped("pending");
    expect(wouldBeRevertable(noStatus)).toBe(false);
  });

  it("a stamp WITH ids is still revertable — this is not 'any stamp blocks'", () => {
    expect(
      revertableForRow(
        row("approved", {
          data: {
            materialized: {
              entityIds: ["22222222-2222-2222-2222-222222222222"],
            },
          },
        })
      )
    ).toBe(true);
  });

  it("a document create that stamped nothing is NOT revertable either", () => {
    expect(
      revertableForRow(
        row("approved", {
          targetType: "document",
          data: { materialized: {} },
        })
      )
    ).toBe(false);
  });
});

describe("the list handler uses the matrix (call-site scan)", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../proposals.ts", import.meta.url)),
    "utf8"
  );

  it("NON-VACUITY: the scan can see the handler it is judging", () => {
    expect(src.length).toBeGreaterThan(10_000);
    expect(src).toContain("const itemsWithPermission = items.map(");
  });

  it("fills `revertable` through revertableForRow", () => {
    expect(src).toContain("revertableForRow({");
  });

  it("no longer decides 'not applied → false' inline (the defect's shape)", () => {
    const handler = src.slice(
      src.indexOf("const revertableById = new Map<string, boolean>();"),
      src.indexOf("const itemsWithPermission = items.map(")
    );
    expect(handler.length).toBeGreaterThan(50);
    expect(handler).not.toContain("revertableById.set(r.id, false)");
    expect(handler).not.toContain("ProposalStatus.APPROVED");
  });
});
