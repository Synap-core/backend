/**
 * The static checks of `surfaces.inspect` (Surfaces P7): what a framed
 * surface's stored code does that a reader will see wrong, found by reading
 * the text alone (no browser on the pod).
 *
 *   tokens  a colour (hex, rgb()/hsl()/…, a named colour in a colour
 *           property) or a font family written by hand instead of a
 *           `var(--synap-*)` token: it ignores the reader's theme and the
 *           project's brand. A colour inside `var(--synap-…, <fallback>)` is
 *           the token's own fallback and is not counted.
 *   a11y    (HTML only) an image with no `alt`, a button or a link with no
 *           accessible name, a form field with no label, a heading that skips
 *           a level.
 *
 * A lint, not a parser: it reads tags and declarations with patterns, so it
 * can miss a case (a tag built by script at run time, a `>` inside an
 * attribute) and every finding names its line so a person can judge it. It
 * never runs the code.
 */

/** One stored text a surface draws with. */
export interface LintSource {
  /** Where it comes from, as the answer names it (`cell:<key> rendererSource`, `document:<id>`). */
  label: string;
  text: string;
  /** `html`: a page (both checks). `module`: JS / JSX (tokens only). */
  language: "html" | "module";
}

export interface TokenFinding {
  source: string;
  line: number;
  column: number;
  kind: "colour" | "font";
  /** The text found, e.g. `#1a73e8`, `rgb(0 0 0)`, `Inter, sans-serif`. */
  found: string;
  /** The CSS property it is set on, when one is written before it. */
  property: string | null;
  /** The token to use instead. */
  suggestion: string;
}

export const A11Y_RULES = [
  "img-alt",
  "button-name",
  "link-name",
  "field-label",
  "heading-order",
] as const;
export type A11yRule = (typeof A11Y_RULES)[number];

export interface A11yFinding {
  source: string;
  line: number;
  rule: A11yRule;
  /** The opening tag as written (cut at 120 characters). */
  element: string;
  message: string;
}

// ── Text helpers ────────────────────────────────────────────────────────────

/** Blank a span, keeping its newlines so offsets and lines stay true. */
function blank(s: string): string {
  return s.replace(/[^\n]/g, " ");
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function position(
  starts: number[],
  offset: number
): { line: number; column: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - starts[lo]! + 1 };
}

/** Blank comments: `<!-- -->` and `/* *\/` (a `//` line is left: it may be a URL). */
function blankComments(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank);
}

/** Blank every `var(--synap-…)` call, its fallback included (balanced parens). */
function blankSynapVars(text: string): string {
  let out = text;
  const re = /var\(\s*--synap-/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(out))) {
    let depth = 0;
    let end = m.index;
    for (let i = m.index; i < out.length; i += 1) {
      if (out[i] === "(") depth += 1;
      else if (out[i] === ")") {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end === m.index) end = out.length;
    out = out.slice(0, m.index) + blank(out.slice(m.index, end)) + out.slice(end);
    re.lastIndex = end;
  }
  return out;
}

// ── Tokens ──────────────────────────────────────────────────────────────────

const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
const COLOUR_FN = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/gi;
const NAMED =
  /\b(white|black|red|green|blue|gray|grey|yellow|orange|purple|pink|silver|navy|teal|maroon|olive|lime|aqua|fuchsia|brown|gold|indigo|violet|crimson)\b/gi;
/** A colour property and its value: CSS (`color: red`) or a JSX style key (`color: "red"`). */
const COLOUR_DECL =
  /\b(background-color|background|color|border-color|border|outline-color|outline|fill|stroke|box-shadow|text-shadow|backgroundColor|borderColor|outlineColor|boxShadow|textShadow)\s*:\s*["'`]?([^;}"'`\n]*)/g;
const FONT_DECL =
  /\b(?:font-family\s*:\s*([^;}"'\n]+)|fontFamily\s*:\s*["'`]([^"'`\n]+)["'`])/g;

/** The property written last before `offset` on its line (`color` in `color: #fff`). */
function propertyBefore(line: string, column: number): string | null {
  const head = line.slice(0, column - 1);
  const m = /([A-Za-z-]+)\s*:\s*[^:;{]*$/.exec(head);
  return m ? m[1]! : null;
}

export function colourTokenFor(property: string | null): string {
  const p = (property ?? "").toLowerCase();
  if (p.includes("shadow")) return "var(--synap-elevation-card)";
  if (p.includes("background")) return "var(--synap-background)";
  if (p.includes("border") || p.includes("outline"))
    return "var(--synap-border-color)";
  if (p === "fill" || p === "stroke") return "var(--synap-primary)";
  if (p === "color") return "var(--synap-color)";
  return "a colour token: var(--synap-primary), var(--synap-color), var(--synap-background) or var(--synap-muted)";
}

export function fontTokenFor(value: string, line: string): string {
  if (/mono|courier|consolas|menlo/i.test(value)) return "var(--synap-font-mono)";
  if (/<h[1-6]\b|\bh[1-6]\b|heading|title|display/i.test(line))
    return "var(--synap-font-heading)";
  return "var(--synap-font-body)";
}

const LINK_ATTR_BEFORE = /(?:href|src|id|for|xlink:href)\s*=\s*["']?$|url\(\s*["']?$/i;

export function lintTokens(source: LintSource): TokenFinding[] {
  const text = blankSynapVars(blankComments(source.text));
  const starts = lineStarts(text);
  const lines = text.split("\n");
  const out: TokenFinding[] = [];
  const seen = new Set<number>();
  const push = (
    offset: number,
    kind: TokenFinding["kind"],
    found: string,
    suggestionFor: (property: string | null, line: string) => string
  ) => {
    if (seen.has(offset)) return;
    seen.add(offset);
    const { line, column } = position(starts, offset);
    const lineText = lines[line - 1] ?? "";
    const property = propertyBefore(lineText, column);
    out.push({
      source: source.label,
      line,
      column,
      kind,
      found: found.trim(),
      property,
      suggestion: suggestionFor(property, lineText),
    });
  };

  let m: RegExpExecArray | null;
  HEX.lastIndex = 0;
  while ((m = HEX.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 24), m.index);
    // `href="#top"`, `url(#grad)`, `&#123;`: a reference, not a colour.
    if (LINK_ATTR_BEFORE.test(before) || /[\w&]$/.test(before)) continue;
    push(m.index, "colour", m[0], (p) => colourTokenFor(p));
  }
  COLOUR_FN.lastIndex = 0;
  while ((m = COLOUR_FN.exec(text))) {
    const close = text.indexOf(")", m.index);
    const found = text.slice(m.index, close === -1 ? m.index + 24 : close + 1);
    push(m.index, "colour", found, (p) => colourTokenFor(p));
  }
  COLOUR_DECL.lastIndex = 0;
  while ((m = COLOUR_DECL.exec(text))) {
    const value = m[2] ?? "";
    const valueStart = m.index + m[0].length - value.length;
    NAMED.lastIndex = 0;
    let n: RegExpExecArray | null;
    while ((n = NAMED.exec(value))) {
      push(valueStart + n.index, "colour", n[0], (p) => colourTokenFor(p));
    }
  }
  FONT_DECL.lastIndex = 0;
  while ((m = FONT_DECL.exec(text))) {
    const value = (m[1] ?? m[2] ?? "").trim();
    // Blanked: it was a `var(--synap-…)`. A keyword sets no family of its own.
    if (!value || /^(inherit|initial|unset|revert|revert-layer)$/i.test(value))
      continue;
    const valueStart = m.index + m[0].indexOf(value);
    push(valueStart, "font", value, (_p, line) => fontTokenFor(value, line));
  }
  return out.sort((a, b) => a.line - b.line || a.column - b.column);
}

// ── Accessibility (HTML) ────────────────────────────────────────────────────

const ATTR =
  /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function attrsOf(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  ATTR.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR.exec(raw))) {
    out.set(m[1]!.toLowerCase(), m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

const hasText = (v: string | undefined) => !!v && v.trim() !== "";

/** The text a screen reader would read inside an element. */
function innerName(inner: string): boolean {
  // An image with alt text, or an svg with a title, names its parent.
  if (/<img\b[^>]*\balt\s*=\s*("[^"]*\S[^"]*"|'[^']*\S[^']*')/i.test(inner))
    return true;
  if (/<title\b[^>]*>[^<]*\S/i.test(inner)) return true;
  if (/\baria-label\s*=\s*("[^"]*\S[^"]*"|'[^']*\S[^']*')/i.test(inner))
    return true;
  const text = inner
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;|&#xa0;/gi, " ")
    .trim();
  return text !== "";
}

function namedByAttr(attrs: Map<string, string>): boolean {
  return (
    hasText(attrs.get("aria-label")) ||
    hasText(attrs.get("aria-labelledby")) ||
    hasText(attrs.get("title"))
  );
}

const cut = (s: string) => (s.length > 120 ? `${s.slice(0, 117)}...` : s);

export function lintA11y(source: LintSource): A11yFinding[] {
  if (source.language !== "html") return [];
  // Script and style bodies are not markup: blank them (keep the tags).
  const text = blankComments(source.text)
    .replace(
      /(<script\b[^>]*>)([\s\S]*?)(<\/script\s*>)/gi,
      (_all, open: string, body: string, close: string) =>
        open + blank(body) + close
    )
    .replace(
      /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi,
      (_all, open: string, body: string, close: string) =>
        open + blank(body) + close
    );
  const starts = lineStarts(text);
  const out: A11yFinding[] = [];
  const add = (offset: number, rule: A11yRule, tag: string, message: string) =>
    out.push({
      source: source.label,
      line: position(starts, offset).line,
      rule,
      element: cut(tag.replace(/\s+/g, " ")),
      message,
    });

  // Labels: by `for` / `htmlFor`, and the spans a <label> wraps.
  const labelledIds = new Set<string>();
  const labelSpans: Array<[number, number]> = [];
  let m: RegExpExecArray | null;
  const LABEL = /<label\b([^>]*)>([\s\S]*?)<\/label\s*>/gi;
  while ((m = LABEL.exec(text))) {
    const a = attrsOf(m[1] ?? "");
    const target = a.get("for") ?? a.get("htmlfor");
    if (target) labelledIds.add(target);
    labelSpans.push([m.index, m.index + m[0].length]);
  }
  const insideLabel = (offset: number) =>
    labelSpans.some(([s, e]) => offset > s && offset < e);

  const IMG = /<img\b([^>]*)>/gi;
  while ((m = IMG.exec(text))) {
    const a = attrsOf(m[1] ?? "");
    const hidden =
      a.get("aria-hidden") === "true" ||
      a.get("role") === "presentation" ||
      a.get("role") === "none";
    if (!a.has("alt") && !hidden && !namedByAttr(a)) {
      add(
        m.index,
        "img-alt",
        m[0],
        'This image has no alt text. Describe it in `alt`, or write `alt=""` when it is decoration.'
      );
    }
  }

  const BUTTON = /<button\b([^>]*)>([\s\S]*?)<\/button\s*>/gi;
  while ((m = BUTTON.exec(text))) {
    const a = attrsOf(m[1] ?? "");
    if (!namedByAttr(a) && !innerName(m[2] ?? "")) {
      add(
        m.index,
        "button-name",
        m[0].slice(0, m[0].indexOf(">") + 1),
        "This button has no name a screen reader can say. Give it text, or an `aria-label` when it shows only an icon."
      );
    }
  }

  const LINK = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  while ((m = LINK.exec(text))) {
    const a = attrsOf(m[1] ?? "");
    if (!a.has("href")) continue;
    if (!namedByAttr(a) && !innerName(m[2] ?? "")) {
      add(
        m.index,
        "link-name",
        m[0].slice(0, m[0].indexOf(">") + 1),
        "This link has no name a screen reader can say. Give it text, or an `aria-label` when it shows only an icon."
      );
    }
  }

  const FIELD = /<(input|select|textarea)\b([^>]*)>/gi;
  while ((m = FIELD.exec(text))) {
    const tag = m[1]!.toLowerCase();
    const a = attrsOf(m[2] ?? "");
    const type = (a.get("type") ?? "text").toLowerCase();
    if (tag === "input" && type === "hidden") continue;
    if (tag === "input" && ["submit", "reset", "button"].includes(type)) {
      if (!hasText(a.get("value")) && !namedByAttr(a)) {
        add(
          m.index,
          "button-name",
          m[0],
          "This button has no name a screen reader can say. Give it a `value` or an `aria-label`."
        );
      }
      continue;
    }
    if (tag === "input" && type === "image") {
      if (!hasText(a.get("alt")) && !namedByAttr(a)) {
        add(m.index, "img-alt", m[0], "This image button has no `alt` text.");
      }
      continue;
    }
    const id = a.get("id");
    const labelled =
      namedByAttr(a) || (id && labelledIds.has(id)) || insideLabel(m.index);
    if (!labelled) {
      add(
        m.index,
        "field-label",
        m[0],
        hasText(a.get("placeholder"))
          ? "This field has only a placeholder, which disappears as one types. Give it a <label> (or an `aria-label`)."
          : "This field has no label. Give it a <label for=…> or an `aria-label`."
      );
    }
  }

  const HEADING = /<h([1-6])\b[^>]*>/gi;
  let previous = 0;
  while ((m = HEADING.exec(text))) {
    const level = Number(m[1]);
    if (previous > 0 && level > previous + 1) {
      add(
        m.index,
        "heading-order",
        m[0],
        `An h${level} follows an h${previous}: a heading level is skipped. Use h${previous + 1}.`
      );
    }
    previous = level;
  }

  return out.sort((x, y) => x.line - y.line);
}
