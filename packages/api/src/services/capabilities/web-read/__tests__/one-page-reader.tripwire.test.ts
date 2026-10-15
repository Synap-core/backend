/**
 * TRIPWIRE — one page reader. The pod reads a web page in ONE place
 * (`services/capabilities/web-read/`): one guarded fetch (`safePublicFetch`,
 * DNS-pinned), one Open Graph reading, one oEmbed table, one DOM extractor.
 * `read-public-url.ts` was a complete second reader beside it (weaker
 * `safeExternalFetch` guard, its own OG parser, its own result shape) and was
 * deleted; this fails if one grows back anywhere else in `packages/api/src`.
 *
 * Scanned set: DERIVED — every non-test `.ts` file under `packages/api/src`
 * (recursive glob), minus `web-read/` itself. Each file is PARSED with the
 * TypeScript parser, so comments never count (several files mention
 * "og:image" in prose) and only real string literals / identifiers do.
 *
 * Fails when, outside web-read/:
 *   1. a string literal names an Open Graph key (`og:title`, `og:image`, …);
 *   2. a string literal holds an oEmbed endpoint path (`/oembed`);
 *   3. a module imports the DOM extractor (`defuddle`, `linkedom`);
 *   4. one file both calls `safeExternalFetch` and asks for `text/html` — a
 *      page reader on the weaker guard.
 *
 * NOT covered (measured by reasoning, stated honestly): a reader built from
 * string concatenation (`"og:" + key`), or one that fetches HTML through
 * `safePublicFetch` without an OG/oEmbed literal. Those need review, not a scan.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const WEB_READ = join("services", "capabilities", "web-read") + sep;

const OG_KEY = /\bog:(title|description|image|site_name|url|type)\b/;
const OEMBED_PATH = /\/oembed\b/i;
const DOM_EXTRACTOR = /^(defuddle|linkedom)(\/|$)/;

interface Tokens {
  strings: string[];
  identifiers: Set<string>;
}

function tokens(source: string): Tokens {
  // The real parser, not the bare scanner: a bare scan mis-reads template
  // continuations and regex literals and then sees "strings" inside code.
  const file = ts.createSourceFile("f.ts", source, ts.ScriptTarget.Latest);
  const strings: string[] = [];
  const identifiers = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      strings.push(node.text);
    } else if (ts.isIdentifier(node)) {
      identifiers.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { strings, identifiers };
}

/** Every rule a file breaks (empty = clean). */
function pageReaderViolations(source: string): string[] {
  const { strings, identifiers } = tokens(source);
  const out: string[] = [];
  const og = strings.find((s) => OG_KEY.test(s));
  if (og) out.push(`Open Graph key literal ${JSON.stringify(og.slice(0, 60))}`);
  const oembed = strings.find((s) => OEMBED_PATH.test(s));
  if (oembed)
    out.push(`oEmbed endpoint literal ${JSON.stringify(oembed.slice(0, 80))}`);
  const dom = strings.find((s) => DOM_EXTRACTOR.test(s));
  if (dom) out.push(`imports the DOM extractor ${JSON.stringify(dom)}`);
  if (
    identifiers.has("safeExternalFetch") &&
    strings.some((s) => /\btext\/html\b/i.test(s))
  ) {
    out.push("fetches text/html through safeExternalFetch (unpinned)");
  }
  return out;
}

function sourceFiles(): string[] {
  return (readdirSync(SRC, { recursive: true }) as string[])
    .filter(
      (f) =>
        f.endsWith(".ts") &&
        !f.endsWith(".d.ts") &&
        !/\.test\.ts$/.test(f) &&
        !f.split(sep).includes("__tests__") &&
        !f.split(sep).includes("node_modules")
    )
    .map((f) => join(SRC, f));
}

describe("one page reader (web-read/) — no second reader outside it", () => {
  const files = sourceFiles();

  it("scans a plausible set (non-vacuity)", () => {
    expect(files.length).toBeGreaterThan(500);
    const inWebRead = files.filter((f) =>
      relative(SRC, f).startsWith(WEB_READ)
    );
    expect(inWebRead.length).toBeGreaterThan(8);
  });

  it("the scanner still sees what it hunts (self-check on the real reader + a literal sample)", () => {
    const read = (p: string) => readFileSync(join(SRC, WEB_READ, p), "utf8");
    expect(pageReaderViolations(read("extract.ts")).join()).toMatch(
      /Open Graph/
    );
    expect(pageReaderViolations(read("adapters/oembed.ts")).join()).toMatch(
      /oEmbed/
    );
    expect(pageReaderViolations(read("extract.ts")).join()).toMatch(
      /DOM extractor/
    );
    const sample = [
      'import { safeExternalFetch } from "@synap/shared-utils";',
      'const r = await safeExternalFetch(u, { headers: { Accept: "text/html" } });',
    ].join("\n");
    expect(pageReaderViolations(sample)).toEqual([
      "fetches text/html through safeExternalFetch (unpinned)",
    ]);
    // Prose is not code: a comment naming og:image is clean.
    expect(
      pageReaderViolations("// keeps the page's og:image\nconst x = 1;")
    ).toEqual([]);
  });

  it("no file outside web-read/ parses Open Graph, calls oEmbed, runs the DOM extractor or reads pages unpinned", () => {
    const offenders = files
      .filter((f) => !relative(SRC, f).startsWith(WEB_READ))
      .map((f) => ({
        file: relative(SRC, f),
        why: pageReaderViolations(readFileSync(f, "utf8")),
      }))
      .filter((v) => v.why.length > 0);
    expect(offenders).toEqual([]);
  });
});
