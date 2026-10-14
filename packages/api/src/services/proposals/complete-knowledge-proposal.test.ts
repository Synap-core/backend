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
    ).toEqual({
      knowledgeForm: "caution",
      ek_claim: "Avoid this production failure",
    });
  });

  it("derives the claim from the title first, then description and body", () => {
    expect(
      completeKnowledgeProposalProperties({
        profileSlug: "knowledge",
        properties: { knowledgeForm: "fact" },
        title: undefined,
        description: "Description sentence",
        content: "Body",
      })
    ).toEqual({ knowledgeForm: "fact", ek_claim: "Description sentence" });
  });

  it("preserves legacy classification and leaves other kinds untouched", () => {
    expect(
      completeKnowledgeProposalProperties({
        profileSlug: "knowledge",
        properties: { ek_type: "lesson" },
        title: "Avoid this",
      })
    ).toEqual({
      ek_type: "lesson",
      knowledgeForm: "fact",
      ek_claim: "Avoid this",
    });
    expect(
      completeKnowledgeProposalProperties({
        profileSlug: "task",
        properties: undefined,
        title: "Avoid this",
      })
    ).toBeUndefined();
  });
});
