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
import {
  OBJECT_REF_SCHEME,
  referenceRead,
  referenceView,
  type ReferenceRead,
} from "@synap-core/markdown-core/object-ids";
import {
  CELL_FRAME_MAX_BYTES,
  htmlByteLength,
} from "@synap-core/types/cell-bridge";
import {
  resolveEntityMedia,
  type MediaRef,
} from "@synap-core/types/presentation";
import { isHtmlPageSource } from "@synap-core/types/renderables";
import {
  resolveObjectNoun,
  type EmbedCellInstance,
  type ProfileIdentityInput,
} from "@synap-core/types/vocabulary";
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

/**
 * How wide a body's text runs: `reading` keeps the 65-character measure of a
 * field or a short body; `wide` lets a document use its card (tables, charts).
 */
export type ContentMeasure = "reading" | "wide";

export function contentMeasureClass(measure: ContentMeasure): string {
  return measure === "wide" ? "max-w-none" : "max-w-[65ch]";
}

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
 * The console page for an object, or null when `/open` does not know the
 * kind or the id fails that kind's check. A hosted kind (and a proposal) goes
 * through the one exit door; any other known kind lands on `/open`'s named
 * card, which hands it to the app with the device's install fallback — never
 * a bare `synap://` drawn inside content.
 */
export function objectPage(kind: string, id: string): string | null {
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

/** An object marker's console page (`entity://<id>` → `/open/entity/<id>`). */
function markerPage(url: string): string | null {
  const m = /^([a-z][a-z0-9_-]*):\/\/([^/?#\s]+)$/i.exec(url);
  if (!m) return null;
  if (COMMAND_SCHEMES.has(m[1]!.toLowerCase())) return null;
  try {
    return objectPage(objectKindForMarker(m[1]!), decodeURIComponent(m[2]!));
  } catch {
    return null;
  }
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

/**
 * What an embedded record may say about itself, from the reader's own
 * `entities.get`. `hidden` covers "not visible to you" AND "gone": the pod
 * answers NOT_FOUND for both, so neither the title nor which one it is leaks.
 * `failed` is a broken read (network, 500) — retryable, never "hidden".
 * `unresolved` = this surface reads no records; the card names the kind only.
 */
export type EmbedEntityRead =
  | { state: "unresolved" }
  | { state: "loading" }
  /** `media`: the record's own image (an uploaded file), when it has one. */
  | { state: "ready"; title: string; media?: MediaRef }
  | { state: "hidden" }
  | { state: "failed"; retry?: () => void };

const HIDDEN_CODES: ReadonlySet<string> = new Set([
  "NOT_FOUND",
  "FORBIDDEN",
  "BAD_REQUEST",
  "UNAUTHORIZED",
]);

export function entityEmbedRead(query: {
  isLoading: boolean;
  error: { data?: { code?: string | null } | null } | null | undefined;
  data: unknown;
  retry?: () => void;
}): EmbedEntityRead {
  if (query.error) {
    const code = query.error.data?.code;
    return code && HIDDEN_CODES.has(code)
      ? { state: "hidden" }
      : { state: "failed", ...(query.retry ? { retry: query.retry } : {}) };
  }
  if (query.isLoading) return { state: "loading" };
  const entity = (
    query.data as
      | {
          entity?: {
            id?: unknown;
            title?: unknown;
            documentId?: unknown;
            properties?: unknown;
            systemData?: unknown;
          };
        }
      | undefined
  )?.entity;
  if (!entity) return { state: "hidden" };
  const title = typeof entity.title === "string" ? entity.title.trim() : "";
  const { primary } = resolveEntityMedia({
    id: typeof entity.id === "string" ? entity.id : "",
    documentId:
      typeof entity.documentId === "string" ? entity.documentId : null,
    properties:
      entity.properties && typeof entity.properties === "object"
        ? (entity.properties as Record<string, unknown>)
        : null,
    systemData: entity.systemData,
  });
  return {
    state: "ready",
    title: title || "Untitled",
    ...(primary.via === "none" ? {} : { media: primary }),
  };
}

/**
 * What a document's cell embed may draw, from the reader's own
 * `widgetDefinitions.get` (the viewer's floor; it answers `null` for a cell
 * that is not visible to them or no longer exists).
 *
 *   page        an HTML page: it runs in the isolated frame (`html-frame`)
 *   app         a cell only the app runs (a sandboxed React module)
 *   hidden      not visible to you, or gone — the pod does not say which
 *   failed      a broken read, retryable — never "hidden", never an empty frame
 *   unresolved  this surface reads no cells
 */
export type EmbedCellRead =
  | { state: "unresolved" }
  | { state: "loading" }
  | {
      state: "page";
      html: string;
      bytes: number;
      tooLarge: boolean;
      /** The cell's own space: the lens its reads are stamped with. */
      workspaceId: string | null;
    }
  | { state: "app" }
  | { state: "hidden" }
  | { state: "failed"; retry?: () => void };

/**
 * Whether a stored cell IS an HTML page. The stored mechanism decides
 * (`widget_definitions.renderer_type`): `iframe` is a raw HTML document.
 * `frame` is not proof of React: until `defineCell` derived the mechanism
 * from the source (migration 0366 moved the rows written before), every agent
 * door stored a page as `frame`, so a `frame` row whose source IS a page is a
 * page too. "Is a page" is the ONE classifier, `isHtmlPageSource`
 * (`@synap-core/types/renderables`): the first character after whitespace is
 * `<`, which an ES module never is. Not a doctype test: the founder's report
 * opens with `<title>` (document 6aa8d140).
 */
export function cellIsHtmlPage(def: {
  rendererType?: unknown;
  rendererSource?: unknown;
}): boolean {
  const source =
    typeof def.rendererSource === "string" ? def.rendererSource : "";
  if (!source.trim()) return false;
  if (def.rendererType === "iframe") return true;
  return def.rendererType === "frame" && isHtmlPageSource(source);
}

export function cellEmbedRead(query: {
  isLoading: boolean;
  error: { data?: { code?: string | null } | null } | null | undefined;
  data: unknown;
  retry?: () => void;
}): EmbedCellRead {
  if (query.error) {
    const code = query.error.data?.code;
    return code && HIDDEN_CODES.has(code)
      ? { state: "hidden" }
      : { state: "failed", ...(query.retry ? { retry: query.retry } : {}) };
  }
  if (query.isLoading) return { state: "loading" };
  const def = query.data as
    | {
        rendererType?: unknown;
        rendererSource?: unknown;
        workspaceId?: unknown;
      }
    | null
    | undefined;
  if (!def) return { state: "hidden" };
  if (!cellIsHtmlPage(def)) return { state: "app" };
  const html = def.rendererSource as string;
  const bytes = htmlByteLength(html);
  return {
    state: "page",
    html,
    bytes,
    tooLarge: bytes > CELL_FRAME_MAX_BYTES,
    workspaceId: typeof def.workspaceId === "string" ? def.workspaceId : null,
  };
}

/**
 * What a cell embed that names only an instance (`:::synap-cell{instanceId}`)
 * may say about it, from the reader's own `cellInstances.get` (the viewer's
 * floor; NOT_FOUND for an instance not visible to them or gone). `ready`
 * carries its name and its type: the key the embed then runs or opens.
 *
 *   hidden  not visible to you, or gone — the pod does not say which
 *   failed  a broken read, retryable — never "hidden", never "Card"
 */
export type EmbedCellInstanceRead =
  | { state: "loading" }
  | { state: "ready"; instance: EmbedCellInstance }
  | { state: "hidden" }
  | { state: "failed"; retry?: () => void };

export function cellInstanceEmbedRead(query: {
  isLoading: boolean;
  error: { data?: { code?: string | null } | null } | null | undefined;
  data: unknown;
  retry?: () => void;
}): EmbedCellInstanceRead {
  const failed: EmbedCellInstanceRead = {
    state: "failed",
    ...(query.retry ? { retry: query.retry } : {}),
  };
  if (query.error) {
    const code = query.error.data?.code;
    return code && HIDDEN_CODES.has(code) ? { state: "hidden" } : failed;
  }
  if (query.isLoading) return { state: "loading" };
  const row = query.data as
    { name?: unknown; cellType?: unknown } | null | undefined;
  if (!row) return { state: "hidden" };
  // An answer without a type is not an instance the console can name or
  // open: a broken read, not an empty one.
  if (typeof row.cellType !== "string" || !row.cellType.trim()) return failed;
  return {
    state: "ready",
    instance: {
      name: typeof row.name === "string" ? row.name : null,
      cellType: row.cellType,
    },
  };
}

// ─── Object references (a marker, or a bare id in prose) ────────────────────

/**
 * A reference in content: the kind its marker names (`null` when the author
 * wrote only the id: `object://<id>`, from markdown-core `linkObjectIds`) and
 * the id. Commands (`run://`, `open://`) are not references.
 */
export interface ObjectRef {
  markerKind: string | null;
  id: string;
}

export function objectRefOf(url: string | null | undefined): ObjectRef | null {
  const raw = url?.trim() ?? "";
  // The same order as `contentHref`: a web address is a web link first, even
  // one with no path (`https://example.com` has the shape of a marker).
  if (!isMarkerHref(raw)) return null;
  const m = /^([a-z][a-z0-9_-]*):\/\/([^/?#\s]+)$/i.exec(raw);
  if (!m) return null;
  const scheme = m[1]!.toLowerCase();
  if (COMMAND_SCHEMES.has(scheme) || EXTERNAL_PROTOCOLS.has(`${scheme}:`))
    return null;
  let id: string;
  try {
    id = decodeURIComponent(m[2]!);
  } catch {
    return null;
  }
  return { markerKind: scheme === OBJECT_REF_SCHEME ? null : scheme, id };
}

/**
 * What the reader's own lookup says about a reference: markdown-core's
 * `ReferenceRead` (the one rule), plus what only this console holds — the
 * kind's profile for the icon and colour, and the retry of a broken lookup.
 */
export type ObjectRefRead =
  | Exclude<ReferenceRead, { state: "ready" } | { state: "failed" }>
  | (Extract<ReferenceRead, { state: "ready" }> & {
      profile?: ProfileIdentityInput;
    })
  | { state: "failed"; retry?: () => void };

export function objectRefRead(
  query: Parameters<typeof referenceRead>[0] & {
    profile?: ProfileIdentityInput | null;
    retry?: () => void;
  }
): ObjectRefRead {
  const read = referenceRead(query);
  if (read.state === "failed")
    return { state: "failed", ...(query.retry ? { retry: query.retry } : {}) };
  if (read.state === "ready" && query.profile)
    return { ...read, profile: query.profile };
  return read;
}

/** How a reference is drawn: plain words, or a chip with its kind's identity. */
export type ObjectRefView =
  | {
      kind: "text";
      text: string;
      /** The lookup broke: the words stay, with a mark to ask again. */
      failed?: { retry?: () => void };
    }
  | {
      kind: "chip";
      text: string;
      /** The kind the icon and colour come from (the entity's kind first). */
      identityKind: string;
      profile?: ProfileIdentityInput;
      href: string | null;
      /** The name is still being looked up. */
      pending: boolean;
      failed?: { retry?: () => void };
    };

/**
 * A reference drawn in the console: markdown-core's `referenceView` (the one
 * rule every surface draws by) with this console's page for what it opens,
 * the kind's profile, and the retry of a broken lookup.
 */
export function objectRefView(
  ref: ObjectRef,
  label: string,
  read: ObjectRefRead
): ObjectRefView {
  const view = referenceView(
    {
      markerKind:
        ref.markerKind === null ? null : objectKindForMarker(ref.markerKind),
      id: ref.id,
    },
    label,
    read.state === "failed" ? { state: "failed" } : read,
    resolveObjectNoun
  );
  const failed = view.failed
    ? {
        failed:
          read.state === "failed" && read.retry ? { retry: read.retry } : {},
      }
    : {};
  if (view.kind === "text") return { kind: "text", text: view.text, ...failed };
  const profile = read.state === "ready" ? read.profile : undefined;
  return {
    kind: "chip",
    text: view.text,
    identityKind: view.identityKind,
    ...(profile ? { profile } : {}),
    href: view.opens ? objectPage(view.opens.kind, view.opens.id) : null,
    pending: view.pending,
    ...failed,
  };
}
