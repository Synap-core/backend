/**
 * A NAME the pod derives from longer text — a session from its goal, a run
 * from its automation, a capture from its first line — when no person or agent
 * gave one. THE one door for a stored, derived title: a `.slice(0, N)` at a call
 * site is the defect this replaces (tripwire `title-derive-one-door`).
 *
 * Never used on a title someone WROTE: that is stored as sent, or refused over
 * the hard cap. A derived name is the pod's own label, may be improved later by
 * the background titler, and must read as a complete phrase: no "…" (the title
 * rubric flags it as cut, plan 9992207a §3), no dangling word. An ellipsis is a
 * DISPLAY concern (a render-side clip keeps the full title in data); it is
 * never stored.
 *
 * Takes the first line that still says something once markdown markers, links
 * and bare URLs are removed (a URL-only text names its host). Shortens at the
 * last clause boundary that keeps most of the budget (". ", " — ", ": ", "; ",
 * " · ", ", ", " (") and otherwise at the last word boundary, then drops
 * trailing punctuation and connector words. A cut never splits a grapheme
 * (emoji, ZWJ sequence, combining mark), and text with no spaces (CJK) cuts at
 * a word boundary from `Intl.Segmenter` when the runtime has one.
 */
import { TITLE_SOFT_MAX } from "./lint.js";

const CLAUSE_BREAKS = [
  ". ",
  "? ",
  "! ",
  " — ",
  " – ",
  ": ",
  "; ",
  " · ",
  ", ",
  " (",
];

/** Words a phrase must not end on ("Fix the login and"). */
const DANGLING =
  /\s+(?:a|an|the|and|or|but|of|to|for|with|in|on|at|by|from|into|vs|via|is|are|was|be|that|which|when|if|as|de|la|le|les|et|ou|du|des|un|une|pour|avec|dans)$/i;
const TRAILING_PUNCT = /[\s,;:.…\-–—·(]+$/;
const TRAILING_ELLIPSIS = /(?:\s*(?:…|\.{3,}))+$/;
const URL = /(?:\bhttps?:\/\/|\bwww\.)[^\s<>()]+/gi;
/** Heading, quote, list, numbered-list and checkbox markers at a line start. */
const LINE_MARKER = /^(?:#{1,6}\s+|>\s*|[-*+•]\s+|\d{1,3}[.)]\s+|\[[ xX]\]\s+)/;

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** One line of markdown → its words. */
function plain(line: string): string {
  let out = line.trim();
  for (let i = 0; i < 4 && LINE_MARKER.test(out); i++) {
    out = out.replace(LINE_MARKER, "");
  }
  out = out
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]+)\]\]/g, "$1")
    .replace(URL, " ")
    .replace(/\*\*|__|~~|`/g, "")
    .replace(/(^|[\s(])\*(\S(?:[^*]*\S)?)\*(?=$|[\s).,;:!?])/g, "$1$2");
  return oneLine(out)
    .replace(TRAILING_ELLIPSIS, "")
    .replace(/^[\s,;:\-–—·]+/, "")
    .trim();
}

function firstLine(text: string): string {
  let symbols = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = plain(raw);
    if (/[\p{L}\p{N}]/u.test(line)) return line;
    symbols ||= line;
  }
  // Nothing but links: the host is the only name the text carries.
  const url = text.match(URL)?.[0];
  if (!url) return symbols;
  try {
    const host = new globalThis.URL(
      /^https?:/i.test(url) ? url : `https://${url}`
    ).hostname;
    return host.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function tidyEnd(value: string): string {
  let out = value.replace(TRAILING_PUNCT, "");
  // Drop up to three dangling connector words.
  for (let i = 0; i < 3 && DANGLING.test(out); i++) {
    out = out.replace(DANGLING, "").replace(TRAILING_PUNCT, "");
  }
  return out;
}

type Granularity = "grapheme" | "word";

/** Segment start offsets (plus the end), or null when the runtime has no Segmenter. */
function boundaries(text: string, granularity: Granularity): number[] | null {
  const Segmenter = (
    Intl as unknown as {
      Segmenter?: new (
        locale?: string,
        options?: { granularity: Granularity }
      ) => { segment(input: string): Iterable<{ index: number }> };
    }
  ).Segmenter;
  if (typeof Segmenter !== "function") return null;
  const out: number[] = [];
  for (const s of new Segmenter(undefined, { granularity }).segment(text)) {
    out.push(s.index);
  }
  out.push(text.length);
  return out;
}

/** The largest grapheme boundary at or before `at`. */
function graphemeSafe(text: string, at: number): number {
  const all = boundaries(text, "grapheme");
  if (all) return Math.max(0, ...all.filter((b) => b <= at));
  // No Segmenter (older JS engines): never split a surrogate pair, a combining
  // mark, a variation selector, a skin-tone modifier or a ZWJ sequence.
  let i = at;
  while (i > 0 && i < text.length) {
    const code = text.charCodeAt(i);
    const point = text.codePointAt(i) ?? 0;
    const splits =
      (code >= 0xdc00 && code <= 0xdfff) ||
      /\p{M}/u.test(text[i]!) ||
      "\u200D\uFE0E\uFE0F".includes(text[i]!) ||
      (point >= 0x1f3fb && point <= 0x1f3ff) ||
      text[i - 1] === "\u200D";
    if (!splits) break;
    i--;
  }
  return i;
}

export function shortenTitle(
  text: string | null | undefined,
  max = TITLE_SOFT_MAX
): string {
  const line = firstLine(typeof text === "string" ? text : "");
  if (line.length <= max) return line;
  const window = line.slice(0, max + 1);
  const floor = Math.floor(max * 0.5);
  let cut = -1;
  for (const brk of CLAUSE_BREAKS) {
    const at = window.lastIndexOf(brk);
    if (at >= floor && at > cut) cut = at;
  }
  if (cut === -1) {
    const space = window.lastIndexOf(" ");
    if (space >= floor) cut = space;
  }
  if (cut === -1) {
    // No space to cut at (CJK, one long token): a word boundary, else a
    // grapheme boundary — never half a character.
    const words = boundaries(window, "word")?.filter(
      (b) => b >= floor && b <= max
    );
    cut = words?.length ? words[words.length - 1]! : graphemeSafe(line, max);
  }
  const shortened = tidyEnd(line.slice(0, cut));
  return shortened || line.slice(0, graphemeSafe(line, max));
}
