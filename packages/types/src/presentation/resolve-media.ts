/**
 * resolveEntityMedia / resolvePresentationFamily — the ONE answer to "what is
 * this entity's primary media" and "which anatomy does it get".
 *
 * Pure, no I/O, LEAF (no zod / drizzle / React): web, relay (Hermes) and the
 * pod all call it. It returns a REFERENCE (`MediaRef`), never a URL, and never
 * decides renderability: the mime is passed through and the display door
 * (`useStoredFileUrl` → `SpatialMediaPreview`) owns the allowlist.
 *
 * No kind slug is hand-coded here. A kind's media lives where its profile
 * DECLARES (`presentation.media.source`, catalog → `uiHints.presentation`);
 * legacy property names (brand-asset `asset-document-id`, …) are covered by
 * those declarations, not by this file.
 */

import {
  readEntityMediaCopies,
  type EntityMediaCopy,
  type MediaRef,
  type PresentationFamily,
  type PresentationMediaKind,
  type ProfilePresentation,
} from "./index.js";

/** The minimal entity shape the resolver reads. */
export interface MediaEntityInput {
  id: string;
  documentId?: string | null;
  properties?: Record<string, unknown> | null;
  systemData?: unknown;
}

export interface ResolvedEntityMedia {
  /** The one media a card/tile draws. `{ via: "none" }` when there is none. */
  primary: MediaRef;
  /** `primary` (when not none) followed by every other pod-held copy. */
  all: MediaRef[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HTTP_URL = /^https?:\/\/\S+$/i;

/**
 * Resolve an entity's primary media. Order — first hit wins:
 *   a. a pod-held COPY (`systemData.media`) of the declared property's URL —
 *      the copy whose `sourceUrl` equals it; for the LINK family only, else the
 *      first copy (the pod copied a derived image, the page's og:image). Any
 *      other family with no matching copy is (b) external: a copy of a
 *      different URL is a stale copy of the previous value;
 *   b. the DECLARED source: `{property}` holding a document id (stored) or an
 *      http(s) URL (external); `{documentId: true}` (the entity's own linked
 *      document); `{entityRef}` (another entity whose media is used);
 *   c. no declaration: the entity's own linked document when its `mimeType`
 *      property says image/ or video/;
 *   d. any pod-held copy (`systemData.media`) — a copy exists only because a
 *      producer handed the pod that media on purpose (Apify carousel slides on
 *      a post, a page's og:image), so a kind that declares no media source
 *      (post = work family) still shows it;
 *   e. none.
 * A declared source that yields nothing falls through to (c).
 */
export function resolveEntityMedia(
  entity: MediaEntityInput,
  presentation?: ProfilePresentation | null
): ResolvedEntityMedia {
  const copies = readEntityMediaCopies(entity.systemData);
  const primary = resolvePrimary(entity, presentation ?? null, copies);
  const all: MediaRef[] = primary.via === "none" ? [] : [primary];
  for (const copy of copies) {
    if (primary.via === "stored" && primary.documentId === copy.documentId)
      continue;
    all.push(copyRef(copy));
  }
  return { primary, all };
}

function resolvePrimary(
  entity: MediaEntityInput,
  presentation: ProfilePresentation | null,
  copies: EntityMediaCopy[]
): MediaRef {
  const props = entity.properties ?? {};
  const mime = str(props.mimeType);
  const source = presentation?.media?.source;
  const kind: PresentationMediaKind = presentation?.media?.kind ?? "auto";

  // Only a LINK's declared URL is a page whose image the pod copies under a
  // different URL (its og:image), so only a link may take a copy that does not
  // match. For any other family (an avatar, a cover) a non-matching copy is the
  // PREVIOUS value's: drawing it would show a stale image — forever, if the new
  // URL's copy is refused.
  const derivedCopy = (): EntityMediaCopy | undefined =>
    presentation?.family === "link" ? copies[0] : undefined;

  if (source && "property" in source) {
    const value = firstString(props[source.property]);
    if (value && HTTP_URL.test(value)) {
      // (a) the pod holds a copy of it: never hot-link (an <img> on a third-party
      // URL leaks the viewer's IP/referrer and dies with the source).
      const copy = copies.find((c) => c.sourceUrl === value) ?? derivedCopy();
      if (copy) return copyRef(copy);
      // (b) not copied (yet): an external reference, drawn as a link, never an <img>.
      return { via: "external", url: value, kind };
    }
    if (value && UUID.test(value)) return stored({ documentId: value, mime });
  } else if (source && "documentId" in source) {
    const documentId = str(entity.documentId);
    if (documentId) return stored({ documentId, mime });
  } else if (source && "entityRef" in source) {
    const entityId = firstString(props[source.entityRef]);
    if (entityId && UUID.test(entityId)) return { via: "stored", entityId };
  }

  // (c) undeclared: the entity's own file, when it is an image or a video.
  const documentId = str(entity.documentId);
  if (documentId && mime && /^(image|video)\//i.test(mime))
    return stored({ documentId, mime });

  // (d) the pod holds a copy a producer handed it on purpose.
  if (copies[0]) return copyRef(copies[0]);

  return { via: "none" };
}

/**
 * The anatomy family: the profile's declaration, else from the mime type
 * (image/video → media, pdf/text/markdown → document), else `undefined` —
 * the generic anatomy.
 */
export function resolvePresentationFamily(
  presentation?: ProfilePresentation | null,
  mime?: string | null
): PresentationFamily | undefined {
  if (presentation?.family) return presentation.family;
  const m = (mime ?? "").trim().toLowerCase();
  if (!m) return undefined;
  if (m.startsWith("image/") || m.startsWith("video/")) return "media";
  if (
    m === "application/pdf" ||
    m.startsWith("text/") ||
    m === "application/markdown"
  )
    return "document";
  return undefined;
}

function copyRef(copy: EntityMediaCopy): MediaRef {
  return stored({
    documentId: copy.documentId,
    mime: copy.mime,
    width: copy.width,
    height: copy.height,
  });
}

/** A stored ref without `undefined` keys (stable for equality in tests and caches). */
function stored(ref: {
  documentId: string;
  mime?: string;
  width?: number;
  height?: number;
}): MediaRef {
  const out: MediaRef = { via: "stored", documentId: ref.documentId };
  if (ref.mime) out.mime = ref.mime;
  if (typeof ref.width === "number") out.width = ref.width;
  if (typeof ref.height === "number") out.height = ref.height;
  return out;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** A property value as one string: a string, or the first string of a list. */
function firstString(v: unknown): string | undefined {
  if (Array.isArray(v))
    return str(v.find((x) => typeof x === "string" && x.trim()));
  return str(v);
}
