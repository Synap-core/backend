/**
 * Every reason the engine can propose with has its OWN rung token — never the
 * catch-all "default" (which is only "no reason given", rung 9). The set is
 * DERIVED from `PROPOSE_REASON`, so a new reason without a `reasonToRung` case
 * fails here; until 2026-10-14 four floors (human gate, arbitrary execution,
 * human-only status, lifecycle terminal) silently read as "default".
 *
 * Does not cover: reasons the engine emits outside `PROPOSE_REASON` (the
 * channel / capability block strings), which are `deny`, not `propose`.
 */
import { describe, expect, it } from "vitest";
import { PROPOSE_REASON } from "@synap/governance-policy";
import { reasonToRung } from "./resolve-agent-governance-decision.js";

const reasons = Object.entries(PROPOSE_REASON);

describe("reasonToRung names every propose reason", () => {
  it("sees the engine's reasons (non-vacuity)", () => {
    expect(reasons.length).toBeGreaterThanOrEqual(18);
  });

  // That each token has WORDS is the api tripwire's job
  // (`governance-rungs.tripwire.test.ts` scans this function's literals
  // against `GOVERNANCE_RUNGS`); this package does not depend on the types.
  it.each(reasons)("%s has its own rung", (_key, reason) => {
    expect(reasonToRung(reason)).not.toBe("default");
  });

  it("no two reasons share a rung", () => {
    const rungs = reasons.map(([, r]) => reasonToRung(r));
    expect(new Set(rungs).size).toBe(rungs.length);
  });

  it("no reason given is the default", () => {
    expect(reasonToRung("something else")).toBe("default");
  });
});
