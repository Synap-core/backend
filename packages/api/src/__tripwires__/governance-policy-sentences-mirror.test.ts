/**
 * TRIPWIRE — `GOVERNANCE_POLICY_SENTENCES` (@synap-core/types/proposals) is a
 * mirror of `PROPOSE_REASON` (@synap/governance-policy): a reader uses it to
 * stop the policy's sentence being drawn as a proposer's reasoning on rows
 * written before the pod stopped storing it there. A sentence edited on one
 * side only would silently start leaking again — so this compares the two
 * OBJECTS, key for key and word for word, by importing both (no source scan).
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

describe("governance policy sentences — the types mirror equals the engine", () => {
  it("has exactly PROPOSE_REASON's keys and sentences", () => {
    expect(GOVERNANCE_POLICY_SENTENCES).toEqual(PROPOSE_REASON);
  });

  it("recognises every engine sentence, and not a proposer's words", () => {
    const sentences = Object.values(PROPOSE_REASON);
    expect(sentences.length).toBeGreaterThan(10);
    for (const s of sentences) expect(isGovernancePolicySentence(s)).toBe(true);
    expect(isGovernancePolicySentence("Standardise how we score tools")).toBe(false);
    expect(isGovernancePolicySentence(undefined)).toBe(false);
  });
});
