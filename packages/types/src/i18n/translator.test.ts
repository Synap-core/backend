import { describe, expect, it } from "vitest";
import { catalogProblems, createT, type Catalog } from "./translator.js";
import { seedEn, seedFr } from "./seed-catalog.js";

const catalogs = { en: seedEn, fr: seedFr };

describe("createT", () => {
  it("formats the locale's own message", () => {
    const t = createT("fr", catalogs);
    expect(t("seed.greeting")).toBe("Bonjour");
    expect(t("seed.welcome", { name: "Ada" })).toBe("Bon retour, Ada");
    expect(t("seed.ideas.added", { n: 0 })).toBe("Aucune idée ajoutée");
    expect(t("seed.ideas.added", { n: 1 })).toBe("1 idée ajoutée");
    expect(t("seed.items.inSpace", { n: 0, space: "Builder" })).toBe(
      "0 élément dans Builder"
    );
    expect(t("seed.items.inSpace", { n: 1000000, space: "Builder" })).toBe(
      "1\u202f000\u202f000 d’éléments dans Builder" // narrow no-break space thousands
    );
    expect(t("seed.created", { kind: "task" })).toBe("Tâche créée");
    expect(t("seed.created", { kind: "project" })).toBe("Projet créé");
  });

  it("formats English with English rules", () => {
    const t = createT("en", catalogs);
    expect(t("seed.items.inSpace", { n: 0, space: "Builder" })).toBe(
      "0 items in Builder"
    );
    expect(t("seed.items.inSpace", { n: 1, space: "Builder" })).toBe(
      "1 item in Builder"
    );
    expect(t("seed.created", { kind: "note" })).toBe("Created");
  });

  it("falls back to English for a key the translation lacks, never the raw key", () => {
    const partial = { "seed.greeting": "Bonjour" } as unknown as Catalog<
      typeof seedEn
    >;
    const t = createT("fr", { en: seedEn, fr: partial });
    expect(t("seed.greeting")).toBe("Bonjour");
    expect(t("seed.welcome", { name: "Ada" })).toBe("Welcome back, Ada");
    // English plural rules for the English message: 0 is plural in English.
    expect(t("seed.items.inSpace", { n: 0, space: "B" })).toBe("0 items in B");
  });

  it("falls back to English for a malformed translation", () => {
    const broken = { ...seedFr, "seed.welcome": "Bon retour, {name" };
    const t = createT("fr", { en: seedEn, fr: broken });
    expect(t("seed.welcome", { name: "Ada" })).toBe("Welcome back, Ada");
  });

  it("does not read inherited keys as messages", () => {
    const t = createT("fr", catalogs);
    const untyped = t as unknown as (key: string) => string;
    expect(() => untyped("toString")).toThrow(/Unknown message key/);
    expect(() => untyped("seed.nope")).toThrow(/Unknown message key/);
  });

  it("an unsupported locale from an untyped caller reads English", () => {
    const t = createT("de" as never, catalogs);
    expect(t("seed.greeting")).toBe("Hello");
  });
});

describe("catalogProblems", () => {
  it("finds nothing wrong with the seed catalogs", () => {
    expect(catalogProblems(catalogs)).toEqual([]);
  });

  it("names a missing key, an extra key, a syntax error and an argument drift", () => {
    const fr = {
      ...seedFr,
      "seed.extra": "En trop",
      "seed.welcome": "Bon retour, {nom}",
      "seed.created": "{kind, select, task {Tâche créée}}",
      "seed.ideas.added": "{n} idées",
    } as Record<string, string>;
    delete fr["seed.greeting"];
    const problems = catalogProblems({
      en: { ...seedEn, "seed.bad": "{oops" },
      fr,
    }).map((p) => `${p.locale} ${p.key} ${p.problem}`);
    expect(problems.sort()).toEqual(
      [
        "en seed.bad syntax",
        "fr seed.bad missing",
        "fr seed.greeting missing",
        "fr seed.extra extra",
        "fr seed.welcome arguments",
        "fr seed.created syntax",
        "fr seed.ideas.added arguments",
      ].sort()
    );
  });

  it("lets a translation count or select an argument English only prints", () => {
    expect(
      catalogProblems({
        en: { k: "{n} files" },
        fr: { k: "{n, plural, one {# fichier} other {# fichiers}}" },
      })
    ).toEqual([]);
  });
});
