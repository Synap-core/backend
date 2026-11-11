/**
 * The console's ONE media door, as pure rules: which pod door signs a stored
 * media reference, what the signing answered, and what the reader is shown —
 * an image, a video or an audio file to play, a file to download, a link out,
 * a labelled failure, or nothing.
 *
 * WHAT is an entity's media is not decided here: `resolveEntityMedia`
 * (`@synap-core/types/presentation`) answers it for every surface, from what
 * the kind's profile declares. This file only turns its `MediaRef` into
 * something a console page can draw, the way the app's `useStoredFileUrl` →
 * `SpatialMediaPreview` does:
 *
 *   · bytes are signed by the pod on the viewer's own floor
 *     (`GET /api/files/documents/:id/url`, `GET /api/files/:entityId/url`,
 *     Kratos cookie) — never an admin door, never a bucket URL;
 *   · only `INLINE_IMAGE_MIME_TYPES` reach an `<img>`, only
 *     `INLINE_VIDEO_MIME_TYPES` a `<video>` and only `INLINE_AUDIO_MIME_TYPES`
 *     an `<audio>`: three lists that never overlap, and a media element only
 *     DECODES its bytes, so the two newer ones cannot reopen the SVG hole. An
 *     SVG is a script-capable document on the storage origin, so it — and any
 *     type the pod did not name — is a file to download, never drawn. The type
 *     that decides is the one the pod SIGNED (what the storage origin will
 *     serve), not what a reference claims;
 *   · an external URL is never loaded (an `<img>` on a third-party address
 *     tells it who is reading); it stays a link the reader chooses to follow;
 *   · a failed signing is never folded into "no image": it says why, and
 *     offers the retry.
 */

import {
  INLINE_AUDIO_MIME_TYPES,
  INLINE_IMAGE_MIME_TYPES,
  INLINE_VIDEO_MIME_TYPES,
  type MediaRef,
} from "@synap-core/types/presentation";

export type StoredMediaRef = Extract<MediaRef, { via: "stored" }>;

/** Re-sign this long before the signed URL expires (skew + render time). */
const EXPIRY_SKEW_MS = 60_000;
/** Never re-sign sooner than this: an already-stale answer must not loop. */
const MIN_FRESH_MS = 5_000;
/** How long an answer with no `expiresAt` is trusted. */
const UNDATED_FRESH_MS = 5 * 60_000;

/**
 * The pod path that signs `ref`, or null when it names nothing. A document is
 * signed for the entity that holds it (`?entityId=`), so a reader of a
 * pod-wide entity's declared media is authorised by that entity, and the pod
 * checks one row instead of searching for a holder.
 */
export function signingPath(
  ref: StoredMediaRef,
  viaEntityId?: string | null
): string | null {
  if (ref.documentId) {
    const base = `/api/files/documents/${encodeURIComponent(ref.documentId)}/url`;
    return viaEntityId
      ? `${base}?entityId=${encodeURIComponent(viaEntityId)}`
      : base;
  }
  if (ref.entityId) return `/api/files/${encodeURIComponent(ref.entityId)}/url`;
  return null;
}

function bareMime(mime: string | null | undefined): string {
  return mime?.split(";")[0]?.trim().toLowerCase() ?? "";
}

/** True only for the raster types an `<img>` may ever load. */
export function isInlineImage(mime: string | null | undefined): boolean {
  const type = bareMime(mime);
  return (
    !!type && (INLINE_IMAGE_MIME_TYPES as readonly string[]).includes(type)
  );
}

/** The element a mime may ever reach: one of three allowlists, or none. */
export type InlineMediaKind = "image" | "video" | "audio";

export function inlineMediaKind(
  mime: string | null | undefined
): InlineMediaKind | null {
  const type = bareMime(mime);
  if (!type) return null;
  if ((INLINE_IMAGE_MIME_TYPES as readonly string[]).includes(type))
    return "image";
  if ((INLINE_VIDEO_MIME_TYPES as readonly string[]).includes(type))
    return "video";
  if ((INLINE_AUDIO_MIME_TYPES as readonly string[]).includes(type))
    return "audio";
  return null;
}

/** What one signing answered. */
export interface SignedMedia {
  url: string;
  expiresAt: string | null;
  /** The type the pod signed (what the storage origin will serve). */
  mimeType: string | null;
}

/** A signing the pod refused or could not answer; `status` 0 = no answer. */
export class MediaSignError extends Error {
  constructor(readonly status: number) {
    super(`Signing a stored file failed (${status || "no answer"})`);
    this.name = "MediaSignError";
  }
}

/**
 * The door's JSON → a signed URL. Anything but an http(s) URL is refused (a
 * failure, not an image): whatever the answer says goes into `src`/`href`.
 */
export function parseSigned(body: unknown): SignedMedia {
  const row = (body ?? {}) as Record<string, unknown>;
  const url = typeof row.url === "string" ? row.url : "";
  if (!/^https?:\/\//i.test(url)) throw new MediaSignError(0);
  return {
    url,
    expiresAt: typeof row.expiresAt === "string" ? row.expiresAt : null,
    mimeType:
      typeof row.mimeType === "string" && row.mimeType.trim()
        ? row.mimeType
        : null,
  };
}

/** How long a signed URL may be handed out before it is re-signed. */
export function freshFor(
  expiresAt: string | null | undefined,
  now: number = Date.now()
): number {
  if (!expiresAt) return UNDATED_FRESH_MS;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return UNDATED_FRESH_MS;
  return Math.max(MIN_FRESH_MS, at - now - EXPIRY_SKEW_MS);
}

/**
 * Why a stored file is not shown, in the reader's words. `kind` names what it
 * is when that is known (an image when it is not).
 */
export function signFailureMessage(
  error: unknown,
  kind: InlineMediaKind = "image"
): string {
  const status = error instanceof MediaSignError ? error.status : -1;
  const sees = kind === "image" ? "see" : "play";
  switch (status) {
    case 401:
      return `Sign in again to ${sees} this ${kind}.`;
    case 403:
      return `This ${kind} isn’t visible to you.`;
    case 404:
      return `This ${kind} is no longer stored.`;
    default:
      return `The ${kind} couldn’t be loaded.`;
  }
}

/** A failure the reader can fix by asking again (not a refusal or a gone file). */
export function isRetryable(error: unknown): boolean {
  const status = error instanceof MediaSignError ? error.status : -1;
  return status !== 403 && status !== 404;
}

/** The signing as the view reads it. */
export interface SignState {
  status: "loading" | "ready" | "error";
  data?: SignedMedia;
  error?: unknown;
}

/** What the reader is shown. */
export type ImageDraw =
  /** No media: the caller's section omits itself. */
  | { state: "none" }
  /** Not held by the pod: a link out, never loaded. */
  | { state: "external"; href: string }
  | { state: "loading" }
  | {
      state: "failed";
      message: string;
      retryable: boolean;
      /** A signed file the browser could not play: still the reader's to take. */
      downloadHref?: string;
    }
  /** Held by the pod but not playable or drawable inline: download it. */
  | { state: "file"; href: string | null; mime: string | null }
  | { state: "image"; src: string }
  /** Played in a `<video>`; `src` is the pod's signed URL. */
  | { state: "video"; src: string }
  /** Played in an `<audio>`; `src` is the pod's signed URL. */
  | { state: "audio"; src: string };

/**
 * `media` + its signing → the one thing to draw. A ref whose own mime is
 * already not drawable is a file before the pod answers; one with no mime is
 * decided on the type the pod SIGNED, and an unnamed type is a file.
 */
export function imageDraw(
  media: MediaRef,
  sign: SignState | null,
  { podConfigured = true }: { podConfigured?: boolean } = {}
): ImageDraw {
  if (media.via === "none") return { state: "none" };
  if (media.via === "external") {
    return /^https?:\/\//i.test(media.url)
      ? { state: "external", href: media.url }
      : { state: "none" };
  }
  if (!signingPath(media)) return { state: "none" };
  if (!podConfigured) {
    return {
      state: "failed",
      message: "This console can’t reach the pod’s files.",
      retryable: false,
    };
  }
  const ownMime = media.mime ?? null;
  const knownFile = ownMime !== null && inlineMediaKind(ownMime) === null;
  if (!sign || sign.status === "loading") {
    return knownFile
      ? { state: "file", href: null, mime: ownMime }
      : { state: "loading" };
  }
  if (sign.status === "error" || !sign.data) {
    return {
      state: "failed",
      message: signFailureMessage(
        sign.error,
        inlineMediaKind(ownMime) ?? "image"
      ),
      retryable: isRetryable(sign.error),
    };
  }
  // The type the pod SIGNED decides (what the storage origin will serve); a
  // reference's own claim only fills in when the pod named none.
  const mime = sign.data.mimeType ?? ownMime;
  const kind = inlineMediaKind(mime);
  return kind
    ? { state: kind, src: sign.data.url }
    : { state: "file", href: sign.data.url, mime };
}

/**
 * A signed file the browser then failed to load (the URL expired while the
 * page sat open, the storage origin did not answer, a video codec this
 * browser cannot decode) is a FAILED read too — never an empty frame.
 * `brokenSrc` is the `src` whose element errored. A video or audio file that
 * will not play keeps its `downloadHref`: asking again may help (an expired
 * URL), and if it does not the reader can still take the file.
 */
export function withLoadFailure(
  draw: ImageDraw,
  brokenSrc: string | null
): ImageDraw {
  if (brokenSrc === null) return draw;
  switch (draw.state) {
    case "image":
      return draw.src === brokenSrc
        ? {
            state: "failed",
            message: "The image couldn’t be loaded.",
            retryable: true,
          }
        : draw;
    case "video":
    case "audio":
      return draw.src === brokenSrc
        ? {
            state: "failed",
            message: `This ${draw.state} couldn’t be played here.`,
            retryable: true,
            downloadHref: draw.src,
          }
        : draw;
    default:
      return draw;
  }
}

/**
 * A stored document's own media: an image, video or audio file is drawn
 * through the door, signed on the document's own floor; anything else is not
 * media. The type is only a first guess: the door decides on what the pod
 * signs.
 */
export function documentFileMedia(
  documentId: string,
  mimeType: string | null | undefined
): MediaRef | null {
  const mime = bareMime(mimeType);
  return /^(image|video|audio)\//.test(mime)
    ? { via: "stored", documentId, mime }
    : null;
}

/** "PNG image", "SVG image", "PDF" — the kind of file, for a chip. */
export function fileTypeLabel(mime: string | null | undefined): string {
  const type = mime?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!type) return "File";
  const [major, minor = ""] = type.split("/");
  const sub = minor.replace(/^(x-|vnd\.)/, "").split("+")[0] ?? "";
  if (major === "image") return `${sub.toUpperCase()} image`;
  if (major === "video") return `${sub.toUpperCase()} video`;
  if (major === "audio") return `${sub.toUpperCase()} audio`;
  return sub ? sub.toUpperCase() : "File";
}

/**
 * What an image is called to someone who cannot see it: its record's title,
 * else the file's own name (a `brand-asset` keeps it as `fileName`), else
 * empty (the view says "Image").
 */
export function mediaAlt(
  title: unknown,
  properties: Readonly<Record<string, unknown>> | null | undefined
): string {
  const named = typeof title === "string" ? title.trim() : "";
  if (named) return named;
  const file = properties?.fileName;
  return typeof file === "string" ? file.trim() : "";
}
