/**
 * "Add this device": every English word has its French draft, with the same
 * arguments, and every message parses (the strict ICU subset).
 */
import { describe, expect, it } from "vitest";
import { catalogProblems, createT } from "@synap-core/types/i18n";
import { en, fr } from "./copy";

describe("the device-link catalogs", () => {
  it("translates every English key, with the same arguments", () => {
    expect(catalogProblems({ en, fr })).toEqual([]);
  });

  it("says the number and the time left in both languages", () => {
    const tEn = createT("en", { en, fr });
    const tFr = createT("fr", { en, fr });
    expect(tEn("panel.instruction", { number: "42" })).toContain("pick 42.");
    expect(tEn("panel.left.minutes", { n: 1 })).toBe("1 minute left");
    expect(tFr("panel.left.minutes", { n: 1 })).toBe("Encore 1 minute");
    expect(tFr("panel.left.seconds", { n: 30 })).toBe("Encore 30 secondes");
    expect(tEn("requests.title", { label: "iPhone · Safari" })).toBe(
      "iPhone · Safari asks to confirm it’s you"
    );
  });
});
