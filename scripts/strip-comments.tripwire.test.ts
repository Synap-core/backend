/**
 * Proves the byte copy of strip-comments.mjs in this repo's runner.
 *
 * `strip-comments.mjs` + `.d.mts` here are BYTE COPIES of the canonical file
 * in synap-app (`packages/design-tokens/scripts/`). Never edit the copy: a fix
 * goes to the canonical file and every copy follows (`cmp` them).
 *
 * These are the canonical self-test's hand cases, each a way the old
 * `/\/\*[\s\S]*?\*\//g` strip, or a careless scanner, gets it wrong. The
 * TypeScript-parser differential stays in synap-app (it proves the scanner, not
 * the copy). Named `*.tripwire.test.ts` so `pnpm tripwires` (CI) runs it.
 */
import { describe, expect, it } from "vitest";
import { stripComments } from "./strip-comments.mjs";

const NAIVE = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");

/** The test's own blanking, so a case reads as "these chars are comment". */
const blankOf = (s: string) => s.replace(/[^\n\r]/g, " ");

describe("stripComments — hand cases (byte copy of the synap-app scanner)", () => {
  it("a glob string opens no comment: `'image/*'` before real code", () => {
    const src = [
      "<input accept={['image/*', 'video/*']} />",
      "const hunted = <Sparkles />;",
      "/* a real comment */",
      "done();",
    ].join("\n");
    const out = stripComments(src, "ts");
    expect(out).toContain("'image/*', 'video/*'");
    expect(out).toContain("const hunted = <Sparkles />;");
    expect(out).not.toContain("a real comment");
    expect(out).toContain("done();");
    // The defect this helper exists for: the naive strip eats the hunted code.
    expect(NAIVE(src)).not.toContain("<Sparkles />");
  });

  it("`*/*` inside a template is template text, not a comment", () => {
    const src = "const accept = `*/*`;\nconst hunted = 1;\n/* c */ end();";
    const out = stripComments(src, "ts");
    expect(out).toContain("`*/*`");
    expect(out).toContain("const hunted = 1;");
    expect(out).not.toContain("/* c */");
    expect(out).toContain("end();");
  });

  it("a URL in a string survives; the trailing // comment goes", () => {
    const out = stripComments(
      'const u = "https://x.test/a"; // was //old',
      "ts"
    );
    expect(out).toBe(
      'const u = "https://x.test/a";' + blankOf(" // was //old")
    );
  });

  it("a regex literal holding `/*` is kept whole", () => {
    const src = "const re = /a\\/*b/g; // tail\nkeep();";
    const out = stripComments(src, "ts");
    expect(out).toContain("/a\\/*b/g;");
    expect(out).not.toContain("tail");
    expect(out).toContain("keep();");
  });

  it("a regex after a keyword, and a `/` inside a character class", () => {
    const src = "function f(x) { return /[/*]/.test(x) } // c\n/* d */ g();";
    const out = stripComments(src, "ts");
    expect(out).toContain("return /[/*]/.test(x) }");
    expect(out).not.toContain("// c");
    expect(out).not.toContain("/* d */");
    expect(out).toContain("g();");
  });

  it("a division is not a regex: `a / b /* c */`", () => {
    expect(stripComments("x = a / b /* c */ + 1;", "ts")).toBe(
      "x = a / b " + blankOf("/* c */") + " + 1;"
    );
    expect(stripComments("y = f(a) / 2 / g; // z", "ts")).toBe(
      "y = f(a) / 2 / g;" + blankOf(" // z")
    );
  });

  it("nested templates: `${}` holding strings and templates that hold `}` and `/*`", () => {
    const src =
      "const s = `a ${cond ? `b ${'}'} /* text */` : \"}\"} c /* text */`; /* gone */ next();";
    const out = stripComments(src, "ts");
    expect(out).toContain(
      "`a ${cond ? `b ${'}'} /* text */` : \"}\"} c /* text */`;"
    );
    expect(out).not.toContain("gone");
    expect(out).toContain("next();");
  });

  it("a comment inside a `${}` substitution is code-side, so it goes", () => {
    const out = stripComments("`x ${ a /* inner */ } y`", "ts");
    expect(out).toBe("`x ${ a " + blankOf("/* inner */") + " } y`");
  });

  it("strings keep escaped quotes and comment-looking text", () => {
    const src = "const s = 'it\\'s /* not */ // a comment'; // real";
    expect(stripComments(src, "ts")).toBe(
      "const s = 'it\\'s /* not */ // a comment';" + blankOf(" // real")
    );
  });

  it("PRESERVES OFFSETS AND LINES: same length, every line break where it was", () => {
    const src =
      "a();\n/**\n * doc\n * more\n */\nb(); // t\r\nc(/* x\n y */);\n";
    const out = stripComments(src, "ts");
    expect(out.length).toBe(src.length);
    const breaks = (s: string) =>
      [...s].flatMap((c, i) => (c === "\n" || c === "\r" ? [i] : []));
    expect(breaks(out)).toEqual(breaks(src));
    expect(out.split("\n")[5]).toBe("b();     \r");
    expect(out.indexOf("c(")).toBe(src.indexOf("c("));
  });

  it("JSX: `{/* … */}` is a comment, `</tag>` is not a regex", () => {
    const src =
      "return (<div>\n  {/* note: it's here */}\n  <a href={u}>go</a> // trailing\n</div>);";
    const out = stripComments(src, "ts");
    expect(out).not.toContain("note");
    expect(out).toContain("<a href={u}>go</a>");
    expect(out).not.toContain("trailing");
    expect(out).toContain("</div>);");
  });

  it("JSX text: `https://…`, `@scope/*` and an apostrophe never hide code", () => {
    const src = [
      "<p>See https://x.test/docs today</p>",
      "<li>80+ packages (@synap-core/* across core)</li>",
      "<p>Don't stop</p>",
      "const hunted = 1; /* c */",
    ].join("\n");
    const out = stripComments(src, "ts");
    expect(out.split("\n").slice(0, 3)).toEqual(src.split("\n").slice(0, 3));
    expect(out).toContain("const hunted = 1;");
    expect(out).not.toContain("/* c */");
  });

  it("an unterminated block comment runs to the end (JS semantics)", () => {
    expect(stripComments("a(); /* open\nb();", "ts")).toBe(
      "a(); " + blankOf("/* open\nb();")
    );
  });

  it('CSS: `content: "/*"` is a string, `//` is not a comment, url() is kept', () => {
    const src =
      '.a::before { content: "/*"; color: red; } /* real */\n.b { background: url(//cdn.x/*.png); }\n.c { x: 1 }';
    const out = stripComments(src, "css");
    expect(out).toContain('content: "/*"; color: red; }');
    expect(out).not.toContain("real");
    expect(out).toContain("url(//cdn.x/*.png)");
    expect(out).toContain(".c { x: 1 }");
    expect(NAIVE(src)).not.toContain("color: red");
  });

  it("refuses an unknown language instead of guessing", () => {
    expect(() => stripComments("x", "tsx" as never)).toThrow(/lang must be/);
  });
});
