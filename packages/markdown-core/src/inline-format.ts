/**
 * INLINE FORMATTING — underline, text colour and toned highlight (v2 V1).
 *
 * Markdown carries none of the three, so Synap stores them in forms every
 * Synap reader understands and every other reader degrades from:
 *
 *   :u[text]                      underline (a text directive)
 *   :color[text]{tone=<tone>}     text colour (a text directive)
 *   ==text==  /  ==text=={tone=<tone>}
 *                                 highlight — ONE construct, the existing `==`
 *                                 mark with an optional tone. No tone = the
 *                                 default highlight (what `==x==` always was).
 *
 * A tone is a NAMED token tone (`TEXT_TONES`), never a colour value: the
 * reader paints `--synap-tone-<tone>-ink` for text and `-fill` (as a wash) for
 * a highlight. An unknown tone is KEPT (it round-trips byte for byte), draws
 * as plain text and raises an `unknown-tone` diagnostic.
 *
 * One writer per construct lives here (`serializeUnderline`,
 * `serializeTextColor`, `serializeHighlight`); the one-writer tripwire fails
 * on any other writer. The two readers — micromark (`remarkInlineFormat`, the
 * reader pipeline) and the editor's tokenizers (`readInlineFormatAt`,
 * `readHighlightAt`) — share the acceptance rules below, and a conformance
 * test holds them to the same answers on a shared corpus.
 *
 * Acceptance (anything else stays PROSE, byte for byte):
 *   - the directive name is exactly `u` or `color` (lowercase);
 *   - it has a NON-EMPTY `[label]`; brackets inside it balance or are escaped;
 *   - `u` carries no attribute (an empty `{}` is tolerated);
 *   - `color` carries at most one attribute, `tone` (none = diagnosed, plain).
 * So "10:30", "ratio 3:1", "ratio:high" and URLs (a link node, never text)
 * are never formatting.
 */

import type { Data, Parent, PhrasingContent, Root } from "mdast";
import type { Diagnostic } from "./diagnostics.js";

// ─── Tones ──────────────────────────────────────────────────────────────────

/**
 * The tones a writer may name. Each one is a `--synap-tone-<tone>-fill|ink`
 * pair in the design tokens (`synap-app/packages/core/design-tokens`), spelled
 * as the tone family's own names (`UnitTone`: `textMuted`, not `text-muted`).
 *
 * This package is published from synap-backend and cannot depend on the
 * synap-app token package, so the list is pinned instead of imported: the
 * `text-tones.tripwire.test.ts` DERIVES the tone family from the token JSON and
 * from `UnitTone`'s source and fails unless every tone there is either listed
 * here or in `WITHHELD_TEXT_TONES` with its reason.
 */
export const TEXT_TONES = [
  "primary",
  "info",
  "success",
  "warning",
  "error",
  "textSecondary",
  "textMuted",
] as const;
export type TextTone = (typeof TEXT_TONES)[number];

/** Token tones a document may NOT name, and why. */
export const WITHHELD_TEXT_TONES: Readonly<Record<string, string>> = {
  ai: "--synap-ai is provenance of AI work only (ui-rules); a person's colour choice must never read as AI",
};

export function isTextTone(tone: unknown): tone is TextTone {
  return (
    typeof tone === "string" && (TEXT_TONES as readonly string[]).includes(tone)
  );
}

// ─── Writers (the ONE writer per construct) ─────────────────────────────────

/**
 * A label whose brackets would end the directive early gets them escaped.
 * Balanced brackets (a link inside the label) are left alone.
 */
function safeLabel(inner: string): string {
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "[") depth++;
    else if (c === "]" && --depth < 0) break;
  }
  if (depth === 0) return inner;
  return inner.replace(/(\\.)|([[\]])/g, (m, escaped: string | undefined) =>
    escaped ? m : `\\${m}`
  );
}

const BARE_VALUE = /^[A-Za-z][A-Za-z0-9_-]*$/;

function toneAttribute(tone: string): string {
  return BARE_VALUE.test(tone)
    ? `{tone=${tone}}`
    : `{tone="${tone.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"}`;
}

/** Underline: `:u[inner]`. `inner` is already-rendered inline markdown. */
export function serializeUnderline(inner: string): string {
  return `:u[${safeLabel(inner)}]`;
}

/** Text colour: `:color[inner]{tone=<tone>}`. An empty tone writes no attribute. */
export function serializeTextColor(inner: string, tone: string | null): string {
  return `:color[${safeLabel(inner)}]${tone ? toneAttribute(tone) : ""}`;
}

/** Highlight: `==inner==`, with `{tone=<tone>}` when it has one. */
export function serializeHighlight(
  inner: string,
  tone?: string | null
): string {
  return `==${inner}==${tone ? toneAttribute(tone) : ""}`;
}

// ─── Source-level readers (the editor's tokenizers) ─────────────────────────

export type InlineFormatKind = "underline" | "color";

export interface InlineFormatMatch {
  kind: InlineFormatKind;
  /** The label's markdown source, escapes intact (parse it as inline). */
  label: string;
  /** `color` only: the tone as written (may be unknown); null when absent. */
  tone: string | null;
  /** The exact source consumed. */
  raw: string;
}

/** The end index (exclusive) of a `[label]` starting at `open`, or -1. */
function labelEnd(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "\n" && src[i + 1] === "\n") return -1;
    if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return i + 1;
  }
  return -1;
}

/** `{…}` at `at`: its attributes, or null when it is not a well-formed block. */
function readAttributes(
  src: string,
  at: number
): { attrs: Record<string, string>; end: number } | null {
  if (src[at] !== "{") return null;
  const close = src.indexOf("}", at);
  if (close === -1) return null;
  const body = src.slice(at + 1, close);
  const attrs: Record<string, string> = {};
  const re =
    /\s*([A-Za-z_:][\w.:-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\s"'=<>`}]+))\s*/y;
  let pos = 0;
  while (pos < body.length) {
    if (/^\s*$/.test(body.slice(pos))) break;
    re.lastIndex = pos;
    const m = re.exec(body);
    if (!m) return null;
    attrs[m[1]!] = (m[2] ?? m[3] ?? m[4] ?? "").replace(/\\(.)/g, "$1");
    pos = re.lastIndex;
  }
  return { attrs, end: close + 1 };
}

/** Is this `(name, label, attributes)` triple formatting (see the header)? */
function accepts(
  name: string,
  labelNonEmpty: boolean,
  attrs: Record<string, string>
): boolean {
  if (!labelNonEmpty) return false;
  const keys = Object.keys(attrs);
  if (name === "u") return keys.length === 0;
  // A colour with no tone is kept (and diagnosed) so a half-written one does
  // not print raw syntax; any OTHER attribute makes it prose.
  if (name === "color")
    return keys.length === 0 || (keys.length === 1 && keys[0] === "tone");
  return false;
}

/**
 * `:u[…]` or `:color[…]{tone=…}` at the START of `src`, or null. The editor's
 * markdown tokenizer calls this; the reader's micromark path applies the same
 * `accepts` rule in `remarkInlineFormat`. micromark never opens a text
 * directive right after a `:` ("a::u[x]" is prose), hence `prev`.
 */
export function readInlineFormatAt(
  src: string,
  /** The character before `src` ("" at a run start): after a `:` it is prose. */
  prev = ""
): InlineFormatMatch | null {
  if (prev === ":") return null;
  const head = /^:(u|color)\[/.exec(src);
  if (!head) return null;
  const name = head[1]!;
  const open = head[0].length - 1;
  const end = labelEnd(src, open);
  if (end === -1) return null;
  const label = src.slice(open + 1, end - 1);
  let attrs: Record<string, string> = {};
  let stop = end;
  if (src[end] === "{") {
    const read = readAttributes(src, end);
    if (!read) return null;
    attrs = read.attrs;
    stop = read.end;
  }
  if (!accepts(name, label.length > 0, attrs)) return null;
  return {
    kind: name === "u" ? "underline" : "color",
    label,
    tone: name === "color" ? (attrs.tone ?? null) : null,
    raw: src.slice(0, stop),
  };
}

export interface HighlightMatch {
  /** The highlighted markdown source. */
  inner: string;
  tone: string | null;
  raw: string;
}

/** A `==` opener: not in a longer `=` run, followed by a non-space. */
const HL_OPEN = /^==(?=[^\s=])/;
/** A `==` closer: after a non-space, not in a longer `=` run. */
const HL_CLOSE = /(?<=[^\s=])==(?!=)/g;
/** The optional tone suffix of a highlight. */
const HL_TONE =
  /^\{\s*tone\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\s"'=<>`}]+))\s*\}/;

/**
 * `==…==` (with its optional `{tone=…}`) at the START of `src`, or null —
 * the same delimiter rules `remarkHighlight` applies to text nodes. It never
 * crosses a blank line.
 */
export function readHighlightAt(
  src: string,
  /** The character before `src` ("" at a run start): after a `=` it is prose. */
  prev = ""
): HighlightMatch | null {
  if (prev === "=" || !HL_OPEN.test(src)) return null;
  const para = src.search(/\n[ \t]*\n/);
  const scope = para === -1 ? src : src.slice(0, para);
  HL_CLOSE.lastIndex = 3;
  const close = HL_CLOSE.exec(scope);
  if (!close) return null;
  const inner = scope.slice(2, close.index);
  let end = close.index + 2;
  const suffix = HL_TONE.exec(src.slice(end));
  let tone: string | null = null;
  if (suffix) {
    tone = (suffix[1] ?? suffix[2] ?? suffix[3] ?? "").replace(/\\(.)/g, "$1");
    end += suffix[0].length;
  }
  return { inner, tone, raw: src.slice(0, end) };
}

/** Read a highlight's `{tone=…}` suffix at the start of `text` (reader side). */
export function readHighlightTone(
  text: string
): { tone: string; length: number } | null {
  const m = HL_TONE.exec(text);
  if (!m) return null;
  return {
    tone: (m[1] ?? m[2] ?? m[3] ?? "").replace(/\\(.)/g, "$1"),
    length: m[0].length,
  };
}

// ─── Reader pipeline (micromark → mdast) ────────────────────────────────────

type AnyNode = {
  type: string;
  name?: string;
  value?: string;
  tone?: string | null;
  attributes?: Record<string, string | null | undefined> | null;
  children?: AnyNode[];
  data?: Record<string, unknown>;
  position?: {
    start: { line: number; offset?: number };
    end: { line: number; offset?: number };
  };
};

/**
 * Is this micromark `textDirective` formatting? Used by the prose restore, so
 * an accepted directive is not put back as text before it is converted.
 */
export function isInlineFormatDirective(node: {
  type: string;
  name?: string;
  attributes?: Record<string, string | null | undefined> | null;
  children?: unknown[];
}): boolean {
  if (node.type !== "textDirective") return false;
  const attrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(node.attributes ?? {}))
    attrs[k] = v ?? "";
  return accepts(node.name ?? "", (node.children?.length ?? 0) > 0, attrs);
}

/** Tone properties for hosts that draw hast (`data-tone` only when known). */
function toneProperties(
  base: string,
  tone: string | null
): Record<string, unknown> {
  return isTextTone(tone)
    ? { className: [base, `${base}--${tone}`], "data-tone": tone }
    : { className: [base] };
}

/**
 * An `underline` / `textColor` phrasing node. `data.hName` lets any
 * mdast→hast host (react-markdown) draw `<u>` / `<span>` with no handler;
 * native and plain-text readers handle both types and fall back to the text.
 */
export interface Underline extends Parent {
  type: "underline";
  children: PhrasingContent[];
  data?: Data & { hName?: string };
}
export interface TextColor extends Parent {
  type: "textColor";
  /** As written; `isTextTone` says whether a reader may paint it. */
  tone: string | null;
  children: PhrasingContent[];
  data?: Data & {
    hName?: string;
    hProperties?: Record<string, unknown>;
  };
}

declare module "mdast" {
  interface PhrasingContentMap {
    underline: Underline;
    textColor: TextColor;
  }
  interface RootContentMap {
    underline: Underline;
    textColor: TextColor;
  }
}

export function unknownToneDiagnostic(
  construct: string,
  tone: string | null,
  line: number | undefined
): Diagnostic {
  return {
    code: "unknown-tone",
    severity: "warning",
    message: tone
      ? `${construct} names the tone \`${tone}\`, which is not a Synap tone (${TEXT_TONES.join(", ")}); it shows as plain text.`
      : `${construct} has no \`tone\`; it shows as plain text. Add one of: ${TEXT_TONES.join(", ")}.`,
    line,
  };
}

function convert(node: AnyNode, report: (d: Diagnostic) => void): void {
  for (const child of node.children ?? []) {
    convert(child, report);
    if (!isInlineFormatDirective(child)) continue;
    if (child.name === "u") {
      child.type = "underline";
      child.data = { hName: "u" };
    } else {
      const tone = child.attributes?.tone ?? null;
      child.type = "textColor";
      child.tone = tone;
      child.data = {
        hName: "span",
        hProperties: toneProperties("synap-text-tone", tone),
      };
      if (!isTextTone(tone))
        report(
          unknownToneDiagnostic(
            "A text colour",
            tone,
            child.position?.start.line
          )
        );
    }
    delete child.name;
    delete child.attributes;
  }
}

/**
 * `:u[…]` → `underline`, `:color[…]{tone}` → `textColor`. Runs after
 * `remark-directive` and BEFORE `remarkRestoreProse`, which puts every other
 * non-`synap-*` text directive back as prose.
 */
export function remarkInlineFormat() {
  return (tree: Root, file: { data: Record<string, unknown> }) => {
    convert(tree as unknown as AnyNode, (d) => {
      const data = file.data as { synapDiagnostics?: Diagnostic[] };
      (data.synapDiagnostics ??= []).push(d);
    });
  };
}

/** Hast properties for a highlight `mark` with this tone. */
export function highlightProperties(
  tone: string | null
): Record<string, unknown> | undefined {
  return tone ? toneProperties("synap-mark", tone) : undefined;
}
