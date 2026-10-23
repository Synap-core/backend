/**
 * `isSystemReasoning` — the pod's own "why" sentences are told apart from a
 * proposer's words. Every sentence is built by the SAME builder the gate uses
 * (`permission-check.ts`), so a reworded builder fails here, not on a page.
 */
import { describe, expect, it } from "vitest";
import {
  GOVERNANCE_POLICY_SENTENCES,
  automationMovesSentence,
  automationProposedSentence,
  automationWriteSentence,
  defaultApprovalSentence,
  isSystemReasoning,
  roleExceedSentence,
  ruleBatchRunSentence,
  ruleRunSentence,
} from "../governance-policy-sentences.js";

describe("isSystemReasoning", () => {
  it("recognises the placeholder and both role-exceed sentences", () => {
    expect(isSystemReasoning(defaultApprovalSentence("create", "entity"))).toBe(
      true
    );
    expect(
      isSystemReasoning(defaultApprovalSentence("renderer.set", "profile"))
    ).toBe(true);
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

  it("still recognises the wording rows written before 2026-10-21 carry", () => {
    for (const s of [
      "Agent requires proposal for all write operations.",
      "Teammate may propose in this channel; write requires human approval.",
      "This agent has reached its daily auto-execute write ceiling; further writes require human approval today.",
      "This runs an arbitrary shell command inside the pod's API container and always requires human approval; no governance rule can widen it.",
    ]) {
      expect(isSystemReasoning(s)).toBe(true);
    }
  });

  it("writes each sentence for the person: one sentence, no engine vocabulary", () => {
    const jargon =
      /requires? human|human approval|ceiling|container|arbitrary|governance rule|\bpod's API|\bwrite operations?\b|—/i;
    for (const [code, s] of Object.entries(GOVERNANCE_POLICY_SENTENCES)) {
      expect(s, code).not.toMatch(jargon);
      expect(s.match(/[.;]/g)?.length, `${code} is one sentence`).toBe(1);
    }
  });

  it("recognises the automation gate's defaults, built by the writers' builders", () => {
    const sentences = [
      ruleRunSentence(),
      ruleBatchRunSentence({
        who: "Ada, Grace + 2 more",
        what: '"Qualify a lead"',
      }),
      ruleBatchRunSentence({ who: "4 new leads", what: "this playbook" }),
      automationWriteSentence(),
      automationProposedSentence("creating an entity"),
      automationProposedSentence("updating a focus session"),
      automationMovesSentence("leadStage", "qualified"),
    ];
    for (const s of sentences) expect(isSystemReasoning(s)).toBe(true);
  });

  it("keeps a person's reason that only sounds like an automation", () => {
    expect(
      isSystemReasoning("Automation proposed this because Ada asked twice")
    ).toBe(false);
    expect(
      isSystemReasoning("A rule matched, but I also want a second look")
    ).toBe(false);
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
