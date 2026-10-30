import { describe, expect, it } from "vitest";
import { createT, type Catalog } from "@synap-core/types/i18n";
import { consoleLocaleOf } from "./locale";

describe("consoleLocaleOf", () => {
  it("speaks the person's language from users.me", () => {
    expect(consoleLocaleOf({ locale: "fr" })).toBe("fr");
    expect(consoleLocaleOf({ locale: "en" })).toBe("en");
    expect(consoleLocaleOf({ locale: "fr-CA" })).toBe("fr");
  });

  it("speaks English while users.me loads, after it failed, or for a language Synap does not ship", () => {
    expect(consoleLocaleOf(undefined)).toBe("en");
    expect(consoleLocaleOf(null)).toBe("en");
    expect(consoleLocaleOf({ locale: null })).toBe("en");
    expect(consoleLocaleOf({ locale: "de" })).toBe("en");
  });
});

describe("useT's translator (createT over a page's copy.ts)", () => {
  const en = {
    greeting: "Hello {name}",
    count: "{n, plural, one {# request} other {# requests}}",
    broken: "Broken",
  } as const;
  const fr: Catalog<typeof en> = {
    greeting: "Bonjour {name}",
    count: "{n, plural, one {# demande} other {# demandes}}",
    // A malformed message reads English.
    broken: "{n, plural, one {",
  };

  it("reads French with French plural rules", () => {
    const t = createT("fr", { en, fr });
    expect(t("greeting", { name: "Léa" })).toBe("Bonjour Léa");
    // French treats 0 as singular.
    expect(t("count", { n: 0 })).toBe("0 demande");
  });

  it("falls back to English for a malformed French message, never a raw key", () => {
    const t = createT("fr", { en, fr });
    expect(t("broken")).toBe("Broken");
  });

  it("reads English for the source locale", () => {
    const t = createT("en", { en, fr });
    expect(t("count", { n: 2 })).toBe("2 requests");
  });
});
