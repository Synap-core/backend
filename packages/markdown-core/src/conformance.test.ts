/**
 * CONFORMANCE TRIPWIRE: micromark ≡ the line scanner, over a shared corpus.
 *
 * There are two parsers on purpose (see `scan.ts`): micromark for meaning, the
 * line scanner for byte-preserving splices and the editor's tokenizer. This
 * binds them. Every fixture is parsed both ways and must yield the SAME
 * containers — name, attributes, start line, end line, depth — and the
 * pipeline's unterminated-embed repair must flag exactly the embeds the
 * scanner calls unterminated.
 *
 * It proves SAMENESS, never correctness (guards-and-tests.md): two readers
 * agreeing on a wrong rule are green. Correctness comes from the fixtures
 * themselves and from `scan.test.ts` / `embeds.test.ts`, which assert the
 * expected reading of the tricky lines.
 *
 * The corpus is DERIVED: every `.md` under `__fixtures__/corpus/`, plus the
 * closing-report golden the api package pins its builder to. A new fixture
 * joins by existing.
 *
 * NOT covered, measured: containers inside list items / block quotes (the
 * scanner reads them as root-level; no Synap writer produces them).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createMarkdownProcessor, parseMarkdown } from "./processor.js";
import { scanContainers } from "./scan.js";
import { EMBED_DIRECTIVES } from "./embeds.js";

const CORPUS_DIR = fileURLToPath(
  new URL("./__fixtures__/corpus/", import.meta.url)
);
const CLOSING_GOLDEN = fileURLToPath(
  new URL(
    "../../api/src/services/session-document/__fixtures__/closing-report.golden.md",
    import.meta.url
  )
);

export function loadCorpus(): Array<{ name: string; markdown: string }> {
  const files = readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({
      name: f,
      markdown: readFileSync(join(CORPUS_DIR, f), "utf-8"),
    }));
  files.push({
    name: "closing-report.golden.md",
    markdown: readFileSync(CLOSING_GOLDEN, "utf-8"),
  });
  return files;
}

interface Shape {
  name: string;
  attributes: Record<string, string>;
  startLine: number;
  endLine: number;
  depth: number;
}

/** micromark's reading: PARSE only (no transforms), every container at every depth. */
function micromarkContainers(markdown: string): Shape[] {
  const tree = createMarkdownProcessor().parse(markdown) as any;
  const out: Shape[] = [];
  const walk = (node: any, depth: number) => {
    for (const child of node.children ?? []) {
      if (child.type === "containerDirective") {
        const attributes: Record<string, string> = {};
        for (const [k, v] of Object.entries(child.attributes ?? {})) {
          if (typeof v === "string") attributes[k] = v;
        }
        out.push({
          name: child.name,
          attributes,
          startLine: child.position.start.line - 1,
          endLine: child.position.end.line - 1,
          depth,
        });
        walk(child, depth + 1);
      } else {
        walk(child, depth);
      }
    }
  };
  walk(tree, 0);
  return out.sort((a, b) => a.startLine - b.startLine);
}

function scannerContainers(markdown: string): Shape[] {
  return scanContainers(markdown).containers.map((c) => ({
    name: c.name,
    attributes: c.attributes,
    startLine: c.startLine,
    endLine: c.endLine,
    depth: c.depth,
  }));
}

/** Embeds the pipeline's repair flagged, as `name@startLine` (0-based). */
function repairedEmbeds(markdown: string): string[] {
  const out: string[] = [];
  const walk = (node: any) => {
    for (const child of node.children ?? []) {
      if (
        child.type === "containerDirective" &&
        child.data?.synapUnterminated
      ) {
        out.push(`${child.name}@${child.position.start.line - 1}`);
      }
      walk(child);
    }
  };
  walk(parseMarkdown(markdown));
  return out.sort();
}

function scannerUnterminatedEmbeds(markdown: string): string[] {
  const embeds = new Set<string>(EMBED_DIRECTIVES);
  return scanContainers(markdown)
    .containers.filter(
      (c) =>
        !c.terminated &&
        (embeds.has(c.name) ||
          (c.name.startsWith("synap-") && c.name !== "synap-section"))
    )
    .map((c) => `${c.name}@${c.startLine}`)
    .sort();
}

const corpus = loadCorpus();

describe("conformance corpus", () => {
  it("is non-vacuous: every required fixture class is present and has containers", () => {
    const names = corpus.map((f) => f.name);
    for (const required of [
      "closing-report.golden.md",
      "generator-example.md",
      "apostrophes.md",
      "colons-in-fences.md",
      "colon-nesting.md",
      "unterminated.md",
      "math-fences.md",
    ]) {
      expect(names).toContain(required);
    }
    const total = corpus.reduce(
      (n, f) => n + micromarkContainers(f.markdown).length,
      0
    );
    expect(total).toBeGreaterThanOrEqual(30);
    // And the repair has something to agree about.
    const flagged = corpus.reduce(
      (n, f) => n + repairedEmbeds(f.markdown).length,
      0
    );
    expect(flagged).toBeGreaterThanOrEqual(4);
  });

  it("the golden exists (a missing producer file is a failure, not a skip)", () => {
    expect(existsSync(CLOSING_GOLDEN)).toBe(true);
  });

  for (const fixture of corpus) {
    describe(fixture.name, () => {
      it("scanner containers ≡ micromark containers (name, attrs, extent, depth)", () => {
        expect(scannerContainers(fixture.markdown)).toEqual(
          micromarkContainers(fixture.markdown)
        );
      });

      it("the repair flags exactly the embeds the scanner calls unterminated", () => {
        expect(repairedEmbeds(fixture.markdown)).toEqual(
          scannerUnterminatedEmbeds(fixture.markdown)
        );
      });
    });
  }
});
