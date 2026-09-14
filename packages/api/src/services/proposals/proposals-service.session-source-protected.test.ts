import { describe, it, expect } from "vitest";
import { computeRevisedEnvelope } from "./proposals-service.js";

/**
 * `data.sessionSource` is NOT revisable.
 *
 * `insertPendingProposal` stamps `sessionSource: "derived"` on a pending row whose
 * session was a GUESS. Both approve doors read it to keep that guessed session's
 * project off the approved entities (`belongs_to_project` widens access). If a
 * revise could clear it, an agent could revise its own pending proposal and
 * re-arm the placement at approval; if it could plant it, a reviser could strip
 * a real project.
 *
 * Driven through the pure shared revise core every revise door calls. Mirrors
 * the `connectionSync` suite.
 */

/** A pending import filed under a DERIVED session — the marker at top level. */
const MARKED = {
  targetType: "entity",
  changeType: "import.graph",
  operations: [{ op: "create_entity", ref: "n1", profileSlug: "note" }],
  sessionSource: "derived",
};

/** An ordinary pending import, no marker — the planting target. */
const UNMARKED = {
  targetType: "entity",
  changeType: "import.graph",
  operations: [{ op: "create_entity", ref: "n1", profileSlug: "note" }],
};

describe("computeRevisedEnvelope — sessionSource is not revisable", () => {
  it("refuses an envelope patch that CLEARS the marker", () => {
    expect(() =>
      computeRevisedEnvelope({
        envelope: MARKED,
        patch: { kind: "envelope", fields: { sessionSource: null } },
      })
    ).toThrow(/sessionSource/);
  });

  it("refuses an inner patch that FLIPS the marker to explicit", () => {
    expect(() =>
      computeRevisedEnvelope({
        envelope: MARKED,
        patch: { kind: "inner", fields: { sessionSource: "explicit" } },
      })
    ).toThrow(/sessionSource/);
  });

  it("refuses the nested form (a patch carrying data.sessionSource)", () => {
    expect(() =>
      computeRevisedEnvelope({
        envelope: MARKED,
        patch: {
          kind: "envelope",
          fields: { data: { sessionSource: "explicit" } },
        },
      })
    ).toThrow(/sessionSource/);
  });

  it("refuses PLANTING the marker on an unmarked row", () => {
    expect(() =>
      computeRevisedEnvelope({
        envelope: UNMARKED,
        patch: { kind: "envelope", fields: { sessionSource: "derived" } },
      })
    ).toThrow(/sessionSource/);
  });

  it("a legitimate revise of the operations keeps the stored marker byte-identical", () => {
    const { merged } = computeRevisedEnvelope({
      envelope: MARKED,
      patch: {
        kind: "envelope",
        fields: {
          operations: [
            { op: "create_entity", ref: "n1", profileSlug: "note", title: "x" },
          ],
        },
      },
    });
    expect(merged.sessionSource).toBe("derived");
    expect((merged.operations as Array<{ title?: string }>)[0].title).toBe("x");
  });
});
