import { storage } from "@synap/storage";
import type { FileMetadata } from "@synap/storage";
import type {
  NewDocumentVersion,
  DocumentVersion,
} from "../schema/documents.js";

const TEXT_PREVIEW_LIMIT = 64_000;

export interface DocumentVersionStorageInput {
  userId: string;
  documentId: string;
  versionId: string;
  documentType?: string | null;
  mimeType?: string | null;
  content: string | Buffer;
  /**
   * Text already extracted from `content` upstream (PDF/DOCX/image OCR/audio
   * transcript — the IS `/api/structure` extraction pass).
   *
   * `documentVersionContentPreview` returns "" for any Buffer whose mime is not
   * text-ish, and that is DELIBERATE: it must never stuff binary bytes into a
   * text column. So the fix for "binaries have an empty `document_versions
   * .content`" is to HAND IT TEXT, not to teach the gate to read binaries. When
   * this is set it becomes the persisted preview; the uploaded object is still
   * the ORIGINAL `content` bytes, untouched.
   *
   * Three consumers key off that column and see nothing without it: the entity
   * embedding worker (`jobs/workers/entity-embedding.ts`), the retrieval body
   * join (`api/services/retrieval/retrieve.ts`), and Typesense enrichment.
   */
  extractedText?: string;
}

export interface StoredDocumentVersionSnapshot {
  storageUrl: string;
  storageKey: string;
  size: number;
  mimeType: string;
  checksum: string;
  contentPreview: string;
  metadata: FileMetadata;
}

export function documentVersionExtension(
  documentType?: string | null,
  mimeType?: string | null
): string {
  const type = documentType || "";
  if (type === "markdown") return "md";
  if (type === "html") return "html";
  if (type === "code") return "txt";
  if (type === "text") return "txt";
  if (type === "whiteboard") return "json";
  if (type === "pdf") return "pdf";
  if (type === "docx") return "docx";

  const mime = mimeType || "";
  if (mime.includes("html")) return "html";
  if (mime.includes("markdown")) return "md";
  if (mime.startsWith("text/")) return "txt";
  if (mime.includes("json")) return "json";
  if (mime.includes("pdf")) return "pdf";
  if (mime.includes("wordprocessingml")) return "docx";
  if (mime.startsWith("image/")) return mime.split("/")[1] || "img";
  if (mime.startsWith("video/")) return mime.split("/")[1] || "video";
  if (mime.startsWith("audio/")) return mime.split("/")[1] || "audio";

  return "bin";
}

export function documentVersionStorageKey(input: {
  userId: string;
  documentId: string;
  versionId: string;
  extension: string;
}): string {
  return storage.buildPath(
    input.userId,
    "document-version",
    `${input.documentId}/${input.versionId}`,
    input.extension
  );
}

export function documentVersionContentPreview(
  content: string | Buffer,
  mimeType?: string | null
): string {
  if (Buffer.isBuffer(content)) {
    const mime = mimeType || "";
    if (
      mime.startsWith("text/") ||
      mime.includes("json") ||
      mime.includes("html") ||
      mime.includes("markdown")
    ) {
      return content.toString("utf-8", 0, TEXT_PREVIEW_LIMIT);
    }
    return "";
  }
  return content.slice(0, TEXT_PREVIEW_LIMIT);
}

export async function uploadDocumentVersionSnapshot(
  input: DocumentVersionStorageInput
): Promise<StoredDocumentVersionSnapshot> {
  const mimeType = input.mimeType || "application/octet-stream";
  const extension = documentVersionExtension(input.documentType, mimeType);
  const key = documentVersionStorageKey({
    userId: input.userId,
    documentId: input.documentId,
    versionId: input.versionId,
    extension,
  });
  const metadata = await storage.upload(key, input.content, {
    contentType: mimeType,
    metadata: {
      documentId: input.documentId,
      versionId: input.versionId,
    },
  });

  return {
    storageUrl: metadata.url,
    storageKey: metadata.path,
    size: metadata.size,
    mimeType,
    checksum: metadata.checksum,
    contentPreview:
      input.extractedText !== undefined
        ? input.extractedText.slice(0, TEXT_PREVIEW_LIMIT)
        : documentVersionContentPreview(input.content, mimeType),
    metadata,
  };
}

/**
 * Build a version snapshot for bytes the caller ALREADY uploaded.
 *
 * The source-blob door (`stageSourceBlob`) uploads the original media itself and
 * deliberately skips `uploadDocumentVersionSnapshot` so a 25MB WAV is not stored
 * twice. It still needs a v1 `document_versions` row — without one, a document
 * whose `currentVersion` is 1 has NO matching version, and the retrieval join
 * (`documentVersions.version = documents.currentVersion`) finds nothing at all.
 *
 * Lives here, beside `storedVersionValues`, so the row a pre-uploaded blob
 * writes and the row an uploading caller writes are built by the same code.
 */
export function documentVersionSnapshotFromUpload(input: {
  metadata: FileMetadata;
  mimeType: string;
  /** Persisted as `document_versions.content`; see `extractedText` above. */
  extractedText?: string;
}): StoredDocumentVersionSnapshot {
  return {
    storageUrl: input.metadata.url,
    storageKey: input.metadata.path,
    size: input.metadata.size,
    mimeType: input.mimeType,
    checksum: input.metadata.checksum,
    contentPreview: (input.extractedText ?? "").slice(0, TEXT_PREVIEW_LIMIT),
    metadata: input.metadata,
  };
}

export function storedVersionValues(
  snapshot: StoredDocumentVersionSnapshot
): Pick<
  NewDocumentVersion,
  "content" | "storageUrl" | "storageKey" | "size" | "mimeType" | "checksum"
> {
  return {
    content: snapshot.contentPreview,
    storageUrl: snapshot.storageUrl,
    storageKey: snapshot.storageKey,
    size: snapshot.size,
    mimeType: snapshot.mimeType,
    checksum: snapshot.checksum,
  };
}

export async function readDocumentVersionContent(
  version: Pick<DocumentVersion, "storageKey" | "content" | "mimeType">
): Promise<string> {
  if (version.storageKey) {
    const buffer = await storage.downloadBuffer(version.storageKey);
    return buffer.toString("utf-8");
  }
  return version.content;
}

export async function readDocumentVersionBuffer(
  version: Pick<DocumentVersion, "storageKey" | "content" | "mimeType">
): Promise<Buffer> {
  if (version.storageKey) {
    return storage.downloadBuffer(version.storageKey);
  }
  return Buffer.from(version.content, "utf-8");
}
