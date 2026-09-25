/**
 * INLINE `[[kind:id|label]]` MARKERS — the ONE grammar, the ONE escape rule.
 *
 * AI prose, chat and documents name records with these markers. Everything
 * that reads or writes one goes through this module:
 *   - the grammar (`matchInlinePatterns` / `parseInlinePatterns`),
 *   - the ONE label escape (`sanitizeMarkerLabel`) and the ONE writer
 *     (`formatMarker`),
 *   - the presentation rewrite to `[label](kind://id)` links
 *     (`resolvePatternMarkers`),
 *   - the segmenting adapter renderers use (`splitInlineMarkers`,
 *     `flattenInlineMarkers`).
 *
 * Moved here from `@synap-core/message-parser` (which now re-exports it) and
 * `markdown-engine/src/inline-markers.ts`, so the backend (run summaries) and
 * the apps share one grammar instead of a second escape rule each.
 *
 * Pure and dependency-free: importable from `@synap-core/markdown-core/markers`
 * without pulling the markdown parser.
 */

/**
 * The ONE source of truth for the reference-kind list. Both `buildPattern`
 * and `resolvePatternMarkers` drive their per-kind logic off this array, and
 * the native chip renderers import it so their coverage can never drift from
 * the markdown path. Adding an object kind = one edit here.
 */
export const REFERENCE_KINDS = [
  "entity",
  "doc",
  "view",
  "person",
  "widget",
  "automation",
  "channel",
  "project",
] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

type IdRef<K extends ReferenceKind> = { kind: K; id: string; label: string };

/** Reference patterns (always safe, render as clickable elements). */
export type ReferencePattern =
  | IdRef<"entity">
  | IdRef<"doc">
  | IdRef<"view">
  | IdRef<"person">
  | { kind: "widget"; cellKey: string; label: string }
  | IdRef<"automation">
  | IdRef<"channel">
  | IdRef<"project">;

export const OPEN_PLACEMENTS = [
  "side",
  "main",
  "companion",
  "floating",
] as const;
export const OPEN_RESOURCE_TYPES = [
  "entity",
  "view",
  "doc",
  "cell",
  "channel",
] as const;

/** Command patterns (permission-gated, shown as action chips). */
export type CommandPattern =
  | {
      kind: "open";
      placement: (typeof OPEN_PLACEMENTS)[number];
      resourceType: (typeof OPEN_RESOURCE_TYPES)[number];
      /** entityId, viewId, docId, cellKey, channelId */
      resourceId: string;
      label?: string;
    }
  | { kind: "run"; id: string; label: string };

export type PatternEvent = ReferencePattern | CommandPattern;
/** Alias kept for the `@synap-core/message-parser` public API. */
export type PatternEventType = PatternEvent;

/**
 * Regex for all inline patterns.
 * Format: [[kind:id_or_key|label]] or [[kind:id_or_key:label]] (legacy colon
 * separator) or [[kind:placement|resourceType:id]] — and the LABEL-LESS
 * [[kind:id]], which the docs teach (`[[view:ID]]`): its name is the object's
 * own, resolved by the renderer, so the label group is optional.
 *
 * Both `|` and `:` are accepted as the separator between ID and label for
 * backward compatibility with agents trained on the old colon syntax. Only
 * `formatMarker` WRITES a marker, and it always writes `|`.
 */
const PATTERN_REGEX = /\[\[(\w+):([^\]|:]+)(?:[|:]([^\]]*))?\]\]/g;

/**
 * Escape an arbitrary string so it is safe to embed as the LABEL of a
 * `[[kind:id|label]]` marker — THE one escape rule, for every producer
 * (hashable inserts, run chips, arg summaries, backend run summaries).
 *
 * - `]` terminates the label group, so a raw `]` (e.g. `"[DRAFT] Q3"`) would
 *   end the marker early and leave stray text.
 * - `[` is stripped too: the label is re-emitted as markdown link text by
 *   `resolvePatternMarkers` (`[label](kind://id)`), where an unbalanced `[`
 *   breaks the link, and a `[[` inside arbitrary text (an error body echoed
 *   into a summary) must never be able to open a second marker.
 * - `|` is legal inside the label group and is kept.
 * - whitespace runs collapse so the marker stays one line.
 *
 * Returns "" for a label with nothing left; the caller owns its fallback word.
 */
export function sanitizeMarkerLabel(label: string): string {
  return label.replace(/[[\]]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * THE marker writer. Every producer that builds a `[[kind:id|label]]` string
 * calls this, so the escape rule above is applied exactly once and the id can
 * never carry a delimiter.
 */
export function formatMarker(kind: string, id: string, label: string): string {
  const safeId = id.replace(/[[\]|:\s]/g, "");
  return `[[${kind}:${safeId}|${sanitizeMarkerLabel(label)}]]`;
}

export interface ParseResult {
  /** Original text with pattern markers preserved (for React rendering) */
  raw: string;
  /** All extracted patterns in order of appearance */
  patterns: PatternEvent[];
}

/**
 * Raw regex matches (with position info), for callers that need to
 * reconstruct ordered text/pattern segments — e.g. native chat renderers
 * that interleave plain-text spans with pressable reference chips.
 */
export function matchInlinePatterns(text: string): RegExpMatchArray[] {
  return [...text.matchAll(PATTERN_REGEX)];
}

export function parseInlinePatterns(text: string): ParseResult {
  const patterns: PatternEvent[] = [];
  for (const match of text.matchAll(PATTERN_REGEX)) {
    const [, kind, idOrKey, label = ""] = match;
    const evt = buildPattern(kind!, idOrKey!, label);
    if (evt) patterns.push(evt);
  }
  return { raw: text, patterns };
}

function isOneOf<T extends string>(
  list: readonly T[],
  value: string
): value is T {
  return (list as readonly string[]).includes(value);
}

function buildPattern(
  kind: string,
  idOrKey: string,
  label: string
): PatternEvent | null {
  // Reference kinds all share the `{ kind, <ref>, label }` shape. `widget` is
  // the lone shape exception: it carries `cellKey` instead of `id`.
  // An EMPTY label means "unlabeled": the renderer resolves the object's name
  // (the kind's noun until then). It never falls back to the id — a raw uuid
  // in a sentence is machinery, not a name.
  if (isOneOf(REFERENCE_KINDS, kind)) {
    return kind === "widget"
      ? { kind: "widget", cellKey: idOrKey, label }
      : ({ kind, id: idOrKey, label } as ReferencePattern);
  }
  switch (kind) {
    case "open": {
      // [[open:PLACEMENT|TYPE:ID]]
      const parts = label.split(":");
      if (parts.length < 2) return null;
      const [resourceType, resourceId] = parts as [string, string];
      const placement = isOneOf(OPEN_PLACEMENTS, idOrKey) ? idOrKey : "side";
      const rt = isOneOf(OPEN_RESOURCE_TYPES, resourceType)
        ? resourceType
        : "entity";
      return { kind: "open", placement, resourceType: rt, resourceId, label };
    }
    case "run":
      return { kind: "run", id: idOrKey, label };
    default:
      return null;
  }
}

/**
 * Transforms inline pattern markers into markdown-compatible URLs
 * for ReactMarkdown rendering. Replaces [[kind:id|label]] or [[kind:id:label]]
 * (both separators accepted) with [label](kind://id).
 *
 * open:// and run:// are emitted as custom-scheme links so the ReactMarkdown
 * `a` component can render them as inline action chips.
 */
export function resolvePatternMarkers(text: string): string {
  // Commands FIRST (they have distinct output shapes), so the generic reference
  // pass below can't swallow them.
  let out = text
    // Human label is object-facing ("Open"); placement stays in the scheme only.
    .replace(
      /\[\[open:(\w+)[|:](\w+):([^\]]+)\]\]/g,
      (_, placement, type, id) => `[Open](open://${placement}/${type}/${id})`
    )
    .replace(
      /\[\[run:([^\]|:]+)(?:[|:]([^\]]*))?\]\]/g,
      (_, id, label) => `[${label || "Run"}](run://${id})`
    );
  // Any remaining [[KIND:ID|label]] → a reference chip link of THAT kind. The
  // render path is kind-AGNOSTIC on purpose: the object-registry can render any
  // object kind, so we rewrite `[[<kind>:id|label]]` → `[label](<kind>://id)`
  // for ANY kind word and let the chip renderer resolve identity. (`person`
  // keeps the shared `entity://` scheme for back-compat.) The strict, typed
  // `buildPattern`/`parseInlinePatterns` path stays limited to REFERENCE_KINDS.
  // A label-less marker becomes an EMPTY link text: the chip resolves the
  // object's name (never the id). Commands never reach this pass.
  out = out.replace(
    /\[\[(?!(?:open|run):)([a-z][a-z0-9_-]*):([^\]|:]+)(?:[|:]([^\]]*))?\]\]/gi,
    (_, kind: string, id: string, label: string | undefined) => {
      const scheme = kind === "person" ? "entity" : kind;
      return `[${label ?? ""}](${scheme}://${id})`;
    }
  );
  return out;
}

/**
 * Is `url` one of the custom-scheme hrefs `resolvePatternMarkers` emits
 * (`<kind>://id`, `open://…`, `run://…`)? A renderer's URL sanitizer MUST keep
 * these: react-markdown's `defaultUrlTransform` allows only http(s)/mailto/…,
 * so it blanked every chip href to "" and the chip handler never matched —
 * labelled chips drew as plain links, label-less ones as EMPTY anchors (W5f
 * F3 re-walk). Script-capable schemes are refused even in `x://` form; hosts
 * render these hrefs as chips, never as navigable `<a href>`.
 */
export function isMarkerHref(url: string): boolean {
  return /^(?!(?:javascript|vbscript|data|file|blob):)[a-z][a-z0-9_-]*:\/\/\S+$/i.test(
    url
  );
}

// ─── Segmenting adapter (was markdown-engine/src/inline-markers.ts) ─────────

export type InlineMarkerSegment =
  | { type: "text"; value: string }
  /** `pattern` is null when the marker matched the grammar but names no known kind. */
  | { type: "marker"; raw: string; pattern: PatternEvent | null };

const REFERENCE_KIND_SET = new Set<string>(REFERENCE_KINDS);

export function isReferenceKind(value: unknown): value is ReferenceKind {
  return typeof value === "string" && REFERENCE_KIND_SET.has(value);
}

export function isReferencePattern(
  pattern: PatternEvent | null
): pattern is ReferencePattern {
  return !!pattern && isReferenceKind(pattern.kind);
}

/** `widget` carries a cell key where every other reference carries an id. */
export function referenceId(ref: ReferencePattern): string {
  return ref.kind === "widget" ? ref.cellKey : ref.id;
}

export function splitInlineMarkers(content: string): InlineMarkerSegment[] {
  if (!content) return [];
  const segments: InlineMarkerSegment[] = [];
  let lastIndex = 0;
  for (const match of matchInlinePatterns(content)) {
    const index = match.index ?? 0;
    const raw = match[0];
    if (index > lastIndex) {
      segments.push({ type: "text", value: content.slice(lastIndex, index) });
    }
    segments.push({
      type: "marker",
      raw,
      pattern: parseInlinePatterns(raw).patterns[0] ?? null,
    });
    lastIndex = index + raw.length;
  }
  if (lastIndex < content.length) {
    segments.push({ type: "text", value: content.slice(lastIndex) });
  }
  return segments;
}

/**
 * What a marker reads as when it cannot be a chip. A reference reads as its
 * label; a command as its label; a marker naming no known kind stays RAW —
 * dropping it would silently delete words from the author's sentence.
 */
export function markerText(
  segment: Extract<InlineMarkerSegment, { type: "marker" }>,
  nounFor: MarkerNoun = (kind) => kind
): string {
  const pattern = segment.pattern;
  if (!pattern) return segment.raw;
  if (isReferencePattern(pattern))
    return pattern.label || nounFor(pattern.kind);
  if (pattern.kind === "run") return pattern.label || "Run";
  if (pattern.kind === "open") return pattern.label || "Open";
  return segment.raw;
}

/**
 * What an UNLABELED reference reads as where nothing can resolve its name
 * (plain text, a native line): the kind's noun. This package is dependency
 * free, so the caller passes the vocabulary's `resolveObjectNoun`; the default
 * is the kind word itself — never the id.
 */
export type MarkerNoun = (kind: ReferenceKind) => string;

/** Markers → their readable text; everything else untouched. */
export function flattenInlineMarkers(
  content: string,
  nounFor?: MarkerNoun
): string {
  if (!content.includes("[[")) return content;
  return splitInlineMarkers(content)
    .map((s) => (s.type === "text" ? s.value : markerText(s, nounFor)))
    .join("");
}
