/**
 * TRIPWIRE — every runner state has a label in the vocabulary SSOT, and no
 * label names a state that does not exist.
 *
 * The state set lives in `@synap/database` (`RUNNER_STATES`, the write context
 * that records what a harness's runner is doing). The words live in
 * `@synap-core/types/vocabulary` (`RUNNER_STATE_LABELS`). Types may not depend
 * on database, so the two are kept in lock-step HERE, in `@synap/api`, the
 * first package that reads both — the same pattern as
 * `blocked-reason-vocabulary-parity.test.ts`.
 *
 * Without it, a fifth runner state would reach a person as a humanized token
 * ("Needs input") that nobody wrote (review of wave 065982de, slop lens).
 */
import { describe, it, expect } from "vitest";
import { RUNNER_STATES } from "@synap/database";
import { RUNNER_STATE_LABELS } from "@synap-core/types/vocabulary";

describe("runner state ↔ vocabulary parity", () => {
  // A key check, not "label !== humanizeToken(state)": "Idle" and "Ended"
  // ARE the humanized tokens, so comparing words would flag correct labels.
  it("gives every runner state an EXPLICIT label, never the humanize fallback", () => {
    const missing = RUNNER_STATES.filter(
      (s) => !Object.hasOwn(RUNNER_STATE_LABELS, s)
    );
    expect(missing).toEqual([]);
  });

  it("has no label for a state that is not in the closed set", () => {
    const known = new Set<string>(RUNNER_STATES);
    const orphans = Object.keys(RUNNER_STATE_LABELS).filter(
      (k) => !known.has(k)
    );
    expect(orphans).toEqual([]);
  });
});
