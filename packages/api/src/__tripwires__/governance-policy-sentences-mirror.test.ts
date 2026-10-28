/**
 * TRIPWIRE — the engine's `PROPOSE_REASON` (@synap/governance-policy) IS
 * `GOVERNANCE_POLICY_SENTENCES` (@synap-core/types/proposals): one declaration
 * (a mirror until 2026-10-26). A reader uses it to stop the policy's sentence
 * being drawn as a proposer's reasoning on rows written before the pod stopped
 * storing it there, so a second copy edited on one side only would silently
 * start leaking again. This fails the moment the engine holds its own object.
 *
 * WHAT IT CANNOT SEE: both imports resolve to the packages' built `dist`, so an
 * edit to either `src` is compared only after that package is rebuilt.
 */
import { describe, expect, it } from "vitest";
import { PROPOSE_REASON } from "@synap/governance-policy";
import {
  GOVERNANCE_POLICY_SENTENCES,
  isGovernancePolicySentence,
} from "@synap-core/types/proposals";

describe("governance policy sentences — the engine reads the types object", () => {
  it("PROPOSE_REASON is GOVERNANCE_POLICY_SENTENCES, not a copy", () => {
    expect(PROPOSE_REASON).toBe(GOVERNANCE_POLICY_SENTENCES);
  });

  it("recognises every engine sentence, and not a proposer's words", () => {
    const sentences = Object.values(PROPOSE_REASON);
    expect(sentences.length).toBeGreaterThan(10);
    for (const s of sentences) expect(isGovernancePolicySentence(s)).toBe(true);
    expect(isGovernancePolicySentence("Standardise how we score tools")).toBe(
      false
    );
    expect(isGovernancePolicySentence(undefined)).toBe(false);
  });
});
