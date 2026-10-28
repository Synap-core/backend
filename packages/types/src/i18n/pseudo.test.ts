import { describe, expect, it } from "vitest";
import { pseudoLocalize, pseudoLocalizeMessage } from "./pseudo.js";
import { catalogProblems, createT } from "./translator.js";
import { formatMessage } from "./message.js";
import { seedEn } from "./seed-catalog.js";

describe("pseudoLocalize", () => {
  const pseudo = pseudoLocalize(seedEn);

  it("keeps every key, and the catalog stays sound against English", () => {
    expect(Object.keys(pseudo)).toEqual(Object.keys(seedEn));
    expect(catalogProblems({ en: seedEn, fr: pseudo })).toEqual([]);
  });

  it("accents every ASCII letter of the text, never an argument name", () => {
    const m = pseudoLocalizeMessage("Welcome back, {name}");
    expect(m.startsWith("[Ŵéļçóɱé ƀáçķ, {name}")).toBe(true);
    expect(m.endsWith("]")).toBe(true);
    const shown = formatMessage(m, { name: "Ada" }, "en");
    // The only ASCII letters left are the argument's value.
    expect(shown.replace("Ada", "")).not.toMatch(/[A-Za-z]/);
  });

  it("formats like English: same branches, same arguments", () => {
    const t = createT("fr", { en: seedEn, fr: pseudo });
    expect(t("seed.ideas.added", { n: 0 })).toMatch(/^\[Ñó íđéáš/);
    expect(t("seed.ideas.added", { n: 1 })).toMatch(/^\[1 íđéá /);
    expect(t("seed.ideas.added", { n: 2 })).toMatch(/^\[2 íđéáš /);
  });

  it("is at least ~30 % longer than English once formatted", () => {
    const t = createT("fr", { en: seedEn, fr: pseudo });
    const en = createT("en", { en: seedEn, fr: pseudo });
    const cases = [
      t("seed.greeting").length / en("seed.greeting").length,
      t("seed.welcome", { name: "Ada" }).length /
        en("seed.welcome", { name: "Ada" }).length,
      t("seed.items.inSpace", { n: 3, space: "Builder" }).length /
        en("seed.items.inSpace", { n: 3, space: "Builder" }).length,
    ];
    for (const ratio of cases) expect(ratio).toBeGreaterThanOrEqual(1.3);
  });
});
