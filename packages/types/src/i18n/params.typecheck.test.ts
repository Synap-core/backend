/**
 * The compile-time half of the translator: `t(key, params)` is checked against
 * the English message text. Test files are not type-checked by this package's
 * `tsc` (they are excluded) nor by vitest, so this test runs the TypeScript
 * compiler itself over a probe file and reads its diagnostics: every line
 * marked `// error` must fail to compile, every other line must compile.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE = join(HERE, "__probe__.ts");

const SOURCE = `
import { createT, type Catalog, type ParamsOf } from "./index.js";
import { seedEn, seedFr } from "./seed-catalog.js";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

const t = createT("fr", { en: seedEn, fr: seedFr });

t("seed.greeting");
t("seed.welcome", { name: "Ada" });
t("seed.welcome", { name: 42 });
t("seed.ideas.added", { n: 3 });
t("seed.items.inSpace", { n: 3, space: "Builder" });
t("seed.created", { kind: "task" });

t("seed.welcome"); // error: params required
t("seed.welcome", {}); // error: name missing
t("seed.welcome", { nme: "Ada" }); // error: misspelt param
t("seed.welcome", { name: "Ada", extra: 1 }); // error: unknown param
t("seed.ideas.added", { n: "3" }); // error: a plural takes a number
t("seed.created", { kind: 1 }); // error: a select takes a string
t("seed.items.inSpace", { n: 3 }); // error: space missing
t("seed.greeting", { name: "x" }); // error: no params on this message
t("seed.nope"); // error: unknown key

export const missingKey: Catalog<typeof seedEn> = { "seed.greeting": "x" }; // error: keys missing
export const extraKey: Catalog<{ readonly a: "A" }> = { a: "x", b: "y" }; // error: extra key

export const shapes: [
  Equal<ParamsOf<"Hello">, {}>,
  Equal<ParamsOf<"Hi {name}">, { name: string | number }>,
  Equal<ParamsOf<"{ name }, { other }">, { name: string | number; other: string | number }>,
  Equal<
    ParamsOf<"{n, plural, =0 {none} one {# {what}} other {# {what}s}} in {space}">,
    { n: number; what: string | number; space: string | number }
  >,
  Equal<
    ParamsOf<"{g, select, f {{n, plural, one {#} other {# {who}}}} other {x}}">,
    { g: string; n: number; who: string | number }
  >,
  Equal<ParamsOf<"{n, plural, one {#} other {#}} and {n}">, { n: number }>,
] = [true, true, true, true, true, true];
`;

function diagnose(): { line: number; text: string }[] {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.Node16,
    moduleResolution: ts.ModuleResolutionKind.Node16,
    lib: ["lib.es2022.d.ts"],
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, ...rest) =>
    fileName === PROBE
      ? ts.createSourceFile(fileName, SOURCE, languageVersion, true)
      : getSourceFile(fileName, languageVersion, ...rest);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (fileName) => fileName === PROBE || fileExists(fileName);
  const readFile = host.readFile.bind(host);
  host.readFile = (fileName) =>
    fileName === PROBE ? SOURCE : readFile(fileName);

  const program = ts.createProgram([PROBE], options, host);
  return ts.getPreEmitDiagnostics(program).map((d) => {
    if (!d.file || d.file.fileName !== PROBE) {
      throw new Error(
        `Diagnostic outside the probe: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`
      );
    }
    const { line } = d.file.getLineAndCharacterOfPosition(d.start ?? 0);
    return {
      line: line + 1,
      text: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
    };
  });
}

describe("t(key, params) is checked against the English message", () => {
  const diagnostics = diagnose();
  const lines = SOURCE.split("\n");
  const marked = lines
    .map((text, i) => ({ text, line: i + 1 }))
    .filter((l) => l.text.includes("// error"));

  it("the probe marks the cases it expects to fail", () => {
    expect(marked.length).toBe(11);
  });

  for (const { text, line } of marked) {
    it(`rejects: ${text.trim()}`, () => {
      expect(diagnostics.some((d) => d.line === line)).toBe(true);
    });
  }

  it("accepts every unmarked line, and ParamsOf reads the right shapes", () => {
    const markedLines = new Set(marked.map((m) => m.line));
    const unexpected = diagnostics.filter((d) => !markedLines.has(d.line));
    expect(unexpected).toEqual([]);
  });
});
