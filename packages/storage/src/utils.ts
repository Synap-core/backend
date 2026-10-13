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
