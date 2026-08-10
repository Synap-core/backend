import { describe, expect, it } from "vitest";
import {
  completeKnowledgeProperties,
  KnowledgeFormConflictError,
  inferKnowledgeForm,
  normalizeKnowledgeProperties,
  projectKnowledgeProperties,
} from "./knowledge-contract.js";

describe("Knowledge contract", () => {
  it.each([
    ["lesson", "insight"],
    ["gotcha", "caution"],
    ["decision", "insight"],
    ["reference", "insight"],
  ])("maps legacy %s without dropping it", (legacy, form) => {
    expect(normalizeKnowledgeProperties({ ek_type: legacy })).toEqual({
      ek_type: legacy,
      knowledgeForm: form,
    });
  });

  it("does not overwrite an explicit form or hide an invalid client value", () => {
    expect(
      normalizeKnowledgeProperties({
        ek_type: "gotcha",
        knowledgeForm: "caution",
      })
    ).toEqual({ ek_type: "gotcha", knowledgeForm: "caution" });
    expect(
      normalizeKnowledgeProperties({
        ek_type: "lesson",
        knowledgeForm: "wrong",
      })
    ).toEqual({ ek_type: "lesson", knowledgeForm: "wrong" });
  });

  it("rejects conflicting active and recognized legacy classifications", () => {
    expect(() =>
      normalizeKnowledgeProperties({
        ek_type: "gotcha",
        knowledgeForm: "insight",
      })
    ).toThrow(KnowledgeFormConflictError);
    expect(
      projectKnowledgeProperties({
        ek_type: "gotcha",
        knowledgeForm: "insight",
      })
    ).toEqual({ ek_type: "gotcha", knowledgeForm: "insight" });
  });

  it("does not manufacture a form from an unknown legacy value", () => {
    expect(normalizeKnowledgeProperties({ ek_type: "custom" })).toEqual({
      ek_type: "custom",
    });
  });

  it("uses caution only for explicit warning/failure language", () => {
    expect(inferKnowledgeForm("Avoid this failure mode")).toBe("caution");
    expect(
      inferKnowledgeForm("A useful conclusion from the investigation")
    ).toBe("insight");
  });

  it("completes historic unclassified writes without overriding legacy data", () => {
    expect(
      completeKnowledgeProperties({}, "Avoid this known failure mode")
    ).toEqual({ knowledgeForm: "caution" });
    expect(
      completeKnowledgeProperties({ ek_type: "lesson" }, "Avoid this")
    ).toEqual({ ek_type: "lesson", knowledgeForm: "insight" });
  });
});
