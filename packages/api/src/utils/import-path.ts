/**
 * Import path utilities
 *
 * Reusable helpers for sanitizing and validating file paths used in import batches.
 * Prevents path traversal and enforces safe character set and length.
 */

const MAX_PATH_LENGTH = 512;

/**
 * Sanitize a relative file path for use in storage keys.
 * - Removes leading slashes and dots
 * - Replaces path separators with single forward slash
 * - Truncates to max length
 * - Returns only the last path segment if the result would be empty
 *
 * @param rawPath - User-provided path (e.g. from file.name or folder/file.md)
 * @returns Sanitized path safe for use in imports/{batchId}/{path}
 */
export function sanitizeImportPath(rawPath: string): string {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    return "unnamed";
  }
  // Normalize: replace backslashes, collapse multiple slashes, trim
  let s = rawPath.replace(/\\/g, "/").replace(/\/+/g, "/").trim();
  // Remove leading . and /
  s = s.replace(/^[./]+/, "");
  // Take last segment if path looks like traversal or absolute
  if (s.startsWith("..") || s.includes("/..") || s.length > MAX_PATH_LENGTH) {
    const segments = s.split("/").filter(Boolean);
    s = segments[segments.length - 1] ?? "unnamed";
  }
  if (s.length > MAX_PATH_LENGTH) {
    s = s.slice(0, MAX_PATH_LENGTH);
  }
  // If empty or only slashes, fallback
  if (!s || s === "/") {
    return "unnamed";
  }
  // Ensure only safe chars in final segment (allow one level of path)
  const parts = s.split("/");
  const safeParts = parts.map((p) => {
    const cleaned = p.replace(/[^a-zA-Z0-9._-]/g, "_");
    return cleaned || "unnamed";
  });
  return safeParts.join("/");
}

/**
 * Infer MIME type from file path extension.
 * Used when client does not send mimeType or for validation.
 */
export function mimeFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    json: "application/json",
    md: "text/markdown",
    markdown: "text/markdown",
    csv: "text/csv",
    txt: "text/plain",
  };
  return map[ext] ?? "application/octet-stream";
}
