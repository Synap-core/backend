/**
 * CONTAINER SCANNER — the byte-preserving, line-level reading of `:::name{…}`.
 *
 * micromark (see `processor.ts`) is THE semantic parser. This scanner exists
 * for the two jobs a tree cannot do: splicing a document by LINE without
 * re-serializing a byte of it (the section write door), and tokenizing a raw
 * source string (the editor hands its tokenizer `src`, not a tree). It answers
 * one question — which lines does each container directive occupy, and with
 * which attributes — and never interprets anything inside one.
 *
 * Merged from the backend's two line loops (`parseSections` + `fenceColonsFor`
 * in `api/services/session-document/sections.ts`), which each re-derived the
 * rules below and differed on code fences.
 *
 * THE RULES, each pinned against the installed micromark-extension-directive
 * by the conformance tripwire (`conformance.test.ts`):
 *   - an opener is ` {0,3}` + 3+ colons + a name + optional `[label]` +
 *     optional `{attributes}` + only whitespace; anything else on the line
 *     (`:::name {x}` with a space, trailing text, a broken quote) is prose;
 *   - a closer is ` {0,3}` + 3+ colons + only whitespace;
 *   - closers are checked OUTERMOST FIRST: a closer closes the outermost open
 *     container whose opener it matches in length (>=), and everything inside
 *     it. So `::::` closes a `::::section` even when a `:::cell` inside it was
 *     never closed — that cell is IMPLICITLY closed (`terminated: false`);
 *   - a fence (``` / ~~~ / $$ math) hides OPENERS inside it, but NOT closers of an
 *     enclosing container: micromark checks a container's closing fence before
 *     the content it holds, so a bare `:::` line inside a fence inside a
 *     container closes the container (and ends the fence). A fence at the
 *     document root hides everything until it closes;
 *   - attribute values follow micromark's grammar: double- or single-quoted
 *     (with character references decoded), or unquoted; a quoted value must be
 *     followed by whitespace or `}`, which is why `'{"label":"Team's load"}'`
 *     is NOT a directive in either parser.
 *
 * WHAT IT CANNOT SEE: containers inside list items or block quotes (it reads
 * them as if they were at the root), and lazy-continuation subtleties. Neither
 * is produced by any Synap writer; the conformance corpus says which inputs
 * are pinned.
 */

export interface ScannedContainer {
  /** Directive name, e.g. `synap-cell`. */
  name: string;
  /** Number of colons on the opening line. */
  colons: number;
  /** Decoded attributes (`#id` → `id`, `.a .b` → `class: "a b"`). */
  attributes: Record<string, string>;
  /** The raw `{…}` block as written, or "" when absent. */
  rawAttributes: string;
  /** 0-based line of the opener. */
  startLine: number;
  /**
   * 0-based line the container ends on (inclusive). For a container closed by
   * its own fence this is that fence; for one closed implicitly it is the
   * parent's closing fence, or the last line of the document.
   */
  endLine: number;
  /** Closed by its OWN closing fence. `false` = closed by a parent or by EOF. */
  terminated: boolean;
  /** 0 for a root-level container. */
  depth: number;
  /** Index into `containers` of the enclosing container, or null at the root. */
  parent: number | null;
}

export interface ScanResult {
  /** Every container, in opener order. */
  containers: ScannedContainer[];
  /** Longest run of colons on ANY colon-only line (code included), 0 if none. */
  maxColonLine: number;
  /** A code fence at the document root that never closed. */
  unclosedRootFence: boolean;
}

interface FenceState {
  char: string;
  length: number;
}

interface Frame {
  index: number;
  fence: FenceState | null;
}

const CLOSE_RE = /^ {0,3}(:{3,})[ \t]*$/;
const COLON_LINE_RE = /^[ \t]*(:{3,})[ \t]*$/;
/**
 * A fence: ``` / ~~~ (code), or `$$` (math flow, micromark-extension-math:
 * ≥ 2 dollars, a meta that holds no `$`, closed by at least as many).
 */
const CODE_FENCE_RE = /^ {0,3}(`{3,}|~{3,}|\${2,})(.*)$/;

/** A line that closes an open fence (same char, at least as long, nothing after). */
function closesFence(line: string, fence: FenceState): boolean {
  const m = /^ {0,3}(`{3,}|~{3,}|\${2,})[ \t]*$/.exec(line);
  return !!m && m[1]![0] === fence.char && m[1]!.length >= fence.length;
}

/**
 * A line that opens a fence, or null. A backtick info string cannot contain a
 * backtick, and a math meta cannot contain a dollar (`$$E = mc^2$$` on one line
 * is inline math in a paragraph, not a block).
 */
function opensFence(line: string): FenceState | null {
  const m = CODE_FENCE_RE.exec(line);
  if (!m) return null;
  const char = m[1]![0]!;
  if ((char === "`" || char === "$") && m[2]!.includes(char)) return null;
  return { char, length: m[1]!.length };
}

// ─── Attributes (micromark-extension-directive's grammar) ───────────────────

const NAMED_REFS: Record<string, string> = {
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  nbsp: " ",
};

/** Decode the character references remark-stringify and `serializeEmbed` emit. */
export function decodeCharacterReferences(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(
    /&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z]+);/g,
    (all, ref: string) => {
      if (ref[0] === "#") {
        const code =
          ref[1] === "x" || ref[1] === "X"
            ? parseInt(ref.slice(2), 16)
            : parseInt(ref.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : all;
      }
      return NAMED_REFS[ref] ?? all;
    }
  );
}

const isWs = (c: string | undefined) => c === " " || c === "\t";
const isAlpha = (c: string | undefined) => !!c && /[A-Za-z]/.test(c);
const isNameStart = (c: string | undefined) => !!c && /[A-Za-z_:]/.test(c);
const isNameChar = (c: string | undefined) => !!c && /[A-Za-z0-9\-._:]/.test(c);
const isShortcutChar = (c: string | undefined) =>
  !!c && !isWs(c) && !"\"#'.<=>`}".includes(c);
const isUnquotedChar = (c: string | undefined) =>
  !!c && !isWs(c) && !"\"'<=>`}".includes(c);

/**
 * Parse an attribute block starting at `src[start] === "{"`. Returns the
 * decoded attributes and the index just past `}`, or null when the block is not
 * valid directive syntax (then the whole line is prose, as in micromark).
 */
function parseAttributeBlock(
  src: string,
  start: number
): { attributes: Record<string, string>; end: number } | null {
  if (src[start] !== "{") return null;
  const attributes: Record<string, string> = {};
  const classes: string[] = [];
  let i = start + 1;
  const set = (key: string, value: string) => {
    if (key === "class") classes.push(value);
    else attributes[key] = value;
  };
  // After an attribute, micromark requires whitespace or `}` (shortcuts may
  // abut the next shortcut).
  let needsSeparator = false;
  for (;;) {
    let sawWs = false;
    while (isWs(src[i])) {
      i++;
      sawWs = true;
    }
    const c = src[i];
    if (c === undefined) return null;
    if (c === "}") {
      if (classes.length) attributes.class = classes.join(" ");
      return { attributes, end: i + 1 };
    }
    if (c === "#" || c === ".") {
      let j = i + 1;
      while (isShortcutChar(src[j])) j++;
      if (j === i + 1) return null;
      set(
        c === "#" ? "id" : "class",
        decodeCharacterReferences(src.slice(i + 1, j))
      );
      i = j;
      needsSeparator = false;
      continue;
    }
    if (needsSeparator && !sawWs) return null;
    if (!isNameStart(c)) return null;
    let j = i + 1;
    while (isNameChar(src[j])) j++;
    const name = src.slice(i, j);
    i = j;
    let k = i;
    while (isWs(src[k])) k++;
    if (src[k] !== "=") {
      // Boolean attribute: `{hidden}`.
      set(name, "");
      needsSeparator = true;
      continue;
    }
    k++;
    while (isWs(src[k])) k++;
    const q = src[k];
    if (q === '"' || q === "'") {
      const close = src.indexOf(q, k + 1);
      if (close === -1) return null;
      set(name, decodeCharacterReferences(src.slice(k + 1, close)));
      i = close + 1;
      // A quoted value must be followed by whitespace or `}` — the apostrophe
      // inside `'…Team's…'` ends the value and leaves `s` here: not a directive.
      if (!isWs(src[i]) && src[i] !== "}") return null;
    } else {
      let e = k;
      while (isUnquotedChar(src[e])) e++;
      if (e === k) return null;
      set(name, decodeCharacterReferences(src.slice(k, e)));
      i = e;
    }
    needsSeparator = true;
  }
}

/**
 * Parse a raw `{…}` attribute string into a flat record, exactly as the
 * scanner reads an opener. Returns `{}` for an empty or invalid block.
 */
export function parseAttributes(
  raw: string | undefined
): Record<string, string> {
  if (!raw) return {};
  return parseAttributeBlock(raw.trim(), 0)?.attributes ?? {};
}

export interface DirectiveOpener {
  colons: number;
  name: string;
  label: string | null;
  attributes: Record<string, string>;
  rawAttributes: string;
}

/** Read one line as a container-directive opener, or null when it is not one. */
export function parseContainerOpener(line: string): DirectiveOpener | null {
  const m = /^ {0,3}(:{3,})/.exec(line);
  if (!m) return null;
  const colons = m[1]!.length;
  let i = m[0].length;
  if (!isAlpha(line[i])) return null;
  const nameStart = i;
  while (/[A-Za-z0-9\-_]/.test(line[i] ?? "")) i++;
  const name = line.slice(nameStart, i);
  if (/[-_]$/.test(name)) return null;
  let label: string | null = null;
  if (line[i] === "[") {
    let depth = 0;
    let j = i;
    for (; j < line.length; j++) {
      const c = line[j];
      if (c === "\\") {
        j++;
        continue;
      }
      if (c === "[") depth++;
      else if (c === "]" && --depth === 0) break;
    }
    if (j >= line.length) return null;
    label = line.slice(i + 1, j);
    i = j + 1;
  }
  let attributes: Record<string, string> = {};
  let rawAttributes = "";
  if (line[i] === "{") {
    const parsed = parseAttributeBlock(line, i);
    if (!parsed) return null;
    attributes = parsed.attributes;
    rawAttributes = line.slice(i, parsed.end);
    i = parsed.end;
  }
  if (line.slice(i).trim() !== "") return null;
  return { colons, name, label, attributes, rawAttributes };
}

/** Read one line as a container closer; returns its colon count or 0. */
export function closerColons(line: string): number {
  return CLOSE_RE.exec(line)?.[1]!.length ?? 0;
}

/** Split into lines the way the scanner and the splice both count them. */
export function splitLines(markdown: string): string[] {
  return markdown
    .split("\n")
    .map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

/** Walk the document once and return every container's line extent. */
export function scanContainers(markdown: string): ScanResult {
  const lines = splitLines(markdown);
  const containers: ScannedContainer[] = [];
  const root: { fence: FenceState | null } = { fence: null };
  const stack: Frame[] = [];
  let maxColonLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const colonLine = COLON_LINE_RE.exec(line);
    if (colonLine) maxColonLine = Math.max(maxColonLine, colonLine[1]!.length);

    // 1. Closers, OUTERMOST first (see the module rules).
    const close = closerColons(line);
    if (close && stack.length) {
      const d = stack.findIndex((f) => close >= containers[f.index]!.colons);
      if (d !== -1) {
        for (let k = stack.length - 1; k >= d; k--) {
          const c = containers[stack[k]!.index]!;
          c.endLine = i;
          c.terminated = k === d;
        }
        stack.length = d;
        continue;
      }
    }

    // 2. Content of the innermost open block (a container, or the root).
    const frame = stack[stack.length - 1] ?? root;
    if (frame.fence) {
      if (closesFence(line, frame.fence)) frame.fence = null;
      continue;
    }
    const fence = opensFence(line);
    if (fence) {
      frame.fence = fence;
      continue;
    }
    const open = parseContainerOpener(line);
    if (open) {
      const parent = stack.length ? stack[stack.length - 1]!.index : null;
      containers.push({
        name: open.name,
        colons: open.colons,
        attributes: open.attributes,
        rawAttributes: open.rawAttributes,
        startLine: i,
        endLine: -1,
        terminated: false,
        depth: stack.length,
        parent,
      });
      stack.push({ index: containers.length - 1, fence: null });
    }
  }

  // Unclosed at EOF: runs to the end of the document (micromark's extent ends
  // at EOF, so a trailing newline's empty last line is included), closed by
  // nothing of its own.
  for (const f of stack) {
    const c = containers[f.index]!;
    c.endLine = lines.length - 1;
    c.terminated = false;
  }
  return { containers, maxColonLine, unclosedRootFence: root.fence !== null };
}

/**
 * The colon count a new container must use so that NOTHING in `body` can close
 * it early: one more than any colon-only line anywhere in the body (inside
 * code blocks too — a closer is seen before the fence that holds it), and at
 * least `min`.
 */
export function fenceColonsFor(body: string, min = 3): number {
  return Math.max(min, scanContainers(body).maxColonLine + 1);
}
