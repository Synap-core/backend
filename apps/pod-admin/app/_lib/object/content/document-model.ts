/**
 * A `documents.get` answer (`raw`, or `readable`) → what the console draws.
 *
 * The read is ALWAYS the viewer's own floor. A document the viewer cannot
 * read (NOT_FOUND, FORBIDDEN) is `hidden`: the page keeps its title card and
 * shows no content — never a fallback to an admin door, which would show a
 * pod admin what the pod itself would not.
 */

import type { TrpcErrorLike } from "../load-failure";
import {
  contentHref,
  prepareContent,
  type ContentFormat,
  type PreparedContent,
} from "./markdown-model";

/** The slice of the `documents.get` answer this reads. */
export interface DocumentReadAnswer {
  document: {
    type?: string | null;
    storageKey?: string | null;
    storageUrl?: string | null;
    /** The stored file's type (`documents.mime_type`). */
    mimeType?: string | null;
  };
  content: string;
}

export type DocumentContent =
  /** Not visible to this viewer, or gone. */
  | { kind: "hidden" }
  /** Needs a sign-in; the page sends the reader there. */
  | { kind: "signin" }
  /**
   * A pdf, a docx, or an uploaded file whose bytes are not text (an image):
   * no readable form. `mimeType` lets a page draw an image through the media
   * door (`documentFileMedia`).
   */
  | { kind: "file"; mimeType?: string | null }
  /** A reference to an address outside the pod. */
  | { kind: "link"; href: string | null; label: string }
  | { kind: "empty" }
  | { kind: "content"; prepared: PreparedContent }
  | { kind: "error" };

/** A stored type whose bytes read as text (markdown, CSV, JSON, code). */
function isTextMime(mime: string): boolean {
  const type = mime.split(";")[0]!.trim().toLowerCase();
  return (
    type.startsWith("text/") ||
    /^application\/(json|markdown|xml|yaml|x-yaml|javascript|x-sh)$/.test(
      type
    ) ||
    /\+(json|xml)$/.test(type)
  );
}

/**
 * How a document type's body is drawn, or null for a file with no text form.
 * An uploaded `file` whose stored type is not text (a PNG, a zip) is never
 * decoded and drawn as markdown: the pod hands its bytes back as UTF-8.
 */
export function documentFormat(
  type: string | null | undefined,
  mimeType?: string | null
): ContentFormat | null {
  void isTextMime;
  switch (type) {
    case "pdf":
    case "docx":
      return null;
    case "text":
      return "text";
    case "code":
      return "code";
    // Shown as its source, never as HTML: the console has no sanitizer and
    // no CSP behind one.
    case "html":
      return "source";
    default:
      return "markdown";
  }
}

export function documentContent(
  error: TrpcErrorLike,
  answer: DocumentReadAnswer | undefined
): DocumentContent {
  if (error) {
    switch (error.data?.code) {
      case "NOT_FOUND":
      case "FORBIDDEN":
        return { kind: "hidden" };
      case "UNAUTHORIZED":
        return { kind: "signin" };
      // The readable door refuses a binary body.
      case "BAD_REQUEST":
        return { kind: "file" };
      default:
        return { kind: "error" };
    }
  }
  if (!answer) return { kind: "error" };
  const { document, content } = answer;
  const format = documentFormat(document.type, document.mimeType);
  if (format === null)
    return { kind: "file", mimeType: document.mimeType ?? null };
  if (!document.storageKey && document.storageUrl) {
    const target = contentHref(content);
    return {
      kind: "link",
      href: target.kind === "external" ? target.href : null,
      label: content.trim(),
    };
  }
  if (!content.trim()) return { kind: "empty" };
  return { kind: "content", prepared: prepareContent(content, format) };
}
