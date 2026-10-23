import { describe, it, expect } from "vitest";
import {
  AIM_LABEL,
  SPACE_BRIEF_FIELD_LABELS,
  resolveObjectNoun,
  resolveObjectNounPlural,
  resolveSpaceBriefFieldLabel,
} from "./index.js";
import { LENS_SECTION_LABELS } from "../lens/classes.js";
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
    expect(resolveSpaceBriefFieldLabel("doneWhen")).toBe("Success looks like");
    expect(resolveSpaceBriefFieldLabel("goal")).toBe("Interview aim");
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

  it("no brief label reuses a word the goal page owns (Goal, Aim, Done when)", () => {
    // A space brief and a goal sit on one pod: the brief's "goal"/"doneWhen"
    // fields mean the onboarding interview, never a goal (W5, 2026-10-23).
    const taken = new Set(
      [
        resolveObjectNoun("track"),
        resolveObjectNounPlural("track"),
        AIM_LABEL,
        ...Object.values(LENS_SECTION_LABELS),
      ].map((w) => w.toLowerCase())
    );
    const labels = Object.values(SPACE_BRIEF_FIELD_LABELS);
    expect(labels.length).toBeGreaterThan(8); // non-vacuity
    expect(labels.filter((l) => taken.has(l.toLowerCase()))).toEqual([]);
    // …and the brief's own labels never repeat each other.
    expect(new Set(labels.map((l) => l.toLowerCase())).size).toBe(
      labels.length
    );
  });

  it("an unknown key humanizes, never leaks", () => {
    expect(resolveSpaceBriefFieldLabel("someNewField")).toBe("Some new field");
    expect(resolveSpaceBriefFieldLabel(null)).toBe("");
  });
});
