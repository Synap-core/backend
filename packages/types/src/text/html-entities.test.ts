import { describe, expect, it } from "vitest";
import { decodeHtmlEntities } from "./html-entities";

describe("decodeHtmlEntities", () => {
  it("decodes named entities", () => {
    expect(decodeHtmlEntities("Intake Doors &amp; Surface Spec")).toBe(
      "Intake Doors & Surface Spec"
    );
    expect(
      decodeHtmlEntities("&lt;tag&gt; &quot;quoted&quot; &apos;s&apos;")
    ).toBe("<tag> \"quoted\" 's'");
    expect(decodeHtmlEntities("a&nbsp;b")).toBe("a b");
  });

  it("decodes decimal and hex numeric entities", () => {
    expect(decodeHtmlEntities("&#39;quoted&#39;")).toBe("'quoted'");
    expect(decodeHtmlEntities("&#x27;quoted&#x27;")).toBe("'quoted'");
  });

  it("decodes only once — a double-escaped entity is not fully unwound", () => {
    // Agent double-escaped: real text "&" -> "&amp;" -> "&amp;amp;" on the wire.
    // One call must land on the single-escaped form, not the raw "&".
    expect(decodeHtmlEntities("&amp;amp;")).toBe("&amp;");
  });

  it("leaves unknown entities and plain ampersands untouched", () => {
    expect(decodeHtmlEntities("Ben &amp; Jerry's &notreal; co")).toBe(
      "Ben & Jerry's &notreal; co"
    );
    expect(decodeHtmlEntities("R&D")).toBe("R&D");
  });

  it("is a no-op on text with no ampersand", () => {
    expect(decodeHtmlEntities("plain text")).toBe("plain text");
  });
});
