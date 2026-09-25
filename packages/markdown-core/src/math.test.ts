/**
 * Math in the ONE pipeline (D-math, ratified): math is a BLOCK — a `$$` fence
 * or `$$…$$` on one line → a `math` node. Inline `$…$` is OFF: a single dollar
 * is always prose, so a price is never math. The scanner treats a `$$` block as
 * a fence (see `__fixtures__/corpus/math-fences.md`).
 */
import { describe, expect, it } from "vitest";
import { markdownToPlainText, parseMarkdown } from "./index.js";

/** Each top-level block → its type, or a paragraph's child types:values. */
function shape(md: string): unknown[] {
  return parseMarkdown(md).children.map((c: any) =>
    c.type === "paragraph"
      ? c.children.map((x: any) => `${x.type}:${x.value ?? ""}`)
      : `${c.type}:${c.value ?? ""}`
  );
}

describe("math", () => {
  it("a $$ fence is a math block", () => {
    expect(shape("$$\nE = mc^2\n$$")).toEqual(["math:E = mc^2"]);
  });

  it("$$…$$ alone on its line is a DISPLAY block, drawn like the fence", () => {
    const [node] = parseMarkdown("$$E = mc^2$$").children as any[];
    expect(node.type).toBe("math");
    expect(node.value).toBe("E = mc^2");
    expect(node.data.hChildren[0].properties.className).toEqual([
      "language-math",
      "math-display",
    ]);
  });

  it("single $ never opens math, and $$…$$ inside a sentence is prose (one rule: math is a block)", () => {
    const text = "Area is $\\pi r^2$ and $$x$$ too.";
    expect(shape(text)).toEqual([[`text:${text}`]]);
    expect(markdownToPlainText(text)).toBe(text);
  });

  it("no reader ever meets an inlineMath node, nested included", () => {
    const md =
      "# Cost $$h$$\n\n> quoted $$x$$ and **bold $$y$$** here\n\n- item $$z$$\n\n| a |\n|---|\n| $$c$$ |";
    expect(JSON.stringify(parseMarkdown(md))).not.toContain("inlineMath");
  });
});

describe("a price is never math (the '10:30' lesson)", () => {
  const PROSE = [
    "It costs $5 and $10.",
    "Pay $5, or $6 later",
    "US$5 and $10 each",
    "a $ b $ c",
    "x $a$5",
    "Inline $x^2$ is off (D-math)",
    // Alone on its line: the input where single-dollar parsing would differ
    // (it would be promoted to a display block).
    "$x^2$",
    "Meet at 10:30 for $20",
    "Save $1,000 or $2,500 today",
  ];
  for (const text of PROSE) {
    it(`"${text}" stays one text run, byte for byte`, () => {
      expect(shape(text)).toEqual([[`text:${text}`]]);
      expect(markdownToPlainText(text)).toBe(text);
    });
  }

  it("an escaped dollar is prose too", () => {
    expect(markdownToPlainText("\\$5 and \\$10")).toBe("$5 and $10");
  });
});

describe("plain text reads math as its TeX source", () => {
  it("a block", () => {
    expect(markdownToPlainText("$$\nE = mc^2\n$$")).toBe("E = mc^2");
  });
});
