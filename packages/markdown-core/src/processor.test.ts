/**
 * Prose `:word` must not be eaten as a directive. `remark-directive` parses any
 * `:name` in running text as a text directive; the renderers draw only
 * `synap-*`, so every other one silently deleted words — including the id in
 * every `[[entity:<id>|label]]` marker a report carries.
 */
import { describe, it, expect } from "vitest";
import { parseMarkdown as parseMarkdownToMdast } from "./processor.js";

function paragraphChildren(md: string): any[] {
  const tree = parseMarkdownToMdast(md) as any;
  return tree.children[0].children;
}

describe("parseMarkdownToMdast keeps prose colons as prose", () => {
  it("an inline marker is ONE text run, id intact", () => {
    expect(
      paragraphChildren("See [[entity:3f2a91c4-7b10|Migrate billing]] now.")
    ).toEqual([
      expect.objectContaining({
        type: "text",
        value: "See [[entity:3f2a91c4-7b10|Migrate billing]] now.",
      }),
    ]);
  });

  it('"ratio:high" keeps its words', () => {
    const kids = paragraphChildren("The ratio:high case.");
    expect(kids.map((k) => k.type)).toEqual(["text"]);
    expect(kids[0].value).toBe("The ratio:high case.");
  });

  it("a synap-* text directive is still a directive", () => {
    const kids = paragraphChildren("A :synap-entity[x]{id=e1} here.");
    expect(kids.map((k) => k.type)).toEqual(["text", "textDirective", "text"]);
  });
});
