import { afterEach, describe, expect, it } from "vitest";
import { ambientCatalogLocale, setAmbientCatalogLocale } from "./ambient.js";

afterEach(() => setAmbientCatalogLocale("en"));

describe("the ambient catalog locale", () => {
  it("is English until a client host sets it", () => {
    expect(ambientCatalogLocale()).toBe("en");
    setAmbientCatalogLocale("fr");
    expect(ambientCatalogLocale()).toBe("fr");
    setAmbientCatalogLocale("en");
    expect(ambientCatalogLocale()).toBe("en");
  });

  it("reads English for a value outside the supported locales (an untyped caller)", () => {
    setAmbientCatalogLocale("fr");
    setAmbientCatalogLocale("de" as never);
    expect(ambientCatalogLocale()).toBe("en");
  });
});
