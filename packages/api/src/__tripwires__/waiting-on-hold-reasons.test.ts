/**
 * TRIPWIRE — every hold says what it waits on, row by row (decision D4).
 *
 * `HOLD_ON` (`@synap-core/types/lifecycle`) is the closed set of what a pause
 * waits on; `HOLD_ON_WAITING_ON` (`@synap-core/types/units`) maps each one to
 * a waiting-on reason, or to `null` (no mark). The type pins that every value
 * has a row; this pins WHICH row, because the wrong reason types as well as
 * the right one: a hold on a person read as "other work" would send the
 * person's wait to an agent's lane, and a `nobody` park counted as a wait
 * would make every deliberate pause look blocked.
 *
 * Behavioural: the mapping FUNCTION is driven (`waitingOnReasonOf` through
 * `deriveWaitingOn`), not only the table read.
 */
import { describe, it, expect } from "vitest";
import { HOLD_ON } from "@synap-core/types/lifecycle";
import {
  deriveWaitingOn,
  HOLD_ON_WAITING_ON,
  WAITING_ON_REASONS,
  waitingOnReasonOf,
} from "@synap-core/types/units";
import { WAITING_ON_REASON_LABELS } from "@synap-core/types/vocabulary";

/** The decision, spelled out once more on purpose: a change here is a decision. */
const DECIDED = {
  person: "input",
  agent: "another_work",
  external: "external",
  thing: "another_work",
  decision: "input",
  date: "date",
  nobody: null,
  unspecified: null,
} as const;

describe("holds ↔ waiting-on reasons", () => {
  it("every hold value has its own row, and the table names nothing else", () => {
    expect(Object.keys(HOLD_ON_WAITING_ON).sort()).toEqual([...HOLD_ON].sort());
    // Non-vacuity: the closed set is the eight it was built from.
    expect(HOLD_ON.length).toBeGreaterThanOrEqual(8);
  });

  it("each hold maps to the decided reason, through the mapping function", () => {
    for (const on of HOLD_ON) {
      expect(waitingOnReasonOf({ kind: "hold", on })).toBe(DECIDED[on]);
    }
  });

  it("a mapped reason is a real reason with words; nobody and unspecified make no mark", () => {
    for (const reason of Object.values(HOLD_ON_WAITING_ON)) {
      if (reason === null) continue;
      expect(WAITING_ON_REASONS).toContain(reason);
      expect(Object.hasOwn(WAITING_ON_REASON_LABELS, reason)).toBe(true);
    }
    expect(
      deriveWaitingOn([
        { kind: "hold", on: "nobody" },
        { kind: "hold", on: "unspecified" },
      ])
    ).toEqual([]);
  });
});
