/**
 * `@synap-core/types` imports nothing from `@synap/database`.
 *
 * WHY. This package is the wire: relay-app, synap-app and browser compile it
 * FROM SOURCE, and it is published to npm. While 17 of its files imported
 * `@synap/database` (row types, automation nodes, the pod-parity contracts),
 * every consumer silently needed the database package BUILT to typecheck:
 * relay's CI slice links it without building its declarations and went red
 * with 19 TS2307, and the published `.d.ts` pointed at a private package.
 * The edge now runs the other way: the database imports this package and
 * proves its inferred rows equal to the ones declared here
 * (`packages/database/src/wire-parity/`).
 *
 * WHAT IT SCANS. Every file the package's `tsconfig.json` compiles (derived
 * from the config, so a new file joins by existing; tests are excluded there
 * and here), parsed with the TypeScript compiler: `import … from`,
 * `export … from`, `import x = require()`, dynamic `import()` and type-level
 * `import("…")` — `import type` included, since a type import is what relay's
 * typecheck could not resolve. Plus `package.json`: no dependency field may name
 * the database (relay's slice links a member's devDependencies).
 *
 * WHAT IT DOES NOT SEE. A specifier built at runtime (`import(name)`) and test
 * files (`*.test.ts`, excluded from the build).
 */
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const FORBIDDEN = /^@synap\/database(\/|$)/;

/** Every module specifier a source file names, in any import form. */
export function moduleSpecifiers(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true
  );
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      out.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      out.push(node.moduleReference.expression.text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      out.push(node.argument.literal.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require")) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      out.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function compiledFiles(): string[] {
  const configPath = join(PKG, "tsconfig.json");
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error)
    throw new Error(
      ts.flattenDiagnosticMessageText(read.error.messageText, "\n")
    );
  return ts.parseJsonConfigFileContent(read.config, ts.sys, PKG).fileNames;
}

describe("@synap-core/types does not import @synap/database", () => {
  it("the scanner sees every import form (self-check)", () => {
    const sample = [
      'import type { A } from "@synap/database";',
      'import { B } from "@synap/database/schema";',
      'export type { C } from "@synap/database";',
      'export * from "@synap/database";',
      'type D = import("@synap/database").Workspace;',
      'const e = await import("@synap/database");',
      'import f = require("@synap/database");',
      'import { ok } from "@synap/database-tools";',
    ].join("\n");
    const hits = moduleSpecifiers("sample.ts", sample).filter((s) =>
      FORBIDDEN.test(s)
    );
    expect(hits).toHaveLength(7);
  });

  it("no compiled source file names the database package", () => {
    const files = compiledFiles();
    // Non-vacuity: the config resolved to the real package, tests excluded.
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((f) => f.endsWith("/src/index.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith(".test.ts"))).toBe(false);

    const offenders = files.flatMap((f) =>
      moduleSpecifiers(f, readFileSync(f, "utf8"))
        .filter((s) => FORBIDDEN.test(s))
        .map((s) => `${relative(PKG, f)} → ${s}`)
    );
    expect(offenders).toEqual([]);
  });

  it("package.json declares no dependency on the database package", () => {
    const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));
    const fields = [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ] as const;
    const named = fields.flatMap((field) =>
      Object.keys(pkg[field] ?? {})
        .filter((name) => FORBIDDEN.test(name))
        .map((name) => `${field}.${name}`)
    );
    expect(named).toEqual([]);
  });
});
