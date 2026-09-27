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
