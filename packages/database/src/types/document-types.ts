/**
 * Document Types - Type-safe document type definitions
 *
 * Centralized type definitions for document types to ensure consistency
 * across the codebase.
 */

/**
 * Supported document types
 *
 * - text: Plain text documents
 * - markdown: Markdown formatted documents
 * - code: Code files (with language support)
 * - pdf: PDF documents
 * - docx: Microsoft Word documents
 * - html: HTML documents/widgets
 * - whiteboard: Tldraw whiteboard documents (spatial canvas)
 */
export type DocumentType =
  | "text"
  | "markdown"
  | "code"
  | "html"
  | "pdf"
  | "docx"
  | "whiteboard";

/**
 * Document type metadata structure
 *
 * Type-safe metadata for documents with type-specific fields
 */
export interface DocumentMetadata {
  /**
   * Document type (stored in metadata for backward compatibility)
   * @deprecated Use the 'type' column instead. This is kept for migration period.
   */
  type?: DocumentType;

  /**
   * Whether this is the main whiteboard for a workspace
   */
  isMainWhiteboard?: boolean;

  /**
   * Additional type-specific metadata
   */
  [key: string]: unknown;
}

/**
 * Type guard to check if a value is a valid document type
 */
export function isDocumentType(value: unknown): value is DocumentType {
  return (
    typeof value === "string" &&
    ["text", "markdown", "code", "html", "pdf", "docx", "whiteboard"].includes(
      value
    )
  );
}

/**
 * Validate and normalize document type
 *
 * @param type - Document type to validate
 * @param fallback - Fallback type if invalid (default: "text")
 * @returns Valid document type
 */
export function normalizeDocumentType(
  type: unknown,
  fallback: DocumentType = "text"
): DocumentType {
  if (isDocumentType(type)) {
    return type;
  }
  return fallback;
}
