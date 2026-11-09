import { describe, expect, it } from "vitest";
import { filterChipFace, filterMenuItems } from "./filter-chip-model";
import { kindOption, statusOption } from "./filter-options";

describe("statusOption", () => {
  it("gives a failed status a glyph and the down tone, words from the vocabulary", () => {
    const o = statusOption("failed");
    expect(o.icon).toBeDefined();
    expect(o.tone).toBe("down");
    expect(o.label.length).toBeGreaterThan(0);
  });
  it("tones the console's filter keys, and keeps the page's own words", () => {
    expect(statusOption("running").tone).toBe("healthy");
    expect(statusOption("stuck").tone).toBe("stale");
    expect(statusOption("paused").tone).toBe("unknown");
    expect(statusOption("chat", { label: "Failed AI turns" }).label).toBe(
      "Failed AI turns"
    );
  });
  it("an unknown key still draws a glyph, never nothing", () => {
    expect(statusOption("zzz-unknown").icon).toBeDefined();
  });
});

describe("kindOption", () => {
  it("carries the kind's icon and a design-token colour, never a literal", () => {
    const o = kindOption("task", { count: 3 });
    expect(o.icon).toBeDefined();
    expect(o.color).toMatch(/^var\(--synap-/);
    expect(o.count).toBe(3);
  });
  it("a kind the registry lacks still gets a stable token colour", () => {
    expect(kindOption("my-custom-kind").color).toMatch(/^var\(--synap-/);
    expect(kindOption("my-custom-kind").color).toBe(
      kindOption("my-custom-kind").color
    );
  });
});

describe("the chip carries the option's mark", () => {
  const options = [statusOption("failed"), statusOption("running")];
  it("the chosen value's glyph rides on the chip face and the menu item", () => {
    const face = filterChipFace({
      options,
      selected: ["failed"],
      allLabel: "All",
    });
    expect(face.mark?.icon).toBe(options[0]!.icon);
    expect(face.mark?.tone).toBe("down");
    const items = filterMenuItems({ options, mode: "single", allLabel: "All" });
    expect(items[1]!.icon).toBe(options[0]!.icon);
  });
  it("All has no mark", () => {
    expect(
      filterChipFace({ options, selected: [], allLabel: "All" }).mark
    ).toBeNull();
  });
});
