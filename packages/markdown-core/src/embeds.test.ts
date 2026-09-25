import { describe, it, expect } from "vitest";
import { parseMarkdown } from "./processor.js";
import {
  readEmbed,
  serializeEmbed,
  serializeAttributes,
  EmbedSerializeError,
} from "./embeds.js";
import { collectDiagnostics } from "./diagnostics.js";
import { scanContainers } from "./scan.js";

function firstEmbed(markdown: string) {
  const tree = parseMarkdown(markdown) as any;
  const node = tree.children.find((n: any) => n.type === "containerDirective");
  expect(node, "no container parsed").toBeDefined();
  return readEmbed(node)!;
}

describe("readEmbed — dual read", () => {
  it("legacy double-quoted-attribute props (character references) → props, legacy", () => {
    const e = firstEmbed(
      `:::synap-cell{cellKey="chart-pie" cellProps="{&#x22;groupBy&#x22;:&#x22;status&#x22;}"}\n:::`
    );
    expect(e).toMatchObject({
      directive: "synap-cell",
      kind: "cell",
      ref: { cellKey: "chart-pie" },
      props: { groupBy: "status" },
      legacy: true,
    });
    expect(e.ref).not.toHaveProperty("cellProps");
  });

  it("legacy SINGLE-quoted props (the assembler's form) → props, legacy", () => {
    const e = firstEmbed(
      `:::synap-cell{cellKey="chart-pie" cellProps='{"profileSlug":"task","label":"Review {x}"}'}\n:::`
    );
    expect(e.props).toEqual({ profileSlug: "task", label: "Review {x}" });
    expect(e.legacy).toBe(true);
    expect(e.diagnostics.map((d) => d.code)).toEqual(["legacy-props"]);
  });

  it("the ```json body block → props, NOT legacy; the rest is the fallback", () => {
    const e = firstEmbed(
      [
        ':::synap-cell{cellKey="chart-bar"}',
        "```json",
        '{"label":"The team\'s \\"load\\"","note":":::"}',
        "```",
        "",
        "Tasks pile up in **Review**.",
        ":::",
      ].join("\n")
    );
    expect(e.props).toEqual({ label: 'The team\'s "load"', note: ":::" });
    expect(e.legacy).toBe(false);
    expect(e.fallback.map((n) => n.type)).toEqual(["paragraph"]);
    expect(e.diagnostics).toEqual([]);
  });

  it("malformed props are a VISIBLE error, never an empty config", () => {
    for (const md of [
      `:::synap-cell{cellKey="c" cellProps='{"a":'}\n:::`,
      ':::synap-cell{cellKey="c"}\n```json\n{not json}\n```\n:::',
      ':::synap-cell{cellKey="c"}\n```json\n[1,2]\n```\n:::',
    ]) {
      const e = firstEmbed(md);
      expect(e.props, md).toBeUndefined();
      expect(e.propsError, md).toMatch(/JSON/);
      expect(
        e.diagnostics.some(
          (d) => d.code === "malformed-props" && d.severity === "error"
        ),
        md
      ).toBe(true);
    }
  });

  it("the editor's `cellProps='{}'` default is no props, not an error", () => {
    const e = firstEmbed(`:::synap-cell{cellKey="feed" cellProps='{}'}\n:::`);
    expect(e.props).toBeUndefined();
    expect(e.propsError).toBeUndefined();
  });

  it("a body block beats a legacy attribute, with a warning", () => {
    const e = firstEmbed(
      ':::synap-cell{cellKey="c" cellProps=\'{"a":1}\'}\n```json\n{"a":2}\n```\n:::'
    );
    expect(e.props).toEqual({ a: 2 });
    expect(e.diagnostics.map((d) => d.code)).toEqual(["duplicate-props"]);
  });

  it("reference embeds without a reference are diagnosed", () => {
    expect(
      firstEmbed(":::synap-entity{}\n:::").diagnostics.map((d) => d.code)
    ).toEqual(["missing-ref"]);
    expect(
      firstEmbed(':::synap-view{viewType="table"}\n:::').diagnostics.map(
        (d) => d.code
      )
    ).toEqual(["missing-ref"]);
  });

  it("synap-section and prose directives are not embeds", () => {
    const tree = parseMarkdown('::::synap-section{id="s"}\nx\n::::') as any;
    expect(readEmbed(tree.children[0])).toBeNull();
  });
});

describe("serializeEmbed — THE writer", () => {
  it("writes reference-only attributes and the props block; reads back identically", () => {
    const props = {
      profileSlug: "task",
      label: `The team's "load" {x}`,
      note: ":::",
    };
    const md = serializeEmbed({
      directive: "synap-cell",
      ref: { cellKey: "chart-bar" },
      props,
      fallback: "Tasks pile up in **Review**.",
    });
    expect(md).toBe(
      [
        ':::synap-cell{cellKey="chart-bar"}',
        "```json",
        JSON.stringify(props),
        "```",
        "",
        "Tasks pile up in **Review**.",
        ":::",
      ].join("\n")
    );
    const e = firstEmbed(md);
    expect(e.props).toEqual(props);
    expect(e.ref).toEqual({ cellKey: "chart-bar" });
    expect(e.legacy).toBe(false);
  });

  it("a bare reference is the canonical two-line form", () => {
    expect(
      serializeEmbed({ directive: "synap-entity", ref: { id: "e1" } })
    ).toBe(':::synap-entity{id="e1"}\n:::');
  });

  it("attribute values are lossless: quotes and ampersands survive both parsers", () => {
    const ref = { id: `a"b&c'd` };
    const md = serializeEmbed({ directive: "synap-entity", ref });
    expect(firstEmbed(md).ref).toEqual(ref);
    expect(scanContainers(md).containers[0]!.attributes).toEqual(ref);
  });

  it("a fallback holding its own container gets MORE colons than it", () => {
    const md = serializeEmbed({
      directive: "synap-cell",
      ref: { cellKey: "c" },
      fallback: ':::synap-entity{id="x"}\n:::',
    });
    expect(md.startsWith("::::synap-cell")).toBe(true);
    const scan = scanContainers(md).containers;
    expect(scan.map((c) => [c.name, c.depth, c.terminated])).toEqual([
      ["synap-cell", 0, true],
      ["synap-entity", 1, true],
    ]);
  });

  it("a colon line INSIDE a fallback code block still raises the fence (closers are seen first)", () => {
    const md = serializeEmbed({
      directive: "synap-cell",
      ref: { cellKey: "c" },
      fallback: "```\n::::\n```",
    });
    expect(md.startsWith(":::::synap-cell")).toBe(true);
    expect(scanContainers(md).containers[0]!.terminated).toBe(true);
  });

  it("refuses what it cannot write losslessly", () => {
    expect(() =>
      serializeEmbed({ directive: "synap-section", ref: {} })
    ).toThrow(EmbedSerializeError);
    expect(() =>
      serializeEmbed({ directive: "synap-cell", ref: { cellProps: "{}" } })
    ).toThrow(/props channel/);
    expect(() =>
      serializeEmbed({ directive: "synap-entity", ref: { id: "a\nb" } })
    ).toThrow(/line break/);
    expect(() =>
      serializeEmbed({
        directive: "synap-cell",
        ref: { cellKey: "c" },
        fallback: ':::synap-entity{id="x"}',
      })
    ).toThrow(/unclosed :::/);
    expect(() =>
      serializeEmbed({
        directive: "synap-cell",
        ref: { cellKey: "c" },
        fallback: "```\nopen",
      })
    ).toThrow(/unclosed code/);
  });

  it("a fallback that opens with a json block is not mistaken for props", () => {
    const md = serializeEmbed({
      directive: "synap-cell",
      ref: { cellKey: "c" },
      fallback: '```json\n{"shown":true}\n```',
    });
    const e = firstEmbed(md);
    expect(e.props).toEqual({});
    expect(e.fallback.map((n) => n.type)).toEqual(["code"]);
  });

  it("serializeAttributes omits empty values and rejects bad names", () => {
    expect(serializeAttributes({ id: "s", owner: "", round: "2" })).toBe(
      '{id="s" round="2"}'
    );
    expect(() => serializeAttributes({ "bad name": "x" })).toThrow(
      EmbedSerializeError
    );
  });
});

describe("collectDiagnostics", () => {
  it("reports unterminated embeds, legacy props and unknown directives with lines", () => {
    const md = [
      "# T",
      "",
      ':::synap-cell{cellKey="c" cellProps=\'{"a":1}\'}',
      ":::",
      "",
      ':::synap-bogus{id="x"}',
      ":::",
      "",
      ':::synap-entity{id="e"}',
      "prose that would be swallowed",
    ].join("\n");
    expect(collectDiagnostics(md).map((d) => [d.code, d.line])).toEqual([
      ["legacy-props", 3],
      ["unknown-directive", 6],
      ["unterminated-embed", 9],
    ]);
  });
});
