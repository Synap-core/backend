/**
 * The static checks of `surfaces.inspect` (Surfaces P7), one row per case
 * each pattern must catch AND per look-alike it must leave alone (a token's
 * own fallback, an anchor link, a decorative image, a labelled field): a
 * lint that flags everything is as useless as one that flags nothing.
 *
 * NOT COVERED (stated): markup built by script at run time, a `>` inside an
 * attribute value (the tag scan stops there), colours computed in JS
 * (`"#" + hex`), CSS custom properties other than `--synap-*` holding a
 * colour (counted at their definition, not at their use).
 */
import { describe, it, expect } from "vitest";
import {
  lintA11y,
  lintTokens,
  type LintSource,
} from "./inspect-lint.js";

const html = (text: string): LintSource => ({
  label: "document:p",
  text,
  language: "html",
});
const mod = (text: string): LintSource => ({
  label: "cell:k source",
  text,
  language: "module",
});

describe("lintTokens", () => {
  it("finds a hand-written hex, rgb() and named colour, with its line, property and token", () => {
    const found = lintTokens(
      html(
        [
          "<html>",
          '<div style="background: #1a73e8">a</div>',
          "<style>",
          "  p { color: rgb(10, 20, 30); }",
          "  .box { border: 1px solid black; }",
          "</style>",
        ].join("\n")
      )
    );
    expect(found.map((f) => [f.line, f.found, f.property, f.suggestion])).toEqual([
      [2, "#1a73e8", "background", "var(--synap-background)"],
      [4, "rgb(10, 20, 30)", "color", "var(--synap-color)"],
      [5, "black", "border", "var(--synap-border-color)"],
    ]);
    expect(found.every((f) => f.kind === "colour")).toBe(true);
    expect(found[0]!.column).toBe(25);
  });

  it("leaves a token's own fallback, an anchor link, an entity and a comment alone", () => {
    const found = lintTokens(
      html(
        [
          '<p style="color: var(--synap-color, #111111)">x</p>',
          '<a href="#abc">top</a>',
          "<svg><path fill=\"url(#bad)\"/></svg>",
          "<p>&#123;</p>",
          "<!-- background: #ffffff -->",
          "/* color: red */",
        ].join("\n")
      )
    );
    expect(found).toEqual([]);
  });

  it("finds a hand-written font family and suggests the font token", () => {
    const found = lintTokens(
      html(
        [
          "<style>",
          "  body { font-family: Inter, sans-serif; }",
          "  h1 { font-family: var(--synap-font-heading); }",
          "  code { font-family: inherit; }",
          "</style>",
        ].join("\n")
      )
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      kind: "font",
      line: 2,
      found: "Inter, sans-serif",
      suggestion: "var(--synap-font-body)",
    });
  });

  it("reads a module's JSX style keys too", () => {
    const found = lintTokens(
      mod(
        [
          "export default function Cell() {",
          '  return <pre style={{ fontFamily: "Menlo", backgroundColor: "#fafafa" }} />;',
          "}",
        ].join("\n")
      )
    );
    expect(found.map((f) => [f.kind, f.found, f.suggestion])).toEqual([
      ["font", "Menlo", "var(--synap-font-mono)"],
      ["colour", "#fafafa", "var(--synap-background)"],
    ]);
  });
});

describe("lintA11y", () => {
  const rules = (text: string) =>
    lintA11y(html(text)).map((f) => [f.line, f.rule]);

  it("an image needs alt text; alt=\"\" and aria-hidden are decoration", () => {
    expect(
      rules(
        [
          '<img src="a.png">',
          '<img src="b.png" alt="">',
          '<img src="c.png" aria-hidden="true">',
          '<img src="d.png" alt="A chart of deals">',
        ].join("\n")
      )
    ).toEqual([[1, "img-alt"]]);
  });

  it("a button or a link needs a name: text, aria-label, or an image with alt", () => {
    expect(
      rules(
        [
          "<button><svg></svg></button>",
          '<button aria-label="Close"><svg></svg></button>',
          "<button>Save</button>",
          '<a href="/x"><img src="i.png"></a>',
          '<a href="/y"><img src="i.png" alt="Home"></a>',
          "<a name=\"anchor\"></a>",
          '<input type="submit">',
        ].join("\n")
      )
    ).toEqual([
      [1, "button-name"],
      // The image inside the link has no alt either.
      [4, "img-alt"],
      [4, "link-name"],
      [7, "button-name"],
    ]);
  });

  it("a field needs a label: for=, a wrapping <label>, or aria-label; a placeholder is not one", () => {
    const found = lintA11y(
      html(
        [
          '<input id="q" placeholder="Search">',
          '<label for="name">Name</label><input id="name">',
          "<label>Email <input type=\"email\"></label>",
          '<textarea aria-label="Notes"></textarea>',
          "<select></select>",
          '<input type="hidden" name="t">',
        ].join("\n")
      )
    );
    expect(found.map((f) => [f.line, f.rule])).toEqual([
      [1, "field-label"],
      [5, "field-label"],
    ]);
    expect(found[0]!.message).toContain("placeholder");
  });

  it("a heading may not skip a level; going back up is fine", () => {
    expect(
      rules(["<h1>A</h1>", "<h3>B</h3>", "<h2>C</h2>", "<h1>D</h1>"].join("\n"))
    ).toEqual([[2, "heading-order"]]);
  });

  it("reads no markup inside a script, a style or a comment", () => {
    expect(
      rules(
        [
          "<script>const t = '<img src=x>';</script>",
          "<style>/* <button></button> */</style>",
          "<!-- <input> -->",
        ].join("\n")
      )
    ).toEqual([]);
  });

  it("a module source is not linted as markup", () => {
    expect(lintA11y(mod("<img src={x} />"))).toEqual([]);
  });
});
