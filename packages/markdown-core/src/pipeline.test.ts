/**
 * ONE PIPELINE, and prose survives every reader of it.
 *
 * Two guards:
 *  1. Every export of this package is CLASSIFIED (derived from the module, not
 *     hand-listed): either it is a markdown READER, with a probe that runs
 *     "Meet at 10:30" and "ratio:high" through it and demands the words come
 *     back, or it is explicitly not one. A new export that is neither fails
 *     here, so a new reader cannot skip the prose check by existing.
 *  2. No source file other than `processor.ts` builds a unified pipeline or
 *     imports the parser plugins (scanned set derived by readdir).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import * as core from "./index.js";

const PROSE =
  "Meet at 10:30 today; the ratio:high case, a ==highlighted== word, it costs $5 and $10.";
const DOC = `# Notes 10:30, $5 and $10\n\nMeet at 10:30 today; the ratio:high case.\n\n::::synap-section{id="s1"}\n## ratio:high\n\n${PROSE}\n::::\n`;

/** Every string a reader produced, however deep. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value))
      if (k !== "position") strings(v, out);
  }
  return out;
}

/** Text values only — for trees, where the source slice is not in play. */
function textValues(tree: unknown): string {
  const out: string[] = [];
  const walk = (n: any) => {
    if (
      typeof n?.value === "string" &&
      (n.type === "text" || n.type === "inlineCode")
    )
      out.push(n.value);
    for (const c of n?.children ?? []) walk(c);
  };
  walk(tree);
  return out.join("\n");
}

type Probe = () => string;

/** READERS: markdown in, a reading out. Each probe returns the prose it read back. */
const READERS: Record<string, Probe> = {
  parseMarkdown: () => textValues(core.parseMarkdown(DOC)),
  parseMarkdownWithDiagnostics: () =>
    textValues(core.parseMarkdownWithDiagnostics(DOC).tree),
  createMarkdownProcessor: () => {
    const p = core.createMarkdownProcessor();
    return textValues(p.runSync(p.parse(DOC), DOC));
  },
  markdownToPlainText: () => core.markdownToPlainText(DOC),
  // listSections returns SOURCE SLICES, so it passes by construction — kept
  // here so it stays classified as a reader, not because this probe can fail.
  listSections: () => strings(core.listSections(DOC)).join("\n"),
  // Titles only: `content`/`body` are source slices and would hide a loss.
  segmentSlides: () =>
    core
      .segmentSlides(DOC)
      .map((s) => s.title)
      .join("\n"),
  // Markdown out (source slices around each embed): kept as a reader so a
  // readable export can never drop prose the stored document has.
  readableMarkdown: () => core.readableMarkdown(DOC, () => "embed"),
  // The hast mapping runs after the pipeline; it must not reintroduce the loss.
  remarkSynapDirectives: () => {
    const p = core.createMarkdownProcessor().use(core.remarkSynapDirectives);
    return textValues(p.runSync(p.parse(DOC), DOC));
  },
};

/** NOT readers (or not of prose), and why. */
const NOT_READERS: Record<string, string> = {
  // markers: inline grammar over a single string, no directive parse involved
  REFERENCE_KINDS: "data",
  OPEN_PLACEMENTS: "data",
  OPEN_RESOURCE_TYPES: "data",
  sanitizeMarkerLabel: "writer helper",
  formatMarker: "writer",
  matchInlinePatterns: "inline grammar",
  parseInlinePatterns: "inline grammar",
  resolvePatternMarkers: "inline rewrite before a parse",
  isReferenceKind: "predicate",
  isReferencePattern: "predicate",
  referenceId: "accessor",
  splitInlineMarkers: "inline grammar",
  markerText: "inline grammar",
  flattenInlineMarkers: "inline grammar",
  // scanner: line-level, never reads prose (bound to micromark by conformance.test.ts)
  scanContainers: "line scanner",
  parseAttributes: "attribute grammar",
  parseContainerOpener: "line grammar",
  closerColons: "line grammar",
  splitLines: "line split",
  fenceColonsFor: "line scanner",
  decodeCharacterReferences: "attribute decoding",
  // pipeline parts: exercised through the readers above
  remarkRestoreProse: "plugin (in every reader)",
  remarkRepairEmbeds: "plugin (in every reader)",
  remarkGithubAlerts: "plugin (in every reader)",
  remarkHighlight: "plugin (in every reader)",
  remarkDisplayMath: "plugin (in every reader)",
  synapRemarkPlugins: "plugin list (in every reader)",
  ALERT_KINDS: "data",
  isMarkerHref: "predicate (a URL, no parse)",
  readAlertMarker: "reads one text line (the alert-marker rule), no parse",
  // embeds
  EMBED_DIRECTIVES: "data",
  REQUIRED_REF: "data",
  readEmbed: "reads a node, not markdown",
  serializeEmbed: "writer",
  serializeAttributes: "writer",
  assertSelfContainedBody: "writer guard",
  EmbedSerializeError: "error class",
  DIRECTIVE_ATTRIBUTES: "data",
  LEGACY_PROPS_ATTRIBUTES: "data",
  embedFallback: "reads parsed nodes",
  locateEmbeds: "embed source ranges (prose read through readableMarkdown)",
  DIAGNOSTIC_CODES: "data",
  collectDiagnostics: "diagnostics, no prose output",
  blame: "line diff over history, no parse",
  // diff: block/word diff over SOURCE SLICES — never parses, so prose cannot be lost
  matchSequences: "sequence matcher",
  splitMarkdownBlocks: "blank-line split (source slices)",
  diffWords: "word diff (source slices)",
  diffBlocks: "block diff (source slices)",
  hasBlockChanges: "predicate",
  isPlainProse: "predicate",
  wordDiffMarkdown: "writer",
  sectionContainerBody: "container strip (source slices)",
  diffSection: "block diff (source slices)",
};

describe("every export is classified", () => {
  const exported = Object.keys(core).sort();

  it("non-vacuous: the module exports a plausible surface", () => {
    expect(exported.length).toBeGreaterThan(30);
    expect(Object.keys(READERS).length).toBeGreaterThanOrEqual(6);
  });

  it("no export is unclassified, and no classification is stale", () => {
    const classified = new Set([
      ...Object.keys(READERS),
      ...Object.keys(NOT_READERS),
    ]);
    expect(exported.filter((k) => !classified.has(k))).toEqual([]);
    expect([...classified].filter((k) => !exported.includes(k))).toEqual([]);
  });
});

describe("prose survives every reader", () => {
  for (const [name, probe] of Object.entries(READERS)) {
    it(`${name}: "10:30", "ratio:high" and "$5 and $10" come back`, () => {
      const read = probe();
      expect(read).toContain("10:30");
      expect(read).toContain("ratio:high");
      expect(read).toContain("$5 and $10");
    });
  }

  // listSections / segmentSlides hand back SOURCE slices (a reader renders
  // them later), so a raw `==` there is correct; every other reader must
  // have turned the highlight into its text.
  const SOURCE_SLICES = new Set([
    "listSections",
    "segmentSlides",
    "readableMarkdown",
  ]);
  for (const [name, probe] of Object.entries(READERS)) {
    if (SOURCE_SLICES.has(name)) continue;
    it(`${name}: "==highlighted==" reads as its text, never raw ==`, () => {
      const read = probe();
      expect(read).toContain("highlighted");
      expect(read).not.toContain("==");
    });
  }

  it("synap-* text directives are still directives", () => {
    const tree = core.parseMarkdown("A :synap-entity[x]{id=e1} here.") as any;
    expect(tree.children[0].children.map((k: any) => k.type)).toEqual([
      "text",
      "textDirective",
      "text",
    ]);
  });
});

describe("unterminated repair", () => {
  it("hoists an unclosed embed's prose back to its parent, keeping the props block", () => {
    const md = [
      '::::synap-section{id="a"}',
      ':::synap-cell{cellKey="c"}',
      "```json",
      '{"a":1}',
      "```",
      "Prose after the unclosed embed.",
      "::::",
    ].join("\n");
    const { tree, diagnostics } = core.parseMarkdownWithDiagnostics(md);
    const section = tree.children[0] as any;
    expect(section.children.map((c: any) => c.type)).toEqual([
      "containerDirective",
      "paragraph",
    ]);
    expect(section.children[0].children.map((c: any) => c.type)).toEqual([
      "code",
    ]);
    expect(core.readEmbed(section.children[0])?.props).toEqual({ a: 1 });
    expect(diagnostics.map((d) => d.code)).toEqual(["unterminated-embed"]);
  });

  it("leaves a closed embed's fallback where it is", () => {
    const tree = core.parseMarkdown(
      ':::synap-entity{id="e"}\nFallback words.\n:::\nAfter.'
    ) as any;
    expect(tree.children.map((c: any) => c.type)).toEqual([
      "containerDirective",
      "paragraph",
    ]);
    expect(tree.children[0].children.map((c: any) => c.type)).toEqual([
      "paragraph",
    ]);
  });

  it("an embed implicitly closed by its parent's fence is unterminated even though a colon line ends it", () => {
    const tree = core.parseMarkdown(
      '::::synap-section{id="s"}\n:::synap-cell{cellKey="c"}\nswallowed?\n::::'
    ) as any;
    expect(tree.children[0].children.map((c: any) => c.type)).toEqual([
      "containerDirective",
      "paragraph",
    ]);
  });
});

describe("GitHub alerts", () => {
  it("marks the blockquote and removes the marker", () => {
    const tree = core.parseMarkdown("> [!WARNING]\n> Mind the gap.") as any;
    const quote = tree.children[0];
    expect(quote.data.alert).toBe("warning");
    expect(textValues(quote)).toBe("Mind the gap.");
  });

  it("a plain blockquote is untouched", () => {
    const tree = core.parseMarkdown("> [!nope] text") as any;
    expect(tree.children[0].data).toBeUndefined();
  });
});

describe("one pipeline factory (tripwire)", () => {
  const SRC = fileURLToPath(new URL("./", import.meta.url));
  const files = readdirSync(SRC).filter(
    (f) => /\.ts$/.test(f) && !f.endsWith(".test.ts")
  );
  const PIPELINE_IMPORT =
    /from\s+["'](unified|remark-parse|remark-directive|remark-gfm|remark-stringify|react-markdown)["']/;

  it("non-vacuous: scans the package source and can see a pipeline import", () => {
    expect(files.length).toBeGreaterThanOrEqual(9);
    expect(PIPELINE_IMPORT.test(`import { unified } from "unified";`)).toBe(
      true
    );
  });

  it("only processor.ts builds a pipeline", () => {
    const offenders = files.filter(
      (f) =>
        f !== "processor.ts" &&
        PIPELINE_IMPORT.test(readFileSync(join(SRC, f), "utf-8"))
    );
    expect(offenders).toEqual([]);
  });
});
