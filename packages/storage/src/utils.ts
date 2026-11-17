/**
 * Storage Utilities - Shared Functions
 *
 * Common utilities used by all storage providers to avoid code duplication.
 */

/**
 * Build standardized file path for user entities
 *
 * Creates a consistent path structure: `users/{userId}/{entityType}s/{entityId}.{extension}`
 *
 * @param userId - User ID
 * @param entityType - Entity type (e.g., "note", "task", "project")
 * @param entityId - Entity ID (UUID)
 * @param extension - File extension (default: "md")
 * @returns Standardized storage path
 *
 * @example
 * ```typescript
 * const path = buildEntityPath('user-123', 'note', 'entity-456', 'md');
 * // Returns: "users/user-123/notes/entity-456.md"
 * ```
 */
export function buildEntityPath(
  userId: string,
  entityType: string,
  entityId: string,
  extension: string = "md"
): string {
  // Validate inputs
  if (!userId || !entityType || !entityId) {
    throw new Error("userId, entityType, and entityId are required");
  }

  // Sanitize extension (remove leading dot if present)
  const cleanExtension = extension.startsWith(".")
    ? extension.slice(1)
    : extension;

  return `users/${userId}/${entityType}s/${entityId}.${cleanExtension}`;
}

/**
 * The `Content-Disposition` every signed GET carries:
 * `attachment; filename*=UTF-8''<RFC 5987-encoded basename of the key>`.
 *
 * Blobs are served on the POD origin (`/synap-storage/*`), the same origin as
 * the session cookie, and stored as-is — including active types (HTML, SVG,
 * XML). `attachment` makes a top-level navigation to a signed URL download the
 * bytes instead of rendering them there; `<img>` / `<video>` / `<audio>`
 * subresources ignore the header, so embedding is unaffected. Viewing an
 * active type is the sandboxed viewer's job, never the URL's.
 */
export function attachmentDisposition(key: string): string {
  const name = key.split("/").pop() || "file";
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename*=UTF-8''${encoded}`;
}

/**
 * Stored types a page RUNS or APPLIES when it includes them: every JavaScript
 * MIME type essence (WHATWG MIME Sniffing, "JavaScript MIME type") and CSS.
 * `attachment` does not help here: a `<script src>` / `<link rel=stylesheet>`
 * subresource ignores the disposition, and a blob served on the pod origin
 * passes a `script-src 'self'` policy. So a signed GET serves these as plain
 * text; with `nosniff` (Caddy's `security_headers`, on every site block) the
 * browser then refuses to run or apply them (ticket 15bc541d, plan D1).
 */
const SCRIPT_OR_STYLE_MIME_TYPES: ReadonlySet<string> = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "text/jscript",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript",
  "text/css",
]);

/** What a script or style blob is served as. */
export const INERT_TEXT_CONTENT_TYPE = "text/plain; charset=utf-8";

/**
 * The `Content-Type` a signed GET serves instead of the stored one, or
 * `undefined` to serve the stored type unchanged. Only script and style types
 * are overridden ({@link SCRIPT_OR_STYLE_MIME_TYPES}); parameters and case are
 * ignored (`Text/JavaScript; charset=utf-8` is JavaScript).
 */
export function servedContentTypeOverride(
  storedContentType: string | null
): string | undefined {
  const essence = (storedContentType ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  return SCRIPT_OR_STYLE_MIME_TYPES.has(essence)
    ? INERT_TEXT_CONTENT_TYPE
    : undefined;
}
