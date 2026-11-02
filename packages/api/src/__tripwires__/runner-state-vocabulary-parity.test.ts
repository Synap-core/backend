/**
 * TRIPWIRE — every runner state has a label in the vocabulary SSOT, and no
 * label names a state that does not exist.
 *
 * The state set and its one order live in `@synap-core/types/units`
 * (`RUNNER_STATES`, `RUNNER_STATE_WAIT_KIND`, sessions cockpit C4);
 * `@synap/database` re-exports the set for the write context that records
 * what a harness's runner is doing. The words live in
 * `@synap-core/types/vocabulary` (`RUNNER_STATE_LABELS`, now typed on every
 * state, so a missing label also stops the build). This keeps the runtime
 * check, and pins that the database's set IS the types' set (one list, never
 * a copy) — the same pattern as `blocked-reason-vocabulary-parity.test.ts`.
 *
 * Without it, a sixth runner state would reach a person as a humanized token
 * ("Needs input") that nobody wrote (review of wave 065982de, slop lens).
 */
import { describe, it, expect } from "vitest";
import { RUNNER_STATES } from "@synap/database";
import {
  RUNNER_STATES as TYPES_RUNNER_STATES,
  RUNNER_STATE_ORDER,
} from "@synap-core/types/units";
import { RUNNER_STATE_LABELS } from "@synap-core/types/vocabulary";

describe("runner state ↔ vocabulary parity", () => {
  it("reads ONE state set: the database's is the types' own list", () => {
    expect([...RUNNER_STATES]).toEqual([...TYPES_RUNNER_STATES]);
    // Every live word is in the one order; `ended` is not.
    expect([...RUNNER_STATE_ORDER].sort()).toEqual(
      RUNNER_STATES.filter((s) => s !== "ended").sort()
    );
  });

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
