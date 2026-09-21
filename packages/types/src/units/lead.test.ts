/**
 * THE ONE LEAD RULE — shared so browser and relay cannot fork it.
 *
 * The discriminating input is `owed AND gradeOwed together`: it is the ONLY
 * input on which "owed first" (correct) and "grade first" (plausible, and what
 * you get writing the two `if`s the other way round) disagree. Every other row
 * here agrees under both rules — they pin the boundaries, not the choice.
 *
 * The second real input is `owedCount: null WITH gradeOwed` — it separates
 * "an unmeasured ledger suppresses the owed lead" (correct) from "an
 * unmeasured ledger forces steps" (wrong, and the first draft of this rule's
 * own docblock claimed it).
 */

import { describe, expect, it } from "vitest";
import { resolveWorkLead } from "./lead.js";

describe("resolveWorkLead — an obligation you HOLD outranks one you judge", () => {
  it("THE DISCRIMINATING ROW: owed AND a grade owed ⇒ owed leads", () => {
    expect(resolveWorkLead({ owedCount: 1, gradeOwed: true })).toBe("owed");
  });

  it("a grade owed with nothing owed ⇒ the scorecard leads", () => {
    expect(resolveWorkLead({ owedCount: 0, gradeOwed: true })).toBe(
      "scorecard"
    );
  });

  it("owed with no grade pending ⇒ owed leads", () => {
    expect(resolveWorkLead({ owedCount: 3, gradeOwed: false })).toBe("owed");
  });

  it("nothing owed, nothing to grade ⇒ the steps lead", () => {
    expect(resolveWorkLead({ owedCount: 0, gradeOwed: false })).toBe("steps");
  });
});

describe("an UNMEASURED ledger suppresses the owed lead ONLY", () => {
  it("`owedCount: null` never promotes owed", () => {
    expect(resolveWorkLead({ owedCount: null, gradeOwed: false })).toBe(
      "steps"
    );
  });

  it("but a grade genuinely owed still leads — a separate read", () => {
    expect(resolveWorkLead({ owedCount: null, gradeOwed: true })).toBe(
      "scorecard"
    );
  });

  it("null is NOT zero — it is 'nobody measured this'", () => {
    // Pinned because the two behave identically here TODAY, and the reason
    // they do is the `?? 0`. If a future edit makes `null` mean anything else,
    // this row says which reading was intended.
    expect(resolveWorkLead({ owedCount: null, gradeOwed: false })).toBe(
      resolveWorkLead({ owedCount: 0, gradeOwed: false })
    );
  });
});
