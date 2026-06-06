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
    contentPreview: documentVersionContentPreview(input.content, mimeType),
    metadata,
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
