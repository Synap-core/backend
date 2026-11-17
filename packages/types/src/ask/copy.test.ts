/**
 * The ask card's words are a catalog (`./copy.ts`), and `ASK_COPY` resolves
 * them when a property is READ, in the ambient catalog locale: a client host
 * that sets the person's language reads French on its next render, never the
 * English frozen at module load.
 */
import { afterEach, describe, expect, it } from "vitest";
import { catalogProblems } from "../i18n/index.js";
import { setAmbientCatalogLocale } from "../i18n/ambient.js";
import { ASK_COPY, askCopy } from "./card.js";
import { askCopyCatalogs, askT } from "./copy.js";
import { nounInSentence, resolveObjectNoun } from "../vocabulary/index.js";

afterEach(() => setAmbientCatalogLocale("en"));

describe("ask copy catalog", () => {
  it("the French catalog has every key, the same arguments, no extra", () => {
    expect(catalogProblems(askCopyCatalogs)).toEqual([]);
  });

  it("each locale's copy has the same entries, of the same kind", () => {
    const en = askCopy("en");
    const fr = askCopy("fr");
    expect(Object.keys(fr).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      expect(typeof fr[key]).toBe(typeof en[key]);
    }
  });
});

describe("ASK_COPY resolves at read, in the ambient locale", () => {
  it("reads English until a client host sets the locale", () => {
    expect(ASK_COPY.whyHeading).toBe(askT("en")("ask.whyHeading"));
    expect(ASK_COPY.provideNoPurpose).toBe(askT("en")("ask.provideNoPurpose"));
  });

  it("a word read after the locale changed is that locale's", () => {
    const before = ASK_COPY.providePickSecret;
    setAmbientCatalogLocale("fr");
    expect(ASK_COPY.providePickSecret).toBe(
      askT("fr")("ask.providePickSecret")
    );
    expect(ASK_COPY.providePickSecret).not.toBe(before);
    expect(ASK_COPY.refuseConsequence).toBe(
      askT("fr")("ask.refuseConsequence")
    );
  });

  it("a sentence with a name reads the locale at the call, the name as written", () => {
    setAmbientCatalogLocale("fr");
    expect(ASK_COPY.provideGrantNote("Claude Code", 60)).toBe(
      askT("fr")("ask.provideGrantNote", {
        agent: "Claude Code",
        minutes: 60,
        job: "travail",
      })
    );
    expect(ASK_COPY.provideStandingGrantNote("Scout")).toContain("Scout");
    expect(ASK_COPY.provideStandingGrantNote("Scout")).toBe(
      askCopy("fr").provideStandingGrantNote("Scout")
    );
  });

  it("every entry is enumerable, so a surface may list them", () => {
    expect(Object.keys(ASK_COPY).sort()).toEqual(
      Object.keys(askCopy("en")).sort()
    );
    setAmbientCatalogLocale("fr");
    expect(Object.values(ASK_COPY)).toContain(askCopy("fr").addNote);
  });

  it("an explicit locale wins over the ambient one (a server writing for a person)", () => {
    setAmbientCatalogLocale("fr");
    expect(askCopy("en").whyHeading).toBe(askT("en")("ask.whyHeading"));
  });
});

describe("the secret grant notes", () => {
  it("one minute and many minutes are each their plural form, in both locales", () => {
    for (const locale of ["en", "fr"] as const) {
      expect(askCopy(locale).provideGrantNote("A", 1)).toMatch(/\b1 minute\b/);
      expect(askCopy(locale).provideGrantNote("A", 60)).toMatch(
        /\b60 minutes\b/
      );
      expect(askCopy(locale).provideGrantOnceNote("A", 1)).toMatch(
        /\b1 minute\b/
      );
    }
  });

  it("say the session in the vocabulary's word, the one the card says elsewhere", () => {
    for (const locale of ["en", "fr"] as const) {
      const job = nounInSentence(resolveObjectNoun("session", locale));
      expect(askCopy(locale).provideGrantNote("A", 60)).toContain(job);
      expect(askCopy(locale).provideGrantOnceNote("A", 60)).toContain(job);
      expect(askCopy(locale).closedSessionEnded).toContain(job);
    }
  });
});
