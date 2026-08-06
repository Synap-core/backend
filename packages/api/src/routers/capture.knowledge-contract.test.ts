import { describe, expect, it } from "vitest";
import { normalizeCapturedKnowledgeProperties } from "./capture.js";

describe("Knowledge capture contract", () => {
  it("preserves legacy classification while deriving the canonical form", () => {
    expect(
      normalizeCapturedKnowledgeProperties(
        { ek_type: "gotcha", ek_claim: "A brittle path" },
        "A brittle path"
      )
    ).toEqual({
      ek_type: "gotcha",
      ek_claim: "A brittle path",
      knowledgeForm: "caution",
    });
  });

  it("gives new unclassified knowledge a canonical form", () => {
    expect(
      normalizeCapturedKnowledgeProperties({}, "A useful reusable fact")
    ).toEqual({ knowledgeForm: "insight" });
  });

  it("rejects conflicting canonical and recognized legacy forms", () => {
    expect(() =>
      normalizeCapturedKnowledgeProperties(
        { knowledgeForm: "insight", ek_type: "gotcha" },
        "A useful fact"
      )
    ).toThrow("conflicts with legacy ek_type");
  });
});
