import { describe, expect, it } from "vitest";
import { buildProposalChanges } from "./changes.js";

/**
 * The generic fallback runs for EVERY payload's uncovered keys (wave 5, S6).
 * It used to fire only when the entity-shape walk had emitted nothing, so a
 * session update that renamed its title AND rewrote its criteria / expected
 * outputs reached the card as a title-only diff.
 */
describe("buildProposalChanges — uncovered keys always render, plumbing never", () => {
  it("a title edit no longer hides the criteria and outputs beside it", () => {
    const criteria = [{ label: "Draft approved" }];
    const expectedOutputs = [{ kind: "document", label: "Spec" }];
    const paths = buildProposalChanges(
      { title: "Ship v2", criteria, expectedOutputs },
      "update"
    ).map((c) => c.path);
    expect(paths).toEqual(["title", "criteria", "expectedOutputs"]);
  });

  it("strips pod plumbing and never repeats an entity-shape key", () => {
    const paths = buildProposalChanges(
      {
        title: "Acme",
        properties: { stage: "won" },
        _autoApprove: { approvedBy: "system:auto_approve" },
        _meta: { intent: "x" },
        authorshipMode: "agent",
        materialized: true,
        sessionSource: "mcp",
        agentUserId: "a1",
        expectedLabel: "Spec",
        expectedKey: "spec",
        policyReason: "Auto-approved by rule",
        governanceReason: "rule",
        entityId: "e1",
      },
      "update"
    ).map((c) => c.path);
    expect(paths).toEqual(["title", "properties.stage"]);
  });

  it("a payload with no entity-shape key still renders every key (unchanged)", () => {
    const paths = buildProposalChanges(
      { slug: "budget", valueType: "number" },
      "create"
    ).map((c) => c.path);
    expect(paths).toEqual(["slug", "valueType"]);
  });
});
