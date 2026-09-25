/**
 * `==x==` → a `mark` node (`remarkHighlight`), and every false positive stays
 * prose. The delimiter rules are in `processor.ts`.
 */
import { describe, expect, it } from "vitest";
import { parseMarkdown } from "./processor.js";
import { markdownToPlainText } from "./plain-text.js";

type N = {
  type: string;
  value?: string;
  url?: string;
  children?: N[];
  data?: { hName?: string };
};

function marks(md: string): string[] {
  const out: string[] = [];
  const text = (n: N): string =>
    (n.value ?? "") + (n.children ?? []).map(text).join("");
  const walk = (n: N) => {
    if (n.type === "mark") out.push(text(n));
    (n.children ?? []).forEach(walk);
  };
  walk(parseMarkdown(md) as unknown as N);
  return out;
}

describe("remarkHighlight", () => {
  it("==x== becomes a mark carrying x, drawn as <mark>", () => {
    expect(marks("A ==highlighted== word.")).toEqual(["highlighted"]);
    const para = (parseMarkdown("==x==") as unknown as N).children![0]!;
    expect(para.children).toEqual([
      {
        type: "mark",
        data: { hName: "mark" },
        children: [{ type: "text", value: "x" }],
      },
    ]);
  });

  it("several highlights, and phrasing inside one", () => {
    expect(marks("==one== and ==two==")).toEqual(["one", "two"]);
    expect(marks("==a **bold** word==")).toEqual(["a bold word"]);
  });

  it("inside link text it highlights; the URL is never read", () => {
    expect(marks("[a ==b== c](https://x.test/p==q==r)")).toEqual(["b"]);
    const link = (parseMarkdown("[x](https://x.test/p==q==r)") as unknown as N)
      .children![0]!.children![0]!;
    expect(link.url).toBe("https://x.test/p==q==r");
  });

  const PROSE: Record<string, string> = {
    "spaced comparison": "a == b == c",
    "triple equals": "x === y and ===z===",
    unbalanced: "an ==open highlight with no end",
    "inline code": "`==not==` here",
    "fenced code": "```\n==not==\n```",
    "empty pair": "a ==== b",
  };
  for (const [name, md] of Object.entries(PROSE)) {
    it(`stays prose: ${name}`, () => {
      expect(marks(md)).toEqual([]);
    });
  }

  it("never crosses a paragraph boundary", () => {
    expect(marks("==start of one\n\nend of another==")).toEqual([]);
  });

  it("plain text keeps the words and drops the delimiters", () => {
    expect(markdownToPlainText("A ==highlighted== word.")).toBe(
      "A highlighted word."
    );
  });
});
