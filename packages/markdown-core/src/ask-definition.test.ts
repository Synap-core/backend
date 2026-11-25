import { describe, it, expect } from "vitest";
import { parseMarkdown } from "./processor.js";
import {
  readEmbed,
  rewriteAskDefinitions,
  scanAskDefinitions,
  serializeEmbed,
  ASK_DEFINITION_UNMATERIALIZED,
} from "./embeds.js";

const SESSION = "6f1c2b0e-0a52-4c4e-9d33-2d6c0f6d9a11";
const ASK = `{ "key": "which-database", "label": "Which database?", "ask": { "mode": "choose", "options": [ { "label": "PostgreSQL", "recommended": true }, { "label": "SQLite" } ] } }`;

const definition = (json = ASK, prose = "Which database do you prefer?") =>
  [":::synap-ask", "```json", json, "```", "", prose, ":::"].join("\n");

function embedOf(markdown: string) {
  const tree = parseMarkdown(markdown) as any;
  return readEmbed(
    tree.children.find((n: any) => n.type === "containerDirective")
  )!;
}

describe("scanAskDefinitions", () => {
  it("reads a definition: props decoded, prose kept as the fallback", () => {
    const md = `# Plan\n\n${definition()}\n\nAfter.`;
    const scan = scanAskDefinitions(md);
    expect(scan.problems).toEqual([]);
    expect(scan.definitions).toHaveLength(1);
    const d = scan.definitions[0]!;
    expect(d.line).toBe(3);
    expect(d.props).toMatchObject({ key: "which-database" });
    expect(d.fallback.trim()).toBe("Which database do you prefer?");
    expect([d.startLine, d.endLine]).toEqual([2, 8]);
  });

  it("a reference form is not a definition (idempotent input)", () => {
    const ref = serializeEmbed({
      directive: "synap-ask",
      ref: { sessionId: SESSION, slot: "which-database" },
      fallback: "Which?",
    });
    expect(scanAskDefinitions(ref)).toEqual({ definitions: [], problems: [] });
  });

  it("a half reference (one attribute) is left alone", () => {
    const md = `:::synap-ask{slot="x"}\n\`\`\`json\n${ASK}\n\`\`\`\n:::`;
    expect(scanAskDefinitions(md).definitions).toEqual([]);
  });

  it("no props block: left alone (the reader says it names nothing)", () => {
    expect(scanAskDefinitions(":::synap-ask\nJust prose.\n:::")).toEqual({
      definitions: [],
      problems: [],
    });
  });

  it("bad JSON, non-object JSON and an unclosed json fence are problems, never definitions", () => {
    const bad = scanAskDefinitions(definition("{ nope"));
    expect(bad.definitions).toEqual([]);
    expect(bad.problems[0]!.message).toMatch(/not valid JSON/);
    expect(scanAskDefinitions(definition("[1]")).problems[0]!.message).toMatch(
      /must be a JSON object/
    );
    const unclosed = scanAskDefinitions(":::synap-ask\n```json\n{}\n:::\n");
    expect(unclosed.problems[0]!.message).toMatch(/never closed/);
  });

  it("an unterminated definition is a problem", () => {
    const md = `:::::synap-section{id="a"}\n:::synap-ask\n\`\`\`json\n${ASK}\n\`\`\`\nprose\n:::::`;
    // closed only by its parent: not materializable
    expect(scanAskDefinitions(md).problems[0]!.message).toMatch(/never closed/);
  });

  it("a fake directive inside a code fence is NOT materialized", () => {
    const md = [
      "Example:",
      "",
      "````md",
      definition(),
      "````",
      "",
      "End.",
    ].join("\n");
    expect(scanAskDefinitions(md)).toEqual({ definitions: [], problems: [] });
  });

  it("a definition nested in another ask's fallback is that ask's prose", () => {
    // hand-build: an outer ask whose fallback holds a definition
    const md = [
      "::::synap-ask",
      "```json",
      ASK,
      "```",
      definition(),
      "::::",
    ].join("\n");
    const scan = scanAskDefinitions(md);
    expect(scan.definitions).toHaveLength(1);
    expect(scan.definitions[0]!.startLine).toBe(0);
    expect(scan.definitions[0]!.fallback).toContain(":::synap-ask");
  });

  it("an opener with leading spaces is a problem: the renderer does not read it as the same block", () => {
    const md = definition()
      .split("\n")
      .map((l) => `  ${l}`)
      .join("\n");
    const scan = scanAskDefinitions(md);
    expect(scan.definitions).toEqual([]);
    expect(scan.problems[0]?.message).toMatch(/beginning of a line/);
  });

  it("only a first info word `json` is the props block (what readEmbed reads): ```json-x is not", () => {
    expect(
      scanAskDefinitions(definition().replace("```json", "```json-x"))
    ).toEqual({ definitions: [], problems: [] });
    // `json` followed by more info words is still the renderer's props block.
    expect(
      scanAskDefinitions(definition().replace("```json", "```json title=x"))
        .definitions
    ).toHaveLength(1);
  });

  it("a definition inside an HTML comment is a problem (the renderer hides it, this scanner would not)", () => {
    const scan = scanAskDefinitions(`<!--\n${definition()}\n-->`);
    expect(scan.definitions).toEqual([]);
    expect(scan.problems[0]?.message).toMatch(/HTML comment/);
    // …and after the comment closes it is a definition again.
    expect(
      scanAskDefinitions(`<!-- note -->\n${definition()}`).definitions
    ).toHaveLength(1);
  });

  it("two definitions are both found, in order; one inside a section too", () => {
    const md = [
      definition(),
      "",
      ':::::synap-section{id="s"}',
      definition(ASK.replace("which-database", "which-cache")),
      ":::::",
    ].join("\n");
    const scan = scanAskDefinitions(md);
    expect(scan.definitions.map((d) => d.props.key)).toEqual([
      "which-database",
      "which-cache",
    ]);
  });
});

describe("rewriteAskDefinitions", () => {
  it("writes exactly what serializeEmbed writes for the reference form", () => {
    const md = `# Plan\n\n${definition()}\n\nAfter.`;
    const [d] = scanAskDefinitions(md).definitions;
    const out = rewriteAskDefinitions(md, [
      { definition: d!, sessionId: SESSION, slot: "which-database" },
    ]);
    const expected = serializeEmbed({
      directive: "synap-ask",
      ref: { sessionId: SESSION, slot: "which-database" },
      fallback: "Which database do you prefer?",
    });
    expect(out).toBe(`# Plan\n\n${expected}\n\nAfter.`);
    expect(out).toContain(
      `:::synap-ask{sessionId="${SESSION}" slot="which-database"}`
    );
    expect(out).not.toContain("```json");
  });

  it("the result reads back as a valid reference with the prose as fallback; rescanning finds nothing (idempotent)", () => {
    const md = definition();
    const [d] = scanAskDefinitions(md).definitions;
    const out = rewriteAskDefinitions(md, [
      { definition: d!, sessionId: SESSION, slot: "which-database" },
    ]);
    const e = embedOf(out);
    expect(e.ref).toEqual({ sessionId: SESSION, slot: "which-database" });
    expect(e.diagnostics).toEqual([]);
    expect(scanAskDefinitions(out)).toEqual({ definitions: [], problems: [] });
    expect(rewriteAskDefinitions(out, [])).toBe(out);
  });

  it("rewrites several definitions without shifting each other's lines", () => {
    const md = [
      definition(),
      "",
      "mid",
      "",
      definition(ASK.replace("which-database", "b"), "Second?"),
    ].join("\n");
    const scan = scanAskDefinitions(md);
    const out = rewriteAskDefinitions(
      md,
      scan.definitions.map((definition, i) => ({
        definition,
        sessionId: SESSION,
        slot: `k${i}`,
      }))
    );
    expect(out).toContain(`slot="k0"`);
    expect(out).toContain(`slot="k1"`);
    expect(out).toContain("mid");
    expect(out).toContain("Second?");
    expect(scanAskDefinitions(out).definitions).toEqual([]);
  });

  it("keeps a fallback with nested embeds and fences byte-for-byte", () => {
    const prose = [
      "See:",
      "",
      '::::synap-entity{id="e1"}',
      "Fallback",
      "::::",
    ].join("\n");
    const md = definition(ASK, prose)
      .replace(":::synap-ask", ":::::synap-ask")
      .replace(/\n:::$/, "\n:::::");
    const [d] = scanAskDefinitions(md).definitions;
    const out = rewriteAskDefinitions(md, [
      { definition: d!, sessionId: SESSION, slot: "which-database" },
    ]);
    expect(out).toContain('::::synap-entity{id="e1"}');
    expect(embedOf(out).ref).toEqual({
      sessionId: SESSION,
      slot: "which-database",
    });
  });
});

describe("readEmbed on an unmaterialized definition", () => {
  it("stays a missing-ref error, and says what happened", () => {
    const e = embedOf(definition());
    const d = e.diagnostics.find((x) => x.code === "missing-ref");
    expect(d?.severity).toBe("error");
    expect(d?.message).toBe(ASK_DEFINITION_UNMATERIALIZED);
  });

  it("a bare synap-ask keeps the original sentence (reference rule not weakened)", () => {
    const e = embedOf(':::synap-ask{sessionId="x"}\nprose\n:::');
    expect(
      e.diagnostics.find((x) => x.code === "missing-ref")?.message
    ).toMatch(/sessionId and slot/);
  });
});
