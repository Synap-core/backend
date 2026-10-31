import { describe, expect, it } from "vitest";
import {
  PACKAGE_FIELD_STATE_LABELS,
  PACKAGE_UPDATE_NEEDS_LABELS,
  resolvePackageFieldLabel,
  resolvePackageFieldStateLabel,
  resolvePackageUpdateNeedsLabel,
} from "./index.js";
import {
  PACKAGE_FIELD_STATES,
  PACKAGE_UPDATE_NEEDS,
} from "../package-updates/index.js";

describe("package update words (one mark, every surface)", () => {
  it("names every field state with the design's words", () => {
    expect(PACKAGE_FIELD_STATES.length).toBe(4); // non-vacuity
    for (const s of PACKAGE_FIELD_STATES) {
      expect(PACKAGE_FIELD_STATE_LABELS[s]).toMatch(/\S/);
    }
    expect(resolvePackageFieldStateLabel("updates")).toBe("Updates");
    expect(resolvePackageFieldStateLabel("yours")).toBe("Stays yours");
    expect(resolvePackageFieldStateLabel("both")).toBe("Both changed");
    expect(resolvePackageFieldStateLabel("same")).toBe("Same");
  });

  it("names every group an update is listed under", () => {
    for (const n of PACKAGE_UPDATE_NEEDS) {
      expect(PACKAGE_UPDATE_NEEDS_LABELS[n]).toMatch(/\S/);
    }
    expect(resolvePackageUpdateNeedsLabel("choice")).toBe("Needs your choice");
    expect(resolvePackageUpdateNeedsLabel("consent")).toBe("Needs your OK");
  });

  it("names a field for a person, and never leaks an unknown token", () => {
    expect(resolvePackageFieldLabel("body")).toBe("Instructions");
    expect(resolvePackageFieldLabel("flowDefinition")).toBe("Steps");
    expect(resolvePackageFieldStateLabel("rolling-back")).toBe("Rolling back");
  });
});
