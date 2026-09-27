/**
 * TRIPWIRE — ONE frame set (columns.md §2.1, wave C0).
 *
 * "Is this `synap-*` container a FRAME (its children are document content) or
 * an EMBED (a reference with a fallback)?" has one answer: markdown-core's
 * `FRAME_DIRECTIVES` / `isFrameDirective`. It used to be answered by seven
 * private literal checks (`name === "synap-section"`, `new Set(["synap-section"])`)
 * across core, web, native, the editor and the diff; adding columns to each by
 * hand is how one of them silently reads a column as an embed.
 *
 * So outside `markdown-core/src`, no code COMPARES against a frame name
 * literal: an equality operand, a `case` label, an element of a list of names
 * (a hand-kept frame set), or the argument of `.has` / `.includes` /
 * `.startsWith` / `.indexOf`.
 *
 * Allowed, because they are not a frame test: a name used as a constant's
 * value, an object key (a component map), a JSX / parse-rule tag, a DOM spec
 * (`["synap-section", attrs, 0]`), a call argument naming what to render, a
 * regex (the section node's own tokenizer).
 *
 * Scan set: DERIVED — every non-test `.ts/.tsx/.js/.mjs` source under every
 * checked-out repo root, parsed with the TypeScript compiler.
 *
 * Blind spots (stated, measured): a comparison against a CONSTANT holding a
 * frame name (`c.name === SECTION_DIRECTIVE` in the api's section door) is
 * invisible — that one is a SECTION test (the section door's own unit), not a
 * frame test, and it is the right shape; a name assembled at runtime is
 * invisible too.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { FRAME_DIRECTIVES } from "./embeds.js";

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

/** The owner: core defines the set and may name its members. */
const CORE = "synap-backend/packages/markdown-core/src/";

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

const FRAMES = new Set<string>(FRAME_DIRECTIVES);
const EQUALITY = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);
const MEMBERSHIP = new Set(["has", "includes", "startsWith", "indexOf"]);

/** Every frame-name literal used as a frame TEST in one source file. */
function frameTests(fileName: string, src: string): string[] {
  const sf = ts.createSourceFile(
    fileName,
    src,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (
      (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) &&
      FRAMES.has(n.text)
    ) {
      const p = n.parent;
      const isTest =
        (ts.isBinaryExpression(p) && EQUALITY.has(p.operatorToken.kind)) ||
        ts.isCaseClause(p) ||
        // A list of names only (a hand-kept frame set). A mixed array — a
        // DOM spec `["synap-section", attrs, 0]` — is a tag, not a set.
        (ts.isArrayLiteralExpression(p) &&
          p.elements.every(
            (e) =>
              ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)
          )) ||
        (ts.isCallExpression(p) &&
          p.arguments.includes(n as ts.Expression) &&
          ts.isPropertyAccessExpression(p.expression) &&
          MEMBERSHIP.has(p.expression.name.text));
      if (isTest) {
        const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
        out.push(`${fileName}:${line + 1}: ${p.getText(sf).slice(0, 80)}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const files: string[] = [];
for (const r of ROOTS) walk(join(MONOREPO, r), files);

let mentioning = 0;
const hits: string[] = [];
for (const full of files) {
  const file = relative(MONOREPO, full);
  if (file.startsWith(CORE)) continue;
  const src = readFileSync(full, "utf8");
  if (!/synap-(section|columns?)\b/.test(src)) continue;
  mentioning++;
  hits.push(...frameTests(file, src));
}

describe("one frame set: the scan is looking (non-vacuity)", () => {
  it("walks every checked-out repo and reads files that name a frame", () => {
    expect(ROOTS.length).toBeGreaterThanOrEqual(4);
    expect(files.length).toBeGreaterThan(1000);
    // The section node, the web component map, the api section door, …
    expect(mentioning).toBeGreaterThanOrEqual(3);
  });

  it("sees each shape of a frame test, and not a constant, a key or a tag", () => {
    const sample = [
      'if (node.name === "synap-section") {}',
      'const a = "synap-column" !== n;',
      'switch (x) { case "synap-columns": break; }',
      'const S = new Set(["synap-section"]);',
      'NAMES.has("synap-section");',
      "const t = `synap-column` === n;",
      // not tests:
      'const DIRECTIVE = "synap-section";',
      'const m = { "synap-section": 1, tag: "synap-column" };',
      'render("synap-section", props);',
      'const spec = ["synap-section", mergeAttributes(a), 0];',
    ].join("\n");
    expect(frameTests("sample.ts", sample)).toHaveLength(6);
  });
});

describe("one frame set: no frame test outside markdown-core", () => {
  it("every frame / embed decision imports isFrameDirective", () => {
    expect(hits).toEqual([]);
  });
});
