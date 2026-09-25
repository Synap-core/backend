/**
 * TRIPWIRES — the markdown spine's WRITE rules hold in every repo (plan §5.2 W7).
 *
 *  1. No embed-directive writer outside `serializeEmbed`. Three hand-rolled
 *     writers once each dropped `"`/`{`/`}` with a different rule (plan §1 #1).
 *     The only other directive writers allowed are the two SECTION writers
 *     (the backend splice and the editor node), and they must write through
 *     core's `serializeAttributes`.
 *  2. No `@label (id)` mention writer: inline references are `[[kind:id|label]]`
 *     only (plan §3, D-refs). The legacy form is READ, never written.
 *  3. One markdown pipeline factory on the pod side: in synap-backend, the IS
 *     and the CLI, only `processor.ts` imports a markdown parser (the
 *     remark/micromark family, or marked / markdown-it). The web side is
 *     markdown-engine's `one-pipeline.test.ts` (W7b).
 *
 * Scan set: DERIVED by walking every repo's source roots, with non-test
 * `.ts/.tsx/.js/.mjs` and no build output. Each file is parsed with the
 * TypeScript compiler. Every template literal WITH substitutions, and every
 * `+` chain holding a non-literal operand, is rebuilt as text (`${…}` stands in
 * for each expression) and tested. Static strings are NOT writers: prompts and
 * skill examples that teach the grammar are static.
 *
 * Blind spots (stated): a directive assembled through `.join()` of separate
 * literals, or a colon run held in a variable not named like `colons`/`fence`,
 * is invisible. A sibling repo that is absent is skipped, never counted green.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const MONOREPO = join(import.meta.dirname, "..", "..", "..", "..");
const ROOTS = [
  "synap-backend/packages",
  "synap-backend/apps",
  "synap-intelligence-service/apps",
  "synap-cli/src",
  "synap-app/packages",
  "synap-app/apps",
  "browser/electron",
  "relay-app/src",
  "relay-app/app",
].filter((r) => existsSync(join(MONOREPO, r)));

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "generated",
  "__tests__",
  "__fixtures__",
]);

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (
      /\.(ts|tsx|mjs|js)$/.test(name) &&
      !/\.(test|spec)\.|\.d\.ts$|\.tripwire\./.test(name)
    )
      out.push(full);
  }
}

/** Rebuilt dynamic strings of one source file (templates + `+` chains). */
function dynamicStrings(fileName: string, src: string): string[] {
  const sf = ts.createSourceFile(
    fileName,
    src,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const out: string[] = [];
  const piece = (n: ts.Node): string | null =>
    ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)
      ? n.text
      : null;
  const flatten = (n: ts.Expression, acc: ts.Expression[]) => {
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      flatten(n.left, acc);
      flatten(n.right, acc);
    } else acc.push(ts.isParenthesizedExpression(n) ? n.expression : n);
  };
  const visit = (n: ts.Node) => {
    if (ts.isTemplateExpression(n)) {
      let text = n.head.text;
      for (const span of n.templateSpans)
        text += "${" + span.expression.getText(sf) + "}" + span.literal.text;
      out.push(text);
    } else if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      !(
        ts.isBinaryExpression(n.parent) &&
        n.parent.operatorToken.kind === ts.SyntaxKind.PlusToken
      )
    ) {
      const parts: ts.Expression[] = [];
      flatten(n, parts);
      const literal = parts.map(piece);
      if (literal.some((p) => p !== null) && literal.some((p) => p === null))
        out.push(
          parts.map((p, i) => literal[i] ?? "${" + p.getText(sf) + "}").join("")
        );
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** A directive OPENER built at runtime: a line-start colon run, then a name. */
const DIRECTIVE_WRITE =
  /(?:^|\n)[ \t]*(?::{2,}|\$\{[^}]*(?:colon|fence|":"\.repeat)[^}]*\})(?:synap-|\$\{)/i;
/** The legacy mention form `@label (id)`. */
const MENTION_WRITE = /@\$\{[^}]*\}\s*\(\s*\$\{[^}]*\}\s*\)/;

const EMBED_WRITER = "synap-backend/packages/markdown-core/src/embeds.ts";
/** Section writers: `synap-section` is a frame, not an embed. Why each exists. */
const SECTION_WRITERS: Record<string, string> = {
  "synap-backend/packages/api/src/services/session-document/sections.ts":
    "the section door's splice (upsert by id)",
  "synap-app/packages/core/markdown-engine/src/components/editor/extensions/synap-section.tsx":
    "the editor's section node serializer",
};

interface Hit {
  file: string;
  text: string;
}

const files: string[] = [];
for (const r of ROOTS) walk(join(MONOREPO, r), files);

const directiveHits: Hit[] = [];
const mentionHits: Hit[] = [];
for (const full of files) {
  const src = readFileSync(full, "utf8");
  const mayWrite = /synap-|colons?\b|fence/.test(src);
  const mayMention = src.includes("@${") || /["']@["']/.test(src);
  if (!mayWrite && !mayMention) continue;
  const file = relative(MONOREPO, full);
  for (const text of dynamicStrings(file, src)) {
    if (mayWrite && DIRECTIVE_WRITE.test(text))
      directiveHits.push({ file, text });
    if (mayMention && MENTION_WRITE.test(text))
      mentionHits.push({ file, text });
  }
}

describe("tripwire scan is looking (non-vacuity)", () => {
  it("walks every repo that is checked out", () => {
    expect(ROOTS.length).toBeGreaterThanOrEqual(4);
    expect(files.length).toBeGreaterThan(1000);
  });

  it("the rebuilt-text extractor sees a template writer, a + chain and a mention", () => {
    const sample = [
      'const a = `:::synap-cell{cellKey="${k}"}`;',
      'const b = ":::" + name + "{}";',
      "const c = `${colons}synap-view`;",
      "const d = `@${label} (${id})`;",
      'const e = "@" + label + " (" + id + ")";',
      'const f = ":::synap-view{viewId=\\"x\\"}";',
    ].join("\n");
    const found = dynamicStrings("sample.ts", sample);
    expect(found.filter((t) => DIRECTIVE_WRITE.test(t))).toHaveLength(3);
    expect(found.filter((t) => MENTION_WRITE.test(t))).toHaveLength(2);
    // key separators (`${a}::${b}`) and diagnostics ("`:::x` is never closed") are not writers
    expect(DIRECTIVE_WRITE.test("${a}::${b}")).toBe(false);
    expect(DIRECTIVE_WRITE.test("\\`:::${name}\\` is never closed")).toBe(
      false
    );
  });

  it("finds the one embed writer and every allowed section writer (no stale entry)", () => {
    const writers = new Set(directiveHits.map((h) => h.file));
    expect(writers.has(EMBED_WRITER)).toBe(true);
    for (const f of Object.keys(SECTION_WRITERS))
      if (existsSync(join(MONOREPO, f))) expect(writers.has(f), f).toBe(true);
  });
});

describe("tripwire: one embed writer (serializeEmbed)", () => {
  it("no directive is written anywhere else", () => {
    const offenders = directiveHits
      .filter((h) => h.file !== EMBED_WRITER && !(h.file in SECTION_WRITERS))
      .map((h) => `${h.file}: ${h.text.slice(0, 80)}`);
    expect(offenders).toEqual([]);
  });

  it("section writers write their attributes through serializeAttributes", () => {
    for (const h of directiveHits.filter((x) => x.file in SECTION_WRITERS))
      expect(h.text, h.file).toContain("serializeAttributes(");
  });
});

describe("tripwire: no `@label (id)` mention writer", () => {
  it("the legacy mention form is never written", () => {
    expect(mentionHits.map((h) => `${h.file}: ${h.text}`)).toEqual([]);
  });
});

// ─── 3. one pipeline factory (pod side) ─────────────────────────────────────

const POD_SIDE = /^(synap-backend|synap-intelligence-service|synap-cli)\//;
const PIPELINE_IMPORT =
  /(?:from\s+|import\(\s*|require\(\s*)["'](unified|remark-[a-z-]+|rehype-[a-z-]+|micromark[^"']*|mdast-util-from-markdown|marked|markdown-it)["']/;
const FACTORY = "synap-backend/packages/markdown-core/src/processor.ts";
/** Other parsers on the pod side, each with why it is not a second pipeline. */
const OTHER_PARSERS: Record<string, string> = {
  "synap-intelligence-service/apps/cli/src/utils/markdown.ts":
    "the `synap-chat` terminal client renders chat replies as ANSI (marked-terminal); chat replies carry no directives (skill rule), and nothing it renders is stored",
};

const pipelineFiles = files
  .map((full) => relative(MONOREPO, full))
  .filter(
    (f) =>
      POD_SIDE.test(f) &&
      PIPELINE_IMPORT.test(
        // A type-only import (mdast node augmentation) runs no parser.
        readFileSync(join(MONOREPO, f), "utf8").replace(
          /^import type [^;]*;$/gm,
          ""
        )
      )
  );

describe("tripwire: one markdown pipeline factory (pod side)", () => {
  it("non-vacuous: sees the factory and can match an import", () => {
    expect(pipelineFiles).toContain(FACTORY);
    expect(
      PIPELINE_IMPORT.test('import remarkParse from "remark-parse";')
    ).toBe(true);
    expect(PIPELINE_IMPORT.test('await import("unified")')).toBe(true);
  });

  it("only processor.ts builds a pipeline; every other parser is named", () => {
    expect(
      pipelineFiles.filter((f) => f !== FACTORY && !(f in OTHER_PARSERS))
    ).toEqual([]);
    for (const f of Object.keys(OTHER_PARSERS))
      if (existsSync(join(MONOREPO, f)))
        expect(pipelineFiles, `stale: ${f}`).toContain(f);
  });
});
