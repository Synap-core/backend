/**
 * strip-comments.mjs — THE comment stripper for source-scan tests and guards.
 * ===========================================================================
 *
 * A source scan strips comments first, so prose ABOUT a pattern is never
 * counted as the pattern. The naive way, `src.replace(/\/\*[\s\S]*?\*\//g, "")`,
 * is a proven defect: a string such as `'image/*'` or `` `*\/*` `` opens a fake
 * comment that swallows real code up to the next `*\/`. It once hid 4,211 chars
 * of a component (the code the guard was there to see), and the guard went
 * blind while staying green.
 *
 * This is a small scanner, not a regex. It walks the source once and knows
 * where it is: code, '…', "…", `…${ … }…` (nested to any depth), a regex
 * literal, a // comment or a block comment.
 *
 *   - Comment characters become spaces; every \n and \r is kept, so OFFSETS
 *     and LINE NUMBERS of the result match the input exactly.
 *   - Strings, templates and regex literals are kept intact.
 *   - lang "ts" (also .tsx/.js/.mjs): // and block comments, including JSX
 *     `{/* … *\/}`. lang "css": block comments only (// is not a CSS comment),
 *     quoted strings and unquoted `url(…)` are kept.
 *
 * Self-contained on purpose (no imports): other repos copy this file byte for
 * byte. Self-test + differential check against the TypeScript parser:
 * strip-comments.test.ts.
 *
 * Heuristics, stated (a scanner is not a parser):
 *   - A `/` starts a regex when the previous token is a punctuator or one of
 *     REGEX_AFTER_WORDS, or is a `}` that ends its line (a statement starts on
 *     the next one); after a name, number, string, `)`, `]` or a mid-line `}`
 *     it is a division. `</` is a JSX closing tag, never a regex.
 *   - JSX TEXT is not parsed. An apostrophe in it (`<p>Don't</p>`) opens a
 *     quoted string, which ends at the end of the line (a quoted string cannot
 *     span lines), so the cost is at most that one line not being stripped.
 *   - A `//` glued to a `:` (`https://` in JSX text) and a block opener glued to
 *     a name, `-` or `*` (`@synap-core/*`, `src/**\/*.tsx` in JSX text) are
 *     not comments. Measured with the TypeScript parser over synap-app,
 *     browser, relay, backend, IS, cli and CP (13,725 files): the helper blanks
 *     exactly the parser's comments in every file.
 *   - A misread heuristic usually UNDER-strips (prose left in, a noisy red).
 *     It does not always: the cases below can blank code, which reads as a
 *     silent green. Still misread, pinned as hand cases in the self-test:
 *       - `//` in JSX text (`<p>and/or // either</p>`) blanks the rest of
 *         that line, code included;
 *       - a backtick in JSX text opens a template that can span lines, and
 *         flips code and template text until the next backtick.
 */

const REGEX_AFTER_WORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

const isWordChar = (c) =>
  (c >= "a" && c <= "z") ||
  (c >= "A" && c <= "Z") ||
  (c >= "0" && c <= "9") ||
  c === "_" ||
  c === "$" ||
  c > "\u007f";
const isSpace = (c) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v" || c === "\ufeff" || c === "\u00a0";
/** `core/*`: a block opener glued to a name is a path glob in JSX text, never a comment (measured). */
const isGlued = (c) => c !== undefined && (isWordChar(c) || c === "-" || c === "*");
const NOT_EOL = /[^\n\r\u2028\u2029]/g;
const isEol = (c) => c === "\n" || c === "\r" || c === "\u2028" || c === "\u2029";

/**
 * @param {string} source
 * @param {"ts" | "css"} lang
 * @returns {string} `source` with every comment character replaced by a space
 *   (line breaks kept), same length, same line numbers.
 */
export function stripComments(source, lang) {
  if (lang !== "ts" && lang !== "css") throw new Error(`stripComments: lang must be "ts" or "css", got ${String(lang)}`);
  /** Comment spans [from, to), in source order; blanked once at the end. */
  const spans = [];
  const n = source.length;
  const blank = (from, to) => {
    spans.push(from, to);
  };
  const result = () => {
    if (!spans.length) return source;
    let out = "";
    let at = 0;
    for (let k = 0; k < spans.length; k += 2) {
      out += source.slice(at, spans[k]) + source.slice(spans[k], spans[k + 1]).replace(NOT_EOL, " ");
      at = spans[k + 1];
    }
    return out + source.slice(at);
  };
  /** Index just past a quoted string opened at `i`; stops at an unescaped line break. */
  const skipQuoted = (i) => {
    const q = source[i];
    let j = i + 1;
    while (j < n) {
      const c = source[j];
      if (c === "\\") j += 2;
      else if (c === q) return j + 1;
      else if (c === "\n" || c === "\r") return j;
      else j++;
    }
    return n;
  };
  /** Index just past a block comment opened at `i` (or the end of the source). */
  const skipBlock = (i) => {
    const end = source.indexOf("*/", i + 2);
    return end === -1 ? n : end + 2;
  };

  if (lang === "css") {
    let i = 0;
    while (i < n) {
      const c = source[i];
      if (c === "/" && source[i + 1] === "*") {
        const j = skipBlock(i);
        blank(i, j);
        i = j;
      } else if (c === '"' || c === "'") {
        i = skipQuoted(i);
      } else if ((c === "u" || c === "U") && /^url\(\s*[^\s"')]/i.test(source.slice(i, i + 6)) && !isWordChar(source[i - 1] ?? " ")) {
        const close = source.indexOf(")", i);
        i = close === -1 ? n : close + 1;
      } else i++;
    }
    return result();
  }

  // ── TS / JS ────────────────────────────────────────────────────────────────
  // `frames` holds one entry per open `${`: the brace depth inside it. A `}` at
  // depth 0 closes the substitution and resumes the template it came from.
  const frames = [];
  /** What the last significant token was, to tell a regex from a division. */
  let prev = "punct"; // "punct" | "value" | a word
  let prevChar = "";
  /** A line break since the last token: `}` then a new line opens a statement, so `/` is a regex. */
  let newLine = false;

  /** Scan a template body from `i` (just past "`" or "}"); returns where code resumes. */
  const scanTemplate = (i) => {
    while (i < n) {
      const c = source[i];
      if (c === "\\") i += 2;
      else if (c === "`") {
        prev = "value";
        return i + 1;
      } else if (c === "$" && source[i + 1] === "{") {
        frames.push(0);
        prev = "punct";
        prevChar = "{";
        return i + 2;
      } else i++;
    }
    return n;
  };

  /** Index just past a regex literal opened at `i`, flags included; stops at a line break. */
  const skipRegex = (i) => {
    let j = i + 1;
    let inClass = false;
    while (j < n) {
      const c = source[j];
      if (c === "\\") j += 2;
      else if (isEol(c)) return j;
      else if (inClass) {
        if (c === "]") inClass = false;
        j++;
      } else if (c === "[") {
        inClass = true;
        j++;
      } else if (c === "/") {
        j++;
        while (j < n && isWordChar(source[j])) j++;
        return j;
      } else j++;
    }
    return n;
  };

  let i = 0;
  while (i < n) {
    const c = source[i];
    const d = source[i + 1];
    if (isSpace(c) || c === "\u2028" || c === "\u2029") {
      if (isEol(c)) newLine = true;
      i++;
      continue;
    } else if (c === "/" && d === "/" && source[i - 1] !== ":") {
      let j = i + 2;
      while (j < n && !isEol(source[j])) j++;
      blank(i, j);
      i = j;
      continue;
    } else if (c === "/" && d === "*" && !isGlued(source[i - 1])) {
      const j = skipBlock(i);
      blank(i, j);
      i = j;
      continue;
    } else if (c === "'" || c === '"') {
      i = skipQuoted(i);
      prev = "value";
      prevChar = c;
    } else if (c === "`") {
      i = scanTemplate(i + 1);
      prevChar = "`";
    } else if (c === "/") {
      const regex =
        prevChar !== "<" && (prev === "punct" || REGEX_AFTER_WORDS.has(prev) || (prevChar === "}" && newLine));
      if (regex) {
        i = skipRegex(i);
        prev = "value";
        prevChar = "/";
      } else {
        i++;
        prev = "punct";
        prevChar = "/";
      }
    } else if (isWordChar(c)) {
      let j = i + 1;
      while (j < n && isWordChar(source[j])) j++;
      prev = source.slice(i, j);
      prevChar = source[j - 1];
      i = j;
    } else if (c === "{") {
      if (frames.length) frames[frames.length - 1]++;
      prev = "punct";
      prevChar = c;
      i++;
    } else if (c === "}") {
      if (frames.length && frames[frames.length - 1] === 0) {
        frames.pop();
        i = scanTemplate(i + 1);
        prevChar = "`";
      } else {
        if (frames.length) frames[frames.length - 1]--;
        prev = "value";
        prevChar = c;
        i++;
      }
    } else if (c === ")" || c === "]") {
      prev = "value";
      prevChar = c;
      i++;
    } else {
      prev = "punct";
      prevChar = c;
      i++;
    }
    newLine = false;
  }
  return result();
}
