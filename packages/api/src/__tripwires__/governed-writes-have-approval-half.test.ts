/**
 * TRIPWIRE — every governed write door must have its approval half.
 *
 * A mutation that calls `checkPermissionOrPropose` can return
 * `{ status: "proposed" }`. If no executor is registered for that
 * `${targetType}/${proposalType}` key, approving the proposal falls to the `*​/*`
 * catch-all and throws NOT_IMPLEMENTED: the reviewer clicks approve, the
 * proposal closes, and NOTHING HAPPENS. The write silently exists only on the
 * ungoverned path.
 *
 * This has now happened three times in this codebase (`project/update`,
 * `playbook/update`, and the create-side variant where the gate carried only
 * `{ name }` so an approved create materialized an empty shell). It is invisible
 * to typecheck, to every direct-path test, and to any test that exercises the
 * human path — because the human path never proposes.
 *
 * The `EXACT` list below is deliberately NOT derived from the registry (that
 * would make the test vacuous — it would pass for whatever happens to be
 * registered). It is the hand-maintained set of keys we assert must exist.
 * Adding a governed door means adding its key here AND writing the executor.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { proposalExecRegistry } from "../routers/proposals/execution-registry.js";
import { registerApproveExecutors } from "../routers/proposals/approve-executors.js";

/**
 * Governed write doors whose approval half must resolve to a REAL executor —
 * never the wildcard. Each entry is a `${targetType}/${proposalType}` key.
 */
const MUST_HAVE_EXACT_EXECUTOR = [
  "project/create",
  "project/update",
  "project/archive",
  "playbook/create",
  "playbook/update",
  "playbook/promote",
] as const;

describe("governed write doors have an approval half", () => {
  beforeAll(() => {
    registerApproveExecutors();
  });

  it.each(MUST_HAVE_EXACT_EXECUTOR)(
    "%s resolves to an exact executor, not the catch-all",
    (key) => {
      // resolveExact, NOT resolve: `resolve` falls through to the wildcard, so
      // asserting on it would pass for a key with no executor at all — the very
      // condition this tripwire exists to catch.
      const exact = proposalExecRegistry.resolveExact(key);
      expect(
        exact,
        `No approve executor registered for "${key}". A proposal for this door ` +
          `would hit the */* catch-all and throw NOT_IMPLEMENTED on approval — ` +
          `the reviewer approves and nothing happens. Register an executor in ` +
          `routers/proposals/executors/.`
      ).toBeDefined();
      expect(typeof exact?.execute).toBe("function");
    }
  );

  it("proves the assertion can fail — an unregistered key resolves to nothing", () => {
    // Guards against the tripwire silently becoming vacuous (e.g. if a future
    // change made `resolveExact` fall back to the wildcard).
    expect(
      proposalExecRegistry.resolveExact("nonexistent-target/nonexistent-action")
    ).toBeUndefined();
  });
});
