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
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stripComments } from "./strip-comments.mjs";

const NAIVE = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");

/** The test's own blanking, so a case reads as "these chars are comment". */
const blankOf = (s: string) => s.replace(/[^\n\r]/g, " ");

/**
 * The canonical scanner's content hash (synap-app
 * packages/design-tokens/scripts/strip-comments.test.ts pins the same value).
 * This file is a byte copy: edited here, it fails this test. Change the
 * canonical, copy it to every repo, then update every pin.
 */
const STRIP_COMMENTS_SHA256 =
  "bad4c8051268e3d69f9fe9198e66879726f64f8b28cf4bbeaa36359ef181c925";

describe("stripComments — byte copy of the pinned canonical", () => {
  it("strip-comments.mjs hashes to STRIP_COMMENTS_SHA256", () => {
    const bytes = readFileSync(
      fileURLToPath(new URL("./strip-comments.mjs", import.meta.url))
    );
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      STRIP_COMMENTS_SHA256
    );
  });
});

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

  it("JSX text: a glob `src/**\/*.tsx` opens no comment (a block opener glued to `*`)", () => {
    const src = [
      "export const Help = () => (",
      "  <p>Matches <code>src/**/*.tsx</code> files</p>",
      ");",
      "export const Mark = () => <Sparkles size={12} />;",
      "/* end */",
    ].join("\n");
    const out = stripComments(src, "ts");
    expect(out).toContain("<code>src/**/*.tsx</code>");
    expect(out).toContain("<Sparkles size={12} />");
    expect(out).not.toContain("end");
  });

  it("a `}` that ends its line is followed by a statement: `/a\\/*b/` there is a regex", () => {
    const src = "const f = () => {}\n/a\\/*b/.test(s); hunted();\n/* x */";
    const out = stripComments(src, "ts");
    expect(out).toContain("/a\\/*b/.test(s); hunted();");
    expect(out).not.toContain("/* x */");
    // A mid-line `}` is still a value: the `/` after it divides, the comment goes.
    expect(stripComments("const r = {a}/2; /* c */", "ts")).toBe(
      "const r = {a}/2; " + blankOf("/* c */")
    );
  });

  // STILL MISREAD — pinned so a fix (or a regression) is seen, and the header's
  // list is updated with it. Both are JSX TEXT, which the scanner does not parse.
  it("still misread: `//` in JSX text blanks the rest of that line, code included", () => {
    const out = stripComments(
      "const A = () => <p>and/or // either</p>; const hunted = <Sparkles />;",
      "ts"
    );
    expect(out).not.toContain("hunted");
  });

  it("still misread: a backtick in JSX text opens a template until the next backtick", () => {
    const src =
      "<p>press ` to open</p>;\nconst a = 1; // kept as template text\nconst t = `x`;";
    expect(stripComments(src, "ts")).toContain("// kept as template text");
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
