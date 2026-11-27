import { describe, expect, it } from "vitest";
import { resolveObjectNoun, resolveObjectNounPlural } from "./index.js";
import { OBJECT_KINDS } from "./object-kinds.js";

/**
 * "Device" (devices plan 767a5978, decision 78fc3fa1): the product word that
 * replaces "Computers" in the nav, "Appareil" in French. A computer stays a
 * device kind, so the `machine` noun keeps its own words.
 */
describe("the Device noun", () => {
  it("is a registry kind, resolved through the one door in both languages", () => {
    expect(OBJECT_KINDS.device?.kind).toBe("device");
    expect(resolveObjectNoun("device")).toBe("Device");
    expect(resolveObjectNounPlural("device")).toBe("Devices");
    expect(resolveObjectNoun("device", "fr")).toBe("Appareil");
    expect(resolveObjectNounPlural("device", "fr")).toBe("Appareils");
  });

  it("leaves the computer noun as it is", () => {
    expect(resolveObjectNoun("machine")).toBe("Computer");
    expect(resolveObjectNoun("machine", "fr")).toBe("Ordinateur");
  });
});
