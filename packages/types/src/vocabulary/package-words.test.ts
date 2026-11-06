/**
 * Template or pack, and the "Add to my pod" permission, in the exact words a
 * person reads (founder, 2026-11-05). Literal strings on purpose: a test that
 * compares the helper to itself cannot catch a wrong word.
 */
import { describe, expect, it } from "vitest";
import { resolveGrantPermissionSentence, resolvePackageNoun } from "./index.js";

describe("resolvePackageNoun — one object is a template, several a pack", () => {
  it("English", () => {
    expect(resolvePackageNoun(1, { locale: "en" })).toBe("Template");
    expect(resolvePackageNoun(1, { locale: "en", plural: true })).toBe(
      "Templates"
    );
    expect(resolvePackageNoun(2, { locale: "en" })).toBe("Pack");
    expect(resolvePackageNoun(7, { locale: "en", plural: true })).toBe("Packs");
    // Nothing counted is not "several".
    expect(resolvePackageNoun(0, { locale: "en" })).toBe("Template");
  });

  it("French", () => {
    expect(resolvePackageNoun(1, { locale: "fr" })).toBe("Modèle");
    expect(resolvePackageNoun(1, { locale: "fr", plural: true })).toBe(
      "Modèles"
    );
    expect(resolvePackageNoun(3, { locale: "fr" })).toBe("Pack");
    expect(resolvePackageNoun(3, { locale: "fr", plural: true })).toBe("Packs");
  });
});

describe("resolveGrantPermissionSentence — a permission read as its act", () => {
  it("package.install, in English and French", () => {
    expect(
      resolveGrantPermissionSentence("package.install", { locale: "en" })
    ).toBe("Add packs and templates to your pod");
    expect(
      resolveGrantPermissionSentence("package.install", { locale: "fr" })
    ).toBe("Ajouter des packs et des modèles à votre pod");
  });

  it("every other permission has none (it is worded from subject and verb)", () => {
    expect(resolveGrantPermissionSentence("entity.read")).toBeNull();
    expect(resolveGrantPermissionSentence("package.read")).toBeNull();
  });
});
