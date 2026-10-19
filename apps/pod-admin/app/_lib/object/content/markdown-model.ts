/**
 * The console's read-only content model — pure, so every rule a reader's
 * safety rests on is unit-tested: how much of a body is drawn, which links
 * may be followed, and where an object marker leads.
 *
 * The console has no Content-Security-Policy to fall back on, so safety comes
 * from construction: content is drawn as React elements only (React escapes
 * every text node), a link is followed only when this file says so, and a
 * remote image is never loaded.
 */

// Subpaths, not the package root: the root also loads the parser, which only
// the lazily-loaded view may pay for.
import { splitMarkdownBlocks } from "@synap-core/markdown-core/diff";
import { isMarkerHref } from "@synap-core/markdown-core/markers";
import { openIn } from "../../../../lib/open-in";
import { parseOpenParams } from "../../../open/open-params";

/** A body longer than this is drawn up to a block boundary near it. */
export const CONTENT_MAX_CHARS = 120_000;

/** Past this, markdown is not parsed at all: the first lines show as plain text. */
export const CONTENT_PARSE_LIMIT = 2_000_000;

/** How much of an unparsed body shows. */
export const UNPARSED_PREVIEW_CHARS = 5_000;

/**
 * How a body is drawn. `source` is text shown exactly as written in a
 * monospace block — an HTML document, or markdown too large to parse. Never
 * interpreted.
 */
export type ContentFormat = "markdown" | "text" | "code" | "source";

export interface PreparedContent {
  format: ContentFormat;
  text: string;
  /** The body continues past what is drawn. */
  truncated: boolean;
  /** Share of the body drawn, 1–100. */
  shownPercent: number;
}

function percent(shown: number, total: number): number {
  if (total === 0 || shown >= total) return 100;
  return Math.max(1, Math.floor((shown / total) * 100));
}

/** Cut at the last line break before `max`, or at `max` when a line is longer. */
function cutAtLine(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const lastBreak = head.lastIndexOf("\n");
  return lastBreak > 0 ? head.slice(0, lastBreak) : head;
}

/**
 * The blocks of `markdown` that fit in `max` characters, whole. A first block
 * longer than `max` (one huge code sample) is cut at a line instead, so
 * something always shows.
 */
function cutAtBlock(markdown: string, max: number): string {
  const kept: string[] = [];
  let used = 0;
  for (const block of splitMarkdownBlocks(markdown)) {
    const cost = block.length + (kept.length > 0 ? 2 : 0);
    if (used + cost > max) break;
    kept.push(block);
    used += cost;
  }
  return kept.length > 0 ? kept.join("\n\n") : cutAtLine(markdown, max);
}

/** What of `source` the console draws, and how. */
export function prepareContent(
  source: string,
  format: ContentFormat,
  { maxChars = CONTENT_MAX_CHARS }: { maxChars?: number } = {}
): PreparedContent {
  const total = source.length;
  if (format === "markdown" && total > CONTENT_PARSE_LIMIT) {
    const text = cutAtLine(source, UNPARSED_PREVIEW_CHARS);
    return {
      format: "source",
      text,
      truncated: true,
      shownPercent: percent(text.length, total),
    };
  }
  if (total <= maxChars) {
    return { format, text: source, truncated: false, shownPercent: 100 };
  }
  const text =
    format === "markdown"
      ? cutAtBlock(source, maxChars)
      : cutAtLine(source, maxChars);
  return {
    format,
    text,
    truncated: true,
    shownPercent: Math.min(99, percent(text.length, total)),
  };
}

/**
 * Where a link in content may lead.
 *   external — http(s) or mailto, opened in a new tab without a referrer.
 *   internal — a console page for an object marker (`[[entity:…]]`).
 *   none     — anything else (`javascript:`, `data:`, a relative path, a raw
 *              `synap://`): the label shows as text and nothing is followed.
 */
export type ContentHref =
  | { kind: "external"; href: string }
  | { kind: "internal"; href: string }
  | { kind: "none" };

/** `rel` every external link in content carries. */
export const EXTERNAL_REL = "noopener noreferrer nofollow";

const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/**
 * Marker schemes that name an open kind by another word. `person` is already
 * `entity` once `resolvePatternMarkers` ran; `widget` addresses a cell type.
 */
const MARKER_KIND: Readonly<Record<string, string>> = {
  doc: "document",
  person: "entity",
  widget: "cell",
};

/**
 * Marker schemes that are ACTIONS, not objects (`[[run:…]]` runs a
 * capability, `[[open:…]]` places a panel). A reader never performs them.
 */
const COMMAND_SCHEMES: ReadonlySet<string> = new Set(["run", "open"]);

/** The open kind a marker scheme names (`doc` → `document`). */
export function objectKindForMarker(scheme: string): string {
  const lower = scheme.toLowerCase();
  return MARKER_KIND[lower] ?? lower;
}

/**
 * The console page for an object marker, or null when the marker names no
 * kind `/open` knows or its id fails that kind's check. A hosted kind (and a
 * proposal) goes through the one exit door; any other known kind lands on
 * `/open`'s named card, which hands it to the app with the device's install
 * fallback — never a bare `synap://` drawn inside content.
 */
function markerPage(url: string): string | null {
  const m = /^([a-z][a-z0-9_-]*):\/\/([^/?#\s]+)$/i.exec(url);
  if (!m) return null;
  if (COMMAND_SCHEMES.has(m[1]!.toLowerCase())) return null;
  const kind = objectKindForMarker(m[1]!);
  let id: string;
  try {
    id = decodeURIComponent(m[2]!);
  } catch {
    return null;
  }
  const parsed = parseOpenParams(kind, id);
  if (parsed.status === "host" || parsed.type === "proposal") {
    if (parsed.status === "invalid-id") return null;
    return openIn({ kind: "object", objectKind: parsed.type, id: parsed.id })
      .href;
  }
  if (parsed.status === "bounce") {
    return `/open/${encodeURIComponent(parsed.type)}/${encodeURIComponent(parsed.id)}`;
  }
  return null;
}

/** Decide what a link in content may do. */
export function contentHref(url: string | null | undefined): ContentHref {
  const raw = url?.trim();
  if (!raw) return { kind: "none" };
  let parsed: URL | null = null;
  try {
    parsed = new URL(raw);
  } catch {
    return { kind: "none" };
  }
  if (EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
    if (parsed.username || parsed.password) return { kind: "none" };
    return { kind: "external", href: parsed.toString() };
  }
  if (isMarkerHref(raw)) {
    const page = markerPage(raw);
    return page ? { kind: "internal", href: page } : { kind: "none" };
  }
  return { kind: "none" };
}
