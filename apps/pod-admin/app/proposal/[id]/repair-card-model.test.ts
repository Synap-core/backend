import { describe, expect, it } from "vitest";
import { pickAct, repairRows, REPAIR_CHOICES_CAP } from "./repair-card-model";

const CATEGORIES = [
  "working_style",
  "communication",
  "focus",
  "preferences",
  "habits",
  "technical",
];

describe("repairRows", () => {
  it("a near-miss value: one press uses the value it meant, and nothing is added", () => {
    const [row] = repairRows([
      {
        key: "uo_category",
        label: "Category",
        kind: "not_in_options",
        message: "Property 'uo_category': Value 'preference' not in enum",
        rejected: ["preference"],
        options: CATEGORIES,
        didYouMean: "preferences",
        canAddOption: false,
        addOptionRefusal: "close_match",
      },
    ]);
    expect(row!.suggested).toEqual({
      value: "preferences",
      act: { set: { uo_category: "preferences" } },
    });
    expect(row!.choices[0]).toBe("preferences");
    expect(row!.choices).toHaveLength(CATEGORIES.length);
    expect(row!.add).toBeUndefined();
    expect(row!.note).toBeUndefined();
  });

  it("a new idea: offers to add it, which also sets it", () => {
    const [row] = repairRows([
      {
        key: "uo_category",
        label: "Category",
        kind: "not_in_options",
        message: "m",
        rejected: ["rituals"],
        options: CATEGORIES,
        canAddOption: true,
      },
    ]);
    expect(row!.suggested).toBeUndefined();
    expect(row!.add).toEqual({
      value: "rituals",
      act: {
        addOption: { key: "uo_category", value: "rituals" },
        set: { uo_category: "rituals" },
      },
    });
    expect(pickAct(row!, "habits")).toEqual({ set: { uo_category: "habits" } });
  });

  it("a field with no closed set says the pod's sentence and offers no choice", () => {
    const [row] = repairRows([
      {
        key: "storageKey",
        label: "Storage key",
        kind: "required",
        message: "Property 'storageKey' is required",
        canAddOption: false,
      },
    ]);
    expect(row!.choices).toEqual([]);
    expect(row!.add).toBeUndefined();
    expect(row!.note).toBe("Property 'storageKey' is required");
  });

  it("caps a long choice list", () => {
    const options = Array.from({ length: 40 }, (_, i) => `o${i}`);
    const [row] = repairRows([
      {
        key: "k",
        label: "K",
        kind: "not_in_options",
        message: "m",
        rejected: ["x"],
        options,
        canAddOption: false,
      },
    ]);
    expect(row!.choices).toHaveLength(REPAIR_CHOICES_CAP);
  });
});
