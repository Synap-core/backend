import { describe, expect, it } from "vitest";
import {
  diffBlocks,
  diffWords,
  hasBlockChanges,
  isPlainProse,
  matchSequences,
  splitMarkdownBlocks,
  wordDiffMarkdown,
  diffSection,
  sectionContainerBody,
} from "./diff.js";

describe("splitMarkdownBlocks", () => {
  it("splits on blank lines", () => {
    expect(splitMarkdownBlocks("# A\n\none\ntwo\n\nthree")).toEqual([
      "# A",
      "one\ntwo",
      "three",
    ]);
  });

  it("keeps a code fence with blank lines as one block", () => {
    const md = "intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nafter";
    expect(splitMarkdownBlocks(md)).toEqual([
      "intro",
      "```ts\nconst a = 1;\n\nconst b = 2;\n```",
      "after",
    ]);
  });

  it("keeps a container embed and its JSON body as one block", () => {
    const md =
      ':::synap-cell{key="chart"}\n```json\n{"a":1}\n```\n\nfallback prose\n:::\n\nnext';
    expect(splitMarkdownBlocks(md)).toEqual([
      ':::synap-cell{key="chart"}\n```json\n{"a":1}\n```\n\nfallback prose\n:::',
      "next",
    ]);
  });

  it("keeps a nested section container as one block", () => {
    const md =
      ':::synap-section{id="r"}\n## Risks\n\n::::synap-entity{id="e"}\n::::\n\nbody\n:::';
    expect(splitMarkdownBlocks(md)).toHaveLength(1);
  });
});

describe("diffWords", () => {
  it("strikes the replaced words and adds the new ones", () => {
    const segs = diffWords(
      "we can slip by a week.",
      "a one-week slip moves the call."
    );
    expect(
      segs
        .filter((s) => s.op === "del")
        .map((s) => s.text.trim())
        .join(" ")
    ).toContain("we can");
    expect(
      segs
        .filter((s) => s.op === "add")
        .map((s) => s.text)
        .join("")
    ).toContain("one-week");
    // Both sides reconstruct exactly.
    expect(
      segs
        .filter((s) => s.op !== "add")
        .map((s) => s.text)
        .join("")
    ).toBe("we can slip by a week.");
    expect(
      segs
        .filter((s) => s.op !== "del")
        .map((s) => s.text)
        .join("")
    ).toBe("a one-week slip moves the call.");
  });
});

describe("diffBlocks", () => {
  const before =
    "# Plan\n\nPartner outreach depends on pricing; we can slip by a week.\n\nLegal review is open.";
  const after =
    "# Plan\n\nPartner outreach depends on pricing; a one-week slip moves the call.\n\nIf pricing ships late, we postpone.\n\nLegal review is open.";

  it("pairs an edited paragraph as a change with word segments, and keeps the rest", () => {
    const blocks = diffBlocks(before, after);
    expect(blocks.map((b) => b.op)).toEqual(["same", "change", "add", "same"]);
    const change = blocks[1]!;
    expect(
      change.op === "change" && change.words?.some((w) => w.op === "del")
    ).toBe(true);
    expect(hasBlockChanges(blocks)).toBe(true);
  });

  it("reports no change for identical texts", () => {
    expect(hasBlockChanges(diffBlocks(before, before))).toBe(false);
  });

  it("never word-diffs a block with markup (the embed stays whole)", () => {
    const blocks = diffBlocks(
      "See [[entity:e1|Acme]] now.",
      "See [[entity:e2|Beta]] now."
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.op === "change" && blocks[0]!.words).toBeFalsy();
  });

  it("a removed block is a del; an added one is an add", () => {
    expect(diffBlocks("a\n\nb", "a").map((b) => b.op)).toEqual(["same", "del"]);
    expect(diffBlocks("a", "a\n\nb").map((b) => b.op)).toEqual(["same", "add"]);
  });
});

describe("isPlainProse", () => {
  it("rejects headings, lists, emphasis, embeds", () => {
    for (const md of [
      "# H",
      "- item",
      "1. item",
      "a *b*",
      ":::synap-cell{}",
      "a `b`",
      "> q",
      "==h==",
    ]) {
      expect(isPlainProse(md), md).toBe(false);
    }
    expect(isPlainProse("Plain words, with punctuation: yes.")).toBe(true);
  });
});

describe("wordDiffMarkdown", () => {
  it("wraps changes with whitespace outside the markers", () => {
    expect(
      wordDiffMarkdown([
        { op: "same", text: "a " },
        { op: "del", text: "old words " },
        { op: "add", text: "new " },
        { op: "same", text: "end" },
      ])
    ).toBe("a ~~old words~~ ==new== end");
  });
});

describe("matchSequences", () => {
  it("returns null past the distance bound", () => {
    expect(matchSequences(["a", "b"], ["c", "d"], 1)).toBeNull();
    expect(matchSequences(["a", "b"], ["a", "c"])).toEqual([[0, 0]]);
  });
});

describe("diffSection", () => {
  it("diffs INSIDE a section container, so one edited paragraph is one change", () => {
    const wrap = (body: string) =>
      `:::synap-section{id="risks" owner="ai"}\n${body}\n:::`;
    const blocks = diffSection(
      wrap("## Risks\n\nWe can slip.\n\nLegal is open."),
      wrap("## Risks\n\nWe cannot slip.\n\nLegal is open.")
    );
    expect(blocks.map((b) => b.op)).toEqual(["same", "change", "same"]);
  });

  it("leaves a non-section text as is", () => {
    expect(sectionContainerBody("plain\n\ntext")).toBe("plain\n\ntext");
  });
});
