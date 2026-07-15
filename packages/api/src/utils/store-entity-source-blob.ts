/**
 * storeEntitySourceBlob — ONE door for "attach a raw source file to an entity
 * as provenance" (capture keepRaw, Superwhisper WAV archive, future intake).
 *
 * Does NOT clobber `entity.documentId` (that may already hold extracted long-form
 * content). Instead merges:
 *   - sourceFileDocumentId
 *   - sourceFileUrl
 *   - sourceFileSize (bytes)
 *   - sourceFileMimeType
 *   - sourceFileName (optional)
 *
 * Binary provenance deliberately skips the document-version snapshot path used
 * by uploadBufferAsFileEntity (would double object-storage for large media).
 *
 * Best-effort semantics are the CALLER's choice: capture keepRaw swallows
 * errors; bulk import may surface them per unit.
 */

import { createLogger } from "@synap-core/core";
import {
  DocumentRepository,
  EntityRepository,
  eventRepository,
  type db as DbType,
} from "@synap/database";

const logger = createLogger({ module: "store-entity-source-blob" });

/** Default max for provenance blobs (audio dogfood — covers Superwhisper max ~25MB). */
export const SOURCE_BLOB_MAX_BYTES = 32 * 1024 * 1024;

export class SourceBlobTooLargeError extends Error {
  readonly code = "SOURCE_BLOB_TOO_LARGE" as const;
  constructor(
    readonly size: number,
    readonly maxBytes: number = SOURCE_BLOB_MAX_BYTES
  ) {
    super(
      `Source blob too large (${(size / 1024 / 1024).toFixed(2)}MB > max ${maxBytes / 1024 / 1024}MB)`
    );
    this.name = "SourceBlobTooLargeError";
  }
}

export class SourceBlobEmptyError extends Error {
  readonly code = "SOURCE_BLOB_EMPTY" as const;
  constructor() {
    super("Source blob is empty");
    this.name = "SourceBlobEmptyError";
  }
}

export interface StoreEntitySourceBlobInput {
  database: typeof DbType;
  userId: string;
  entityId: string;
  buffer: Buffer;
  mimeType: string;
  filename?: string;
  /** Ambient workspace for the document row only (entity may be pod-wide). */
  workspaceId?: string | null;
  /** Override size cap (tests / special doors). Default SOURCE_BLOB_MAX_BYTES. */
  maxBytes?: number;
}

export interface StoreEntitySourceBlobResult {
  documentId: string;
  storageKey: string;
  storageUrl: string;
  size: number;
  mimeType: string;
}

function extFromMime(mimeType: string): string {
  const raw = (mimeType.split("/")[1] || "bin").split(";")[0].split("+")[0];
  // audio/wav → wav; audio/mpeg → mpeg (ok); video/quicktime → quicktime
  if (raw === "mpeg" && mimeType.startsWith("audio/")) return "mp3";
  if (raw === "mp4" && mimeType.startsWith("audio/")) return "m4a";
  if (raw === "x-wav" || raw === "wave") return "wav";
  return raw || "bin";
}

/**
 * Map mime → documents.type (schema comment: text|markdown|code|pdf|docx).
 * Binary media is stored with type "text" + real mimeType column — same as
 * historical keepRaw behaviour for non-PDF blobs.
 */
function documentTypeForMime(
  mimeType: string
): "text" | "markdown" | "code" | "pdf" | "docx" {
  if (mimeType === "application/pdf") return "pdf";
  if (
    mimeType ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return "docx";
  }
  if (mimeType === "text/markdown") return "markdown";
  return "text";
}

/**
 * Upload buffer to object storage, create a documents row, and stamp provenance
 * properties on the entity.
 */
export async function storeEntitySourceBlob(
  input: StoreEntitySourceBlobInput
): Promise<StoreEntitySourceBlobResult> {
  const maxBytes = input.maxBytes ?? SOURCE_BLOB_MAX_BYTES;
  if (!input.buffer || input.buffer.length === 0) {
    throw new SourceBlobEmptyError();
  }
  if (input.buffer.length > maxBytes) {
    throw new SourceBlobTooLargeError(input.buffer.length, maxBytes);
  }

  const { storage } = await import("@synap/storage");
  const ext = extFromMime(input.mimeType);
  const key = storage.buildPath(input.userId, "entity", input.entityId, ext);
  const metadata = await storage.upload(key, input.buffer, {
    contentType: input.mimeType,
  });

  const docRepo = new DocumentRepository(input.database, eventRepository);
  const createdDocument = await docRepo.create(
    {
      title: input.filename || "Source file",
      type: documentTypeForMime(input.mimeType),
      storageUrl: metadata.url,
      storageKey: metadata.path,
      size: metadata.size,
      mimeType: input.mimeType,
      userId: input.userId,
      workspaceId: input.workspaceId ?? undefined,
    },
    input.userId
  );

  const entityRepo = new EntityRepository(input.database, eventRepository);
  await entityRepo.update(
    input.entityId,
    {
      properties: {
        sourceFileDocumentId: createdDocument.id,
        sourceFileUrl: metadata.url,
        sourceFileSize: metadata.size,
        sourceFileMimeType: input.mimeType,
        ...(input.filename ? { sourceFileName: input.filename } : {}),
      },
    },
    input.userId
  );

  logger.info(
    {
      userId: input.userId,
      entityId: input.entityId,
      documentId: createdDocument.id,
      size: metadata.size,
      mimeType: input.mimeType,
    },
    "source blob stored as entity provenance"
  );

  return {
    documentId: createdDocument.id,
    storageKey: metadata.path,
    storageUrl: metadata.url,
    size: metadata.size,
    mimeType: input.mimeType,
  };
}
