import { describe, it, expect } from "vitest";
import {
  SPACE_BRIEF_FIELD_LABELS,
  resolveSpaceBriefFieldLabel,
} from "./index.js";
import {
  SPACE_BRIEF_APPLIER_OWNED_FIELDS,
  SPACE_BRIEF_TEMPLATE_FIELDS,
} from "../space-brief/index.js";

describe("space brief field labels (vocabulary door)", () => {
  it("names the fields a reader could not decode from the storage key", () => {
    expect(resolveSpaceBriefFieldLabel("framing")).toBe("Persona");
    expect(resolveSpaceBriefFieldLabel("collect")).toBe("Kinds to collect");
    expect(resolveSpaceBriefFieldLabel("openingQuestions")).toBe(
      "Opening questions"
    );
    expect(resolveSpaceBriefFieldLabel("doneWhen")).toBe("Done when");
    expect(resolveSpaceBriefFieldLabel("purpose")).toBe("Purpose");
    expect(resolveSpaceBriefFieldLabel("anchors")).toBe("Read first");
    expect(resolveSpaceBriefFieldLabel("rules")).toBe("Rules");
  });

  it("every brief field (derived from the brief's own field sets) is labelled", () => {
    const fields = [
      ...SPACE_BRIEF_TEMPLATE_FIELDS,
      ...SPACE_BRIEF_APPLIER_OWNED_FIELDS,
    ];
    expect(fields.length).toBeGreaterThan(8); // non-vacuity
    expect(Object.keys(SPACE_BRIEF_FIELD_LABELS).sort()).toEqual(
      [...fields].sort()
    );
  });

  it("an unknown key humanizes, never leaks", () => {
    expect(resolveSpaceBriefFieldLabel("someNewField")).toBe("Some new field");
    expect(resolveSpaceBriefFieldLabel(null)).toBe("");
  });
});
