/**
 * The narrow section splitter: it must locate a top-level `synap-section` by
 * line extent and replace ONLY that block, byte-for-byte preserving the rest.
 */

import { describe, it, expect } from "vitest";
import { parseMarkdown } from "@synap-core/markdown-core/processor";
import {
  parseSections,
  sectionOwner,
  serializeSection,
  upsertSectionInMarkdown,
  SectionBodyError,
} from "./sections.js";

const DOC = [
  "# Lead finding",
  "",
  '::::synap-section{id="why" owner="human"}',
  "## Why",
  "",
  "Because the founder asked.",
  "::::",
  "",
  '::::synap-section{id="approach" owner="ai" author="agent-1"}',
  "## Approach",
  "",
  ':::synap-cell{cellKey="proposals"}',
  ":::",
  "",
  "```md",
  '::::synap-section{id="fake"}',
  "```",
  "::::",
  "",
  "Trailing human notes.",
].join("\n");

const stamp = {
  owner: "ai",
  author: "agent-1",
  writtenAt: "2026-09-14T00:00:00.000Z",
  sessionState: "active",
};

describe("parseSections", () => {
  it("finds top-level sections by line extent, skipping nested containers and code fences", () => {
    const parsed = parseSections(DOC);
    expect(parsed.sections.map((s) => [s.id, s.startLine, s.endLine])).toEqual([
      ["why", 2, 6],
      ["approach", 8, 17],
    ]);
    expect(parsed.duplicateIds).toEqual([]);
    expect(parsed.unterminatedId).toBeNull();
  });

  it("reports duplicate ids and an unterminated section", () => {
    const dup =
      '::::synap-section{id="a"}\nx\n::::\n::::synap-section{id="a"}\ny\n::::';
    expect(parseSections(dup).duplicateIds).toEqual(["a"]);
    const open = '::::synap-section{id="a"}\nx\n';
    expect(parseSections(open).unterminatedId).toBe("a");
  });

  it("a shorter fence inside a section does not close it", () => {
    const md = '::::synap-section{id="a"}\n:::\nstill inside\n::::\nafter';
    expect(parseSections(md).sections[0]).toMatchObject({
      startLine: 0,
      endLine: 3,
    });
  });

  it("parses quoted, unquoted and #id attributes", () => {
    const md = `::::synap-section{id="x" owner='ai' round=2}\nx\n::::\n::::synap-section{#anchor}\ny\n::::`;
    expect(parseSections(md).sections.map((s) => s.attributes)).toEqual([
      { id: "x", owner: "ai", round: "2" },
      { id: "anchor" },
    ]);
  });

  it("agrees with the renderer: a bare closer inside a fenced block closes the section", () => {
    // micromark checks a container's closing fence before the content it holds,
    // so the renderer ends `a` at the fenced `::::`. The door used to skip it
    // and splice a different extent than the one the reader sees.
    const md = '::::synap-section{id="a"}\n```md\n::::\n```\n::::';
    expect(parseSections(md).sections[0]).toMatchObject({
      id: "a",
      startLine: 0,
      endLine: 2,
    });
    const rendered = parseMarkdown(md).children[0] as {
      position?: { end: { line: number } };
    };
    expect(rendered.position?.end.line).toBe(3); // 1-based ⇒ line index 2
  });
});

describe("sectionOwner", () => {
  it("only an explicit owner=ai is AI-owned; absent reads as human", () => {
    expect(sectionOwner({ attributes: { owner: "ai" } })).toBe("ai");
    expect(sectionOwner({ attributes: { owner: "human" } })).toBe("human");
    expect(sectionOwner({ attributes: { agent: "research" } })).toBe("human");
  });
});

describe("upsertSectionInMarkdown", () => {
  it("replaces ONLY the targeted section; every other line is byte-identical", () => {
    const parsed = parseSections(DOC);
    const { markdown, replaced } = upsertSectionInMarkdown(DOC, parsed, {
      id: "approach",
      title: "Approach",
      body: "Cold outreach to 20 founders.",
      attributes: stamp,
    });
    expect(replaced).toBe(true);
    const before = DOC.split("\n");
    const after = markdown.split("\n");
    // Head (lines 0..7) and tail (after the old block) are untouched.
    expect(after.slice(0, 8)).toEqual(before.slice(0, 8));
    expect(after.slice(-3)).toEqual(before.slice(-3));
    expect(markdown).toContain("Because the founder asked.");
    expect(markdown).toContain("Cold outreach to 20 founders.");
    expect(markdown).not.toContain(':::synap-cell{cellKey="proposals"}');
    // The rewritten document still parses into the same two sections.
    expect(parseSections(markdown).sections.map((s) => s.id)).toEqual([
      "why",
      "approach",
    ]);
    expect(parseSections(markdown).sections[1]!.attributes).toMatchObject(
      stamp
    );
  });

  it("appends a new section at the end when the id is absent", () => {
    const parsed = parseSections(DOC);
    const { markdown, replaced } = upsertSectionInMarkdown(DOC, parsed, {
      id: "decisions",
      title: "Decisions",
      body: "Go.",
      attributes: stamp,
    });
    expect(replaced).toBe(false);
    expect(markdown.startsWith(DOC)).toBe(true);
    expect(parseSections(markdown).sections.map((s) => s.id)).toEqual([
      "why",
      "approach",
      "decisions",
    ]);
  });

  it("an empty document gets the section alone", () => {
    const { markdown } = upsertSectionInMarkdown("", parseSections(""), {
      id: "why",
      title: "Why",
      body: "",
      attributes: stamp,
    });
    expect(parseSections(markdown).sections).toHaveLength(1);
  });
});

describe("serializeSection", () => {
  it("fences longer than any container fence in the body, so the body cannot close it", () => {
    const body = '::::synap-cell{cellKey="x"}\n::::';
    const block = serializeSection({
      id: "a",
      title: "A",
      body,
      attributes: {},
    });
    expect(block.startsWith(":::::synap-section{")).toBe(true);
    expect(parseSections(block).sections[0]).toMatchObject({
      id: "a",
      startLine: 0,
    });
  });

  it("writes attribute values LOSSLESSLY (escaped, not stripped) and flattens line breaks", () => {
    const block = serializeSection({
      id: "a",
      title: "Line\nbreak",
      body: "",
      attributes: { author: 'x"}y', note: "two\nlines" },
    });
    expect(block.split("\n")[0]).toBe(
      '::::synap-section{id="a" author="x&#x22;}y" note="two lines"}'
    );
    expect(block.split("\n")[1]).toBe("## Line break");
    // …and the value reads back exactly as written.
    expect(parseSections(block).sections[0]!.attributes.author).toBe('x"}y');
  });

  it("refuses a body that would escape or nest the section", () => {
    expect(() =>
      serializeSection({
        id: "a",
        title: "A",
        body: ":::synap-cell{}\nno close",
        attributes: {},
      })
    ).toThrow(SectionBodyError);
    expect(() =>
      serializeSection({
        id: "a",
        title: "A",
        body: '::::synap-section{id="b"}\n::::',
        attributes: {},
      })
    ).toThrow(SectionBodyError);
    expect(() =>
      serializeSection({
        id: "a",
        title: "A",
        body: "```\nunclosed",
        attributes: {},
      })
    ).toThrow(SectionBodyError);
  });
});
