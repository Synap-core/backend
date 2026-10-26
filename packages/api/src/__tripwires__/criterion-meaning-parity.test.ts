/**
 * TRIPWIRE — a criterion's R5 meaning and R7 `about` are ONE closed set each.
 *
 * The words and their mapping live in `@synap-core/types/units`
 * (`CRITERION_CHECK_MEANINGS`, `CHECK_MEANING_EVALUATORS`, `CRITERION_ABOUT`).
 * The criterion READER lives in `@synap/playbooks` (`readCriteria`), which is
 * dependency-free and so mirrors the two lists to validate what it reads.
 * Neither package may import the other, so the two are pinned equal HERE, in
 * `@synap/api`, the first package that depends on both.
 *
 * Without this, a seventh meaning added on the types side reads back as
 * DROPPED by `readCriteria` (it keeps only values it knows) — the criterion
 * survives, its meaning silently vanishes on every read. That is the exact
 * defect the reader's "learn the new fields" fix exists to stop.
 *
 * Also pins the MAPPING to the stored evaluator set: every meaning maps to at
 * least one evaluator the criterion reader accepts (`CRITERION_CHECK_KINDS`),
 * so a meaning can never be declared that no stored check can carry.
 */
import { describe, it, expect } from "vitest";
import {
  CRITERION_ABOUT as READER_ABOUT,
  CRITERION_CHECK_KINDS,
  CRITERION_CHECK_MEANINGS as READER_MEANINGS,
  readCriteria,
} from "@synap/playbooks";
import {
  CHECK_MEANING_EVALUATORS,
  CRITERION_ABOUT,
  CRITERION_CHECK_MEANINGS,
} from "@synap-core/types/units";
import {
  CRITERION_CHECK_MEANING_LABELS,
  resolveCriterionCheckMeaningLabel,
} from "@synap-core/types/vocabulary";

describe("criterion meaning (R5) and about (R7) — reader ↔ types parity", () => {
  it("the reader's meanings are exactly the shared ones", () => {
    expect([...READER_MEANINGS].sort()).toEqual(
      [...CRITERION_CHECK_MEANINGS].sort()
    );
    // Non-vacuity: R5 names six kinds of check.
    expect(CRITERION_CHECK_MEANINGS.length).toBe(6);
  });

  it("the reader's `about` values are exactly the shared ones", () => {
    expect([...READER_ABOUT].sort()).toEqual([...CRITERION_ABOUT].sort());
  });

  it("every meaning maps onto stored evaluator kinds the reader accepts", () => {
    for (const m of CRITERION_CHECK_MEANINGS) {
      const evaluators: readonly string[] = CHECK_MEANING_EVALUATORS[m];
      expect(evaluators.length).toBeGreaterThan(0);
      for (const e of evaluators) {
        expect(CRITERION_CHECK_KINDS as readonly string[]).toContain(e);
      }
    }
  });

  it("every meaning survives the reader (the seam, not the list)", () => {
    for (const checkKind of CRITERION_CHECK_MEANINGS) {
      const [c] = readCriteria([
        {
          key: "k",
          statement: "s",
          check: { kind: "human" },
          checkKind,
          about: "method",
        },
      ]);
      expect(c?.checkKind).toBe(checkKind);
      expect(c?.about).toBe("method");
    }
  });

  it("every meaning has its own row in the vocabulary", () => {
    expect(
      CRITERION_CHECK_MEANINGS.filter(
        (m) => !Object.hasOwn(CRITERION_CHECK_MEANING_LABELS, m)
      )
    ).toEqual([]);
    expect(resolveCriterionCheckMeaningLabel("judged")).toBe(
      "Judged by a person"
    );
  });
});
