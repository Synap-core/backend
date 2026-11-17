/**
 * The door to the object a proposal updates is ONE catalog message carrying
 * the noun (`updated.open`), never "Open" + a noun glued on: French agrees the
 * article with the noun's gender and elides it before a vowel.
 */
import { afterEach, describe, expect, it } from "vitest";
import { setAmbientCatalogLocale } from "@synap-core/types/i18n";
import { resolveNoun } from "@synap-core/types/vocabulary";
import { updatedDoorLabel } from "./UpdatedDoor";

afterEach(() => setAmbientCatalogLocale("en"));

const ENTITY = { kind: "entity" } as const;

describe("updatedDoorLabel", () => {
  it("names what the object IS, mid-sentence, never its table", () => {
    expect(updatedDoorLabel(ENTITY, "finding")).toBe("Open finding");
    expect(updatedDoorLabel({ kind: "document" })).toBe("Open document");
  });

  it("in French the article agrees with each noun's gender and elision", () => {
    setAmbientCatalogLocale("fr");
    const article = (kind: string) => {
      const noun = resolveNoun(kind, "fr");
      expect(noun.gender).not.toBe("n"); // the fixture needs a curated noun
      if (noun.elides) return "l’";
      return noun.gender === "f" ? "la " : "le ";
    };
    for (const kind of ["task", "document", "idea"]) {
      const noun = resolveNoun(kind, "fr").one.toLowerCase();
      const label = updatedDoorLabel(ENTITY, kind);
      expect(label).toContain(`${article(kind)}${noun}`);
    }
    // The fixture covers both genders and an elision (non-vacuity).
    expect(
      new Set(["task", "document", "idea"].map((k) => article(k))).size
    ).toBe(3);
  });
});
