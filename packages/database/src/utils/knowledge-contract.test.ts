import { describe, expect, it } from "vitest";
import {
  completeKnowledgeClaim,
  completeKnowledgeProperties,
  KNOWLEDGE_FORMS,
  KnowledgeFormConflictError,
  inferKnowledgeForm,
  isKnowledgeForm,
  normalizeKnowledgeProperties,
  projectKnowledgeProperties,
} from "./knowledge-contract.js";

describe("Knowledge contract", () => {
  it.each([
    ["lesson", "fact"],
    ["gotcha", "caution"],
    ["decision", "fact"],
    ["reference", "fact"],
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
        knowledgeForm: "fact",
      })
    ).toThrow(KnowledgeFormConflictError);
    // The legacy alias is checked AFTER it becomes `fact`: still a conflict.
    expect(() =>
      normalizeKnowledgeProperties({
        ek_type: "gotcha",
        knowledgeForm: "insight",
      })
    ).toThrow(KnowledgeFormConflictError);
    expect(
      projectKnowledgeProperties({
        ek_type: "gotcha",
        knowledgeForm: "fact",
      })
    ).toEqual({ ek_type: "gotcha", knowledgeForm: "fact" });
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
    ).toBe("fact");
  });

  it("completes historic unclassified writes without overriding legacy data", () => {
    expect(
      completeKnowledgeProperties({}, "Avoid this known failure mode")
    ).toEqual({
      knowledgeForm: "caution",
      ek_claim: "Avoid this known failure mode",
    });
    expect(
      completeKnowledgeProperties({ ek_type: "lesson" }, "Avoid this")
    ).toEqual({
      ek_type: "lesson",
      knowledgeForm: "fact",
      ek_claim: "Avoid this",
    });
  });

  it("is exactly fact | caution | convention", () => {
    expect([...KNOWLEDGE_FORMS]).toEqual(["fact", "caution", "convention"]);
    expect(isKnowledgeForm("convention")).toBe(true);
    expect(isKnowledgeForm("insight")).toBe(false);
  });

  it("reads and writes a stored or sent `insight` as `fact`, never rejects it", () => {
    expect(normalizeKnowledgeProperties({ knowledgeForm: "insight" })).toEqual({
      knowledgeForm: "fact",
    });
    expect(projectKnowledgeProperties({ knowledgeForm: "insight" })).toEqual({
      knowledgeForm: "fact",
    });
    expect(
      normalizeKnowledgeProperties({
        ek_type: "lesson",
        knowledgeForm: "insight",
      })
    ).toEqual({ ek_type: "lesson", knowledgeForm: "fact" });
  });

  it("accepts convention as given and leaves an invalid form for the validator", () => {
    expect(
      normalizeKnowledgeProperties({ knowledgeForm: "convention" })
    ).toEqual({ knowledgeForm: "convention" });
    // Not a form and not an alias: untouched, so the enum check rejects it.
    expect(normalizeKnowledgeProperties({ knowledgeForm: "lesson" })).toEqual({
      knowledgeForm: "lesson",
    });
    expect(isKnowledgeForm("lesson")).toBe(false);
  });

  it("derives a missing claim from the first candidate, never overriding one", () => {
    expect(
      completeKnowledgeClaim({}, [undefined, "  ", "Title line\nbody"])
    ).toEqual({ ek_claim: "Title line" });
    expect(completeKnowledgeClaim({ ek_claim: "Mine" }, ["Title"])).toEqual({
      ek_claim: "Mine",
    });
    expect(completeKnowledgeClaim({ ek_claim: " " }, ["Title"])).toEqual({
      ek_claim: "Title",
    });
    // Nothing usable: stays absent so validation names the missing claim.
    expect(completeKnowledgeClaim({}, [undefined, ""])).toEqual({});
    expect(
      completeKnowledgeProperties({}, "body text", ["The title", "body text"])
    ).toEqual({ knowledgeForm: "fact", ek_claim: "The title" });
  });
});
