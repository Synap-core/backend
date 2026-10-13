/**
 * `isSystemReasoning` — the pod's own "why" sentences are told apart from a
 * proposer's words. Every sentence is built by the SAME builder the gate uses
 * (`permission-check.ts`), so a reworded builder fails here, not on a page.
 */
import { describe, expect, it } from "vitest";
import {
  GOVERNANCE_POLICY_SENTENCES,
  defaultApprovalSentence,
  isSystemReasoning,
  roleExceedSentence,
} from "../governance-policy-sentences.js";

describe("isSystemReasoning", () => {
  it("recognises the placeholder and both role-exceed sentences", () => {
    expect(isSystemReasoning(defaultApprovalSentence("create", "entity"))).toBe(true);
    expect(isSystemReasoning(defaultApprovalSentence("renderer.set", "profile"))).toBe(true);
    for (const proposer of ["agent", "person"] as const) {
      expect(
        isSystemReasoning(
          roleExceedSentence({
            action: "delete",
            subjectType: "entity",
            role: "editor",
            proposer,
          })
        )
      ).toBe(true);
    }
  });

  it("recognises every governance policy sentence", () => {
    for (const s of Object.values(GOVERNANCE_POLICY_SENTENCES)) {
      expect(isSystemReasoning(s)).toBe(true);
    }
  });

  it("keeps a proposer's words — including ones that mention approval or roles", () => {
    expect(isSystemReasoning("Standardise how we score tools")).toBe(false);
    expect(
      isSystemReasoning("The client asked for this; it requires your approval")
    ).toBe(false);
    expect(
      isSystemReasoning("This exceeds your workspace role, so I asked first")
    ).toBe(false);
    expect(isSystemReasoning(undefined)).toBe(false);
    expect(isSystemReasoning("")).toBe(false);
  });
});
