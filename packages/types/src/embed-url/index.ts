/**
 * classifyEmbedUrl — the ONE rule that decides whether a URL may be rendered
 * as a website embed (an `iframe-embed` cell), shared by the server and the
 * apps.
 *
 * The same code (from `export type EmbedUrlRefusal` down, formatted here) as
 * synap-app `packages/web/src/bento-view/components/widgets/embed-url.ts`,
 * where the browser applies it on WRITE (the placer) and on RENDER
 * (`IframeEmbedWidget`). The server applies it on WRITE in the whiteboard
 * place door (`placeOnBoard`): an agent's url embed never reaches a board
 * without it. Until synap-app imports it from here, the two copies are pinned
 * equal by `packages/api/src/__tripwires__/embed-url-parity.tripwire.test.ts`
 * (same verdict on a URL corpus). Keep it pure: it is the security boundary.
 *
 * ── The rules ─────────────────────────────────────────────────────────────
 * 1. Only `https:` becomes a website. `javascript:`, `data:`, `file:`, `blob:`
 *    and anything else are refused; `http:` too (the cell renders with scripts
 *    enabled; a plaintext page is a page any network hop can rewrite).
 * 2. A STORED FILE is never a website: an S3/R2/MinIO SigV4 presigned query
 *    (`X-Amz-Signature`, `X-Amz-Credential`, `X-Amz-Security-Token`) or the
 *    pod's own `/api/files/...` path. Shown as a file, never in an iframe.
 * 3. The pod's own origin is never embedded (it would run with the user's pod
 *    session).
 */

export type EmbedUrlRefusal =
  /** Not parseable as an absolute URL. */
  | "invalid"
  /** A scheme that can never be a website (`javascript:`, `data:`, `file:`, `blob:`, …). */
  | "scheme"
  /** `http:` — embeddable only over https. */
  | "insecure"
  /** A page on the pod's own origin. */
  | "own-pod";

export type EmbedUrlClass =
  | { kind: "website"; url: string }
  | { kind: "stored-file"; url: string }
  | { kind: "refused"; reason: EmbedUrlRefusal; url: string };

export interface ClassifyEmbedUrlOptions {
  /** The connected pod's base URL (any path is ignored; only its origin counts). */
  podUrl?: string | null;
}

const SIGNED_STORAGE_PARAMS = [
  "x-amz-signature",
  "x-amz-credential",
  "x-amz-security-token",
];

function originOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function isStoredFileUrl(url: URL): boolean {
  for (const key of url.searchParams.keys()) {
    if (SIGNED_STORAGE_PARAMS.includes(key.toLowerCase())) return true;
  }
  return /^\/api\/(pod\/)?files(\/|$)/.test(url.pathname);
}

export function classifyEmbedUrl(
  raw: string,
  options: ClassifyEmbedUrlOptions = {}
): EmbedUrlClass {
  const value = raw.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { kind: "refused", reason: "invalid", url: value };
  }

  if (url.protocol === "http:" || url.protocol === "https:") {
    // A stored file is checked BEFORE the scheme verdict: an http storage
    // endpoint (local MinIO) is still a stored file, not merely "insecure".
    if (isStoredFileUrl(url)) return { kind: "stored-file", url: url.href };
    if (url.protocol === "http:") {
      return { kind: "refused", reason: "insecure", url: url.href };
    }
    const podOrigin = originOf(options.podUrl);
    if (podOrigin && url.origin === podOrigin) {
      return { kind: "refused", reason: "own-pod", url: url.href };
    }
    return { kind: "website", url: url.href };
  }

  return { kind: "refused", reason: "scheme", url: value };
}

/** One sentence per refusal, for the feedback a user sees. */
export function embedUrlRefusalMessage(result: EmbedUrlClass): string | null {
  if (result.kind === "website") return null;
  if (result.kind === "stored-file") {
    return "Stored files can't be embedded as a website. Drop the file itself or add it from its library.";
  }
  switch (result.reason) {
    case "invalid":
      return "That isn't a web address.";
    case "scheme":
      return "Only https:// web pages can be embedded.";
    case "insecure":
      return "Only secure (https://) pages can be embedded.";
    case "own-pod":
      return "Pages from your own pod can't be embedded as a website.";
  }
}

/**
 * Thrown by the placer when a `url` resource is not a website. Carries the
 * classification so a caller can tell a refusal from a failed write.
 */
export class EmbedUrlRefusedError extends Error {
  readonly classification: Exclude<EmbedUrlClass, { kind: "website" }>;
  constructor(classification: Exclude<EmbedUrlClass, { kind: "website" }>) {
    super(
      embedUrlRefusalMessage(classification) ??
        "This address can't be embedded."
    );
    this.name = "EmbedUrlRefusedError";
    this.classification = classification;
  }
}
