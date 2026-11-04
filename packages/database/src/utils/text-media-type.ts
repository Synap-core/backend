/**
 * Whether stored bytes of this media type are TEXT (markdown, html, json,
 * any `text/*`). THE rule for "may a reader decode these bytes as text":
 * the version preview (`documentVersionContentPreview`), the search body
 * loader (`loadDocumentBodyTexts`, checked BEFORE the download) and the
 * document read (`readOmitsStoredBody`, api `read-document.ts`). No media
 * type = not text.
 */
export function isTextMediaType(mimeType?: string | null): boolean {
  const mime = mimeType || "";
  return (
    mime.startsWith("text/") ||
    mime.includes("json") ||
    mime.includes("html") ||
    mime.includes("markdown")
  );
}
