import { describe, expect, it } from "vitest";
import { completeKnowledgeProposalProperties } from "./complete-knowledge-proposal.js";

describe("completeKnowledgeProposalProperties", () => {
  it("repairs an old unclassified Knowledge proposal before approval", () => {
    expect(
      completeKnowledgeProposalProperties({
        profileSlug: "knowledge",
        properties: undefined,
        title: "Avoid this production failure",
      })
    ).toEqual({ knowledgeForm: "caution" });
  });

  it("preserves legacy classification and leaves other kinds untouched", () => {
    expect(
      completeKnowledgeProposalProperties({
        profileSlug: "knowledge",
        properties: { ek_type: "lesson" },
        title: "Avoid this",
      })
    ).toEqual({ ek_type: "lesson", knowledgeForm: "insight" });
    expect(
      completeKnowledgeProposalProperties({
        profileSlug: "task",
        properties: undefined,
        title: "Avoid this",
      })
    ).toBeUndefined();
  });
});
