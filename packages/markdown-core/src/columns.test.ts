/**
 * COLUMNS (columns.md, wave C0): the frame set, the one writer, the one
 * reading, the diagnostics, and every reader walking INTO a row — plain text,
 * readable, the embed locator (freeze / removal floor), the diff.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  EmbedSerializeError,
  FRAME_DIRECTIVES,
  isFrameDirective,
  readEmbed,
  serializeColumns,
} from "./embeds.js";
import {
  columnWeights,
  formatColumnWidth,
  readColumns,
  readColumnWidth,
} from "./columns.js";
import { collectDiagnostics } from "./diagnostics.js";
import { createMarkdownProcessor, parseMarkdown } from "./processor.js";
import { remarkSynapDirectives } from "./directive-registry.js";
import { markdownToPlainText } from "./plain-text.js";
import { locateEmbeds, readableMarkdown } from "./readable.js";
import { diffBlocks, isFrameFenceBlock, splitMarkdownBlocks } from "./diff.js";

const fixture = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`./__fixtures__/corpus/${name}`, import.meta.url)),
    "utf-8"
  );

const label = (e: { kind: string }) => `label:${e.kind}`;

/** The text strictly between the first `from` and the next `to` after it. */
function between(text: string, from: string, to: string): string {
  const start = text.indexOf(from) + from.length;
  return text.slice(start, text.indexOf(to, start));
}

/** name L<start>-<end> per container, indented by depth (micromark + repair). */
function shape(markdown: string): string[] {
  const out: string[] = [];
  const walk = (node: any, depth: number) => {
    for (const child of node.children ?? []) {
      if (child.type === "containerDirective") {
        out.push(
          `${"  ".repeat(depth)}${child.name} L${child.position.start.line}-${child.position.end.line}`
        );
        walk(child, depth + 1);
      } else if (depth === 0 || child.type !== "paragraph") {
        out.push(`${"  ".repeat(depth)}${child.type}`);
      } else {
        out.push(`${"  ".repeat(depth)}paragraph`);
      }
    }
  };
  walk(parseMarkdown(markdown), 0);
  return out;
}

const TWO = [
  ":::::synap-columns",
  '::::synap-column{width="40%"}',
  ':::synap-cell{cellKey="chart-bar"}',
  "```json",
  '{"profileSlug":"task"}',
  "```",
  "",
  "Tasks pile up in **Review**.",
  ":::",
  "::::",
  '::::synap-column{width="60%"}',
  "## Why",
  "",
  "Three tasks waited.",
  "::::",
  ":::::",
].join("\n");

describe("the frame set", () => {
  it("names the section and both layout frames, and nothing else", () => {
    expect([...FRAME_DIRECTIVES]).toEqual([
      "synap-section",
      "synap-columns",
      "synap-column",
    ]);
    expect(isFrameDirective("synap-cell")).toBe(false);
    expect(isFrameDirective(undefined)).toBe(false);
  });

  it("a frame is never read as an embed; the embed inside a column is", () => {
    const tree = parseMarkdown(TWO) as any;
    const row = tree.children[0];
    expect(readEmbed(row)).toBeNull();
    expect(readEmbed(row.children[0])).toBeNull();
    expect(readEmbed(row.children[0].children[0])?.ref).toEqual({
      cellKey: "chart-bar",
    });
  });

  it("locateEmbeds finds a chart inside a column (freeze, readable, the removal floor)", () => {
    expect(locateEmbeds(TWO).map((e) => e.embed.directive)).toEqual([
      "synap-cell",
    ]);
    expect(
      locateEmbeds(fixture("columns-in-section.md")).map((e) => e.embed.ref)
    ).toEqual([{ viewId: "v1", viewType: "table" }]);
  });

  it("the hast mapping names both frames and keeps only `width`", () => {
    const p = createMarkdownProcessor().use(remarkSynapDirectives);
    const tree = p.runSync(
      p.parse(
        ':::::synap-columns{x="1"}\n::::synap-column{width="40%" y="2"}\nA\n::::\n:::::'
      ),
      ""
    ) as any;
    const row = tree.children[0];
    expect(row.data).toMatchObject({ hName: "synap-columns", hProperties: {} });
    expect(row.children[0].data).toEqual({
      hName: "synap-column",
      hProperties: { width: "40%" },
    });
  });
});

describe("widths", () => {
  it.each([
    ["40%", 40],
    ["40", 40],
    ["0.4", 40],
    [" 33.5% ", 33.5],
    ["wide", null],
    ["0", null],
    ["140%", null],
    ["", null],
    [null, null],
  ])("readColumnWidth(%j) = %j", (raw, want) => {
    expect(readColumnWidth(raw)).toBe(want);
  });

  it("formatColumnWidth writes strict whole percentages from 15 to 85", () => {
    expect(formatColumnWidth(40)).toBe("40%");
    for (const bad of [14, 86, 40.5, Number.NaN])
      expect(() => formatColumnWidth(bad)).toThrow(EmbedSerializeError);
  });

  it("columnWeights: written widths kept, missing ones share the remainder", () => {
    expect(columnWeights(["40%", "60%"])).toEqual([40, 60]);
    expect(columnWeights([null, null, null])).toEqual([
      100 / 3,
      100 / 3,
      100 / 3,
    ]);
    expect(columnWeights(["40%", null, null])).toEqual([40, 30, 30]);
    // Nothing left of 100 (two concurrent resizes): the average of the others.
    expect(columnWeights(["70%", "50%", "wide"])).toEqual([70, 50, 60]);
    expect(columnWeights(["30%", "50%"])).toEqual([30, 50]); // sums ≠ 100: kept, rendered as fr
  });

  it("readColumns: the row's columns, weights and stray content", () => {
    const tree = parseMarkdown(
      ':::::synap-columns\nStray.\n::::synap-column{width="25%"}\nA\n::::\n::::synap-column\nB\n::::\n:::::'
    ) as any;
    const row = readColumns(tree.children[0])!;
    expect(row.columns.map((c) => [c.width, c.weight])).toEqual([
      ["25%", 25],
      [null, 75],
    ]);
    expect(row.stray.map((n) => n.type)).toEqual(["paragraph"]);
    expect(readColumns(tree)).toBeNull();
  });
});

describe("serializeColumns — the one writer", () => {
  it("writes the canonical corpus row byte for byte", () => {
    expect(
      serializeColumns({
        columns: [
          { width: "33%", body: "Left." },
          {
            width: "34%",
            body: "Middle, with a [link](https://example.com) and time 10:30.",
          },
          { width: "33%", body: "- right\n- list" },
        ],
      })
    ).toBe(
      between(fixture("columns.md"), "Between the rows.\n\n", "\n\n:::::")
    );
  });

  it("fences are fixed minimums: 5 outside, 4 per column, strictly decreasing", () => {
    const prose = serializeColumns({ columns: [{ body: "a" }, { body: "b" }] });
    expect(prose.split("\n")[0]).toBe(":::::synap-columns");
    expect(prose.split("\n")[1]).toBe("::::synap-column");
    // Adding an embed to a prose column does not rewrite either fence.
    const withEmbed = serializeColumns({
      columns: [{ body: ':::synap-cell{cellKey="x"}\n:::' }, { body: "b" }],
    });
    expect(withEmbed.split("\n")[0]).toBe(":::::synap-columns");
    expect(withEmbed.split("\n")[1]).toBe("::::synap-column");
  });

  it("grows a fence only when a body needs it, and keeps an authored length", () => {
    const deep = serializeColumns({
      columns: [
        { body: '::::synap-section{id="s"}\n## S\n::::' },
        { body: "b" },
      ],
    });
    const lines = deep.split("\n");
    expect(lines[0]).toBe("::::::synap-columns");
    expect(lines[1]).toBe(":::::synap-column");
    expect(lines[6]).toBe("::::synap-column"); // the other column keeps its minimum
    const authored = serializeColumns({
      colons: 7,
      columns: [{ colons: 6, body: "a" }],
    });
    expect(authored).toBe(
      ":::::::synap-columns\n::::::synap-column\na\n::::::\n:::::::"
    );
  });

  it("writes authored widths verbatim, and escapes them losslessly", () => {
    const out = serializeColumns({
      columns: [
        { width: "0.4", body: "a" },
        { width: 'x"y', body: "b" },
      ],
    });
    const row = readColumns((parseMarkdown(out) as any).children[0])!;
    expect(row.columns.map((c) => c.width)).toEqual(["0.4", 'x"y']);
  });

  it("writes what readers tolerate: one column, an empty column, four columns", () => {
    for (const columns of [
      [{ body: "only" }],
      [{ body: "" }, { body: "b" }],
      [{ body: "1" }, { body: "2" }, { body: "3" }, { body: "4" }],
    ]) {
      const row = readColumns(
        (parseMarkdown(serializeColumns({ columns })) as any).children[0]
      )!;
      expect(row.columns).toHaveLength(columns.length);
      expect(row.stray).toEqual([]);
    }
  });

  it("round-trips: every body reads back as its column's content", () => {
    const bodies = [
      TWO.split("\n").slice(2, 9).join("\n"),
      "## Why\n\nThree tasks waited.",
    ];
    const out = serializeColumns({
      columns: [
        { width: "40%", body: bodies[0]! },
        { width: "60%", body: bodies[1]! },
      ],
    });
    expect(out).toBe(TWO);
  });

  it("refuses what it cannot write losslessly", () => {
    expect(() => serializeColumns({ columns: [] })).toThrow(
      EmbedSerializeError
    );
    expect(() =>
      serializeColumns({ columns: [{ body: "```\nunclosed" }] })
    ).toThrow(/Column 1 has an unclosed code block/);
    expect(() =>
      serializeColumns({
        columns: [{ body: ':::synap-cell{cellKey="x"}\nopen' }],
      })
    ).toThrow(EmbedSerializeError);
    expect(() =>
      serializeColumns({ columns: [{ width: "4\n0", body: "a" }] })
    ).toThrow(EmbedSerializeError);
  });
});

describe("diagnostics", () => {
  const codes = (md: string) =>
    collectDiagnostics(md).map((d) => `${d.code}@${d.line}`);

  it("the canonical rows are clean (no unknown-directive, nothing else)", () => {
    expect(codes(fixture("columns.md"))).toEqual([]);
    expect(codes(fixture("columns-in-section.md"))).toEqual([]);
  });

  it("names every degenerate row readers still render", () => {
    expect(codes(fixture("columns-degenerate.md"))).toEqual([
      "empty-column@4",
      "single-column@11",
      "too-many-columns@17",
      "invalid-width@36",
    ]);
  });

  it("the equal-colon mistake: the pinned reading, and the codes that name it", () => {
    const md = fixture("columns-equal-colons.md");
    // micromark and the scanner AGREE here (conformance.test.ts): the first
    // `:::` closer closes the ROW, so the second column lands at the root.
    expect(shape(md)).toEqual([
      "synap-columns L1-9",
      "  synap-column L2-9",
      "    synap-cell L3-9",
      "      code",
      "    paragraph",
      "paragraph",
      "synap-column L11-15",
      "  heading",
      "  paragraph",
      "paragraph",
    ]);
    expect(codes(md)).toEqual([
      "single-column@1",
      "unterminated-embed@3",
      "orphan-column@11",
    ]);
    expect(
      collectDiagnostics(md).find((d) => d.code === "orphan-column")?.severity
    ).toBe("error");
  });

  it("nested rows, sections in columns, stray content, partial and odd widths", () => {
    const md = [
      "::::::synap-columns",
      "Stray.",
      ':::::synap-column{width="40%"}',
      "::::synap-columns",
      ":::synap-column",
      "x",
      ":::",
      "::::",
      ":::::",
      ":::::synap-column",
      '::::synap-section{id="s"}',
      "## S",
      "::::",
      ":::::",
      "::::::",
      "",
      ":::::synap-columns",
      '::::synap-column{width="30%"}',
      "a",
      "::::",
      '::::synap-column{width="50%"}',
      "b",
      "::::",
      ":::::",
    ].join("\n");
    const found = collectDiagnostics(md).map((d) => [
      d.code,
      d.severity,
      d.line,
    ]);
    expect(found).toEqual([
      ["invalid-width", "info", 1],
      ["columns-stray-content", "warning", 2],
      ["nested-columns", "error", 4],
      ["single-column", "info", 4],
      ["section-in-columns", "error", 11],
      ["invalid-width", "info", 17],
    ]);
    expect(collectDiagnostics(md).at(-1)?.message).toMatch(/add up to 80%/);
  });
});

describe("readers walk into rows", () => {
  it("plain text reads every column, in order, and no fence", () => {
    expect(markdownToPlainText(TWO)).toBe(
      "Tasks pile up in Review. Why Three tasks waited."
    );
  });

  it("readable UNWRAPS: each column's content in order, blank-line separated, embeds as fallbacks", () => {
    expect(readableMarkdown(`Intro.\n\n${TWO}\n\nAfter.`, label)).toBe(
      "Intro.\n\nTasks pile up in **Review**.\n\n## Why\n\nThree tasks waited.\n\nAfter."
    );
  });

  it("readable never merges two columns into one paragraph", () => {
    const md = serializeColumns({
      columns: [{ body: "Left." }, { body: "Right." }],
    });
    const out = readableMarkdown(md, label);
    expect(out).toBe("Left.\n\nRight.");
    expect((parseMarkdown(out) as any).children).toHaveLength(2);
  });

  it("readable keeps a row inside an embed's fallback as the fallback wrote it", () => {
    const md =
      ':::::synap-cell{cellKey="x"}\n::::synap-columns\n:::synap-column\nA\n:::\n::::\n:::::';
    expect(readableMarkdown(md, label)).toBe(
      "::::synap-columns\n:::synap-column\nA\n:::\n::::"
    );
  });
});

describe("the diff descends into rows", () => {
  it("each fence line is its own block, each column's content splits like the document", () => {
    expect(splitMarkdownBlocks(TWO)).toEqual([
      ":::::synap-columns",
      '::::synap-column{width="40%"}',
      TWO.split("\n").slice(2, 9).join("\n"),
      "::::",
      '::::synap-column{width="60%"}',
      "## Why",
      "Three tasks waited.",
      "::::",
      ":::::",
    ]);
  });

  it("a one-word edit in a column changes one paragraph, word by word", () => {
    const after = TWO.replace("Three tasks waited.", "Four tasks waited.");
    const changed = diffBlocks(TWO, after).filter((b) => b.op !== "same");
    expect(changed).toEqual([
      {
        op: "change",
        before: "Three tasks waited.",
        after: "Four tasks waited.",
        words: [
          { op: "del", text: "Three" },
          { op: "add", text: "Four" },
          { op: "same", text: " tasks waited." },
        ],
      },
    ]);
  });

  it("a width change is a change of that one fence block", () => {
    const after = TWO.replace('width="40%"', 'width="50%"');
    expect(diffBlocks(TWO, after).filter((b) => b.op !== "same")).toEqual([
      {
        op: "change",
        before: '::::synap-column{width="40%"}',
        after: '::::synap-column{width="50%"}',
      },
    ]);
  });

  it("a section and an embed stay one block; a row inside a section is walked after the section strip", () => {
    const md = fixture("columns-in-section.md");
    expect(splitMarkdownBlocks(md)).toHaveLength(1);
  });

  it("isFrameFenceBlock: row fences only", () => {
    expect(isFrameFenceBlock(":::::synap-columns")).toBe(true);
    expect(isFrameFenceBlock('::::synap-column{width="40%"}')).toBe(true);
    expect(isFrameFenceBlock("::::")).toBe(true);
    expect(isFrameFenceBlock(':::synap-cell{cellKey="x"}')).toBe(false);
    expect(isFrameFenceBlock("::::synap-section")).toBe(false);
    expect(isFrameFenceBlock("Prose.")).toBe(false);
    expect(isFrameFenceBlock("::::\n::::")).toBe(false);
  });
});
