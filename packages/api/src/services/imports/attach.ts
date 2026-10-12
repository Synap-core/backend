/**
 * ATTACH — give Build the bytes of an item the pod must not scrape
 * (`needs_file`: an Instagram reel, a TikTok) or any staged item the person
 * has the file for.
 *
 * The bytes live on their OWN document (inline upload through
 * `stageSourceBlob`, or a document the presigned lane stored), stamped with
 * the import's staged marker so no list shows it; the item records it as
 * `importItem.source.documentId` and becomes `contentStatus: "file"`.
 */

import { createHash } from "crypto";
import { TRPCError } from "@trpc/server";
import { db as defaultDb, documents, and, eq, isNull } from "@synap/database";
import {
  IMPORT_LIMITS,
  IMPORT_STAGED_MARKER,
  type ImportItemMetadata,
  type ImportItemView,
} from "@synap-core/types/imports";
import {
  INTAKE_SOURCE_METADATA_KEY,
  type IntakeSourceMetadata,
} from "../intake/stage-intake-source.js";
import { stageSourceBlob } from "../../utils/store-entity-source-blob.js";
import {
  IMPORT_ITEM_KEY,
  importItemsWhere,
  readItemMetadata,
  toItemView,
} from "./read-model.js";
import { IMPORT_COLLECT_DOOR } from "./stage.js";
import {
  assertImportOpen,
  loadImportSession,
  type ImportDb,
} from "./session.js";

/** `documents.metadata.importAttachmentOf` — the item a file was attached to. */
export const IMPORT_ATTACHMENT_KEY = "importAttachmentOf";

export async function attachImportItemFile(args: {
  database?: ImportDb;
  userId: string;
  sessionId: string;
  itemId: string;
  filename: string;
  mimeType: string;
  documentId?: string;
  contentBase64?: string;
}): Promise<ImportItemView> {
  const database = args.database ?? defaultDb;
  const session = await loadImportSession({
    database,
    userId: args.userId,
    sessionId: args.sessionId,
  });
  assertImportOpen(session);
  const [itemRow] = await database
    .select({
      id: documents.id,
      metadata: documents.metadata,
      createdAt: documents.createdAt,
    })
    .from(documents)
    .where(
      and(
        importItemsWhere(args.userId, session.id),
        eq(documents.id, args.itemId)
      )
    )
    .limit(1);
  const meta = itemRow ? readItemMetadata(itemRow.metadata) : null;
  if (!itemRow || !meta) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Item not found" });
  }
  const sourceBase = (contentHash: string): IntakeSourceMetadata => ({
    version: 1,
    kind: "file",
    contentHash,
    sessionId: session.id,
    door: IMPORT_COLLECT_DOOR,
    filename: args.filename,
    mimeType: args.mimeType,
    pending: IMPORT_STAGED_MARKER,
  });

  let fileDocumentId: string;
  let sizeBytes: number;
  if (args.documentId) {
    const [doc] = await database
      .select({
        id: documents.id,
        metadata: documents.metadata,
        size: documents.size,
        storageKey: documents.storageKey,
        mimeType: documents.mimeType,
      })
      .from(documents)
      .where(
        and(
          eq(documents.id, args.documentId),
          eq(documents.userId, args.userId),
          isNull(documents.deletedAt)
        )
      )
      .limit(1);
    if (!doc?.storageKey) {
      throw new TRPCError({ code: "NOT_FOUND", message: "File not found" });
    }
    const docMeta = (doc.metadata ?? {}) as Record<string, unknown>;
    const owner = docMeta[INTAKE_SOURCE_METADATA_KEY] as
      IntakeSourceMetadata | undefined;
    if (owner && owner.sessionId !== session.id) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "That file already belongs to another import.",
      });
    }
    await database
      .update(documents)
      .set({
        metadata: {
          ...docMeta,
          [INTAKE_SOURCE_METADATA_KEY]: sourceBase(
            createHash("sha256").update(`file\0${doc.storageKey}`).digest("hex")
          ),
          [IMPORT_ATTACHMENT_KEY]: itemRow.id,
        },
      })
      .where(eq(documents.id, doc.id));
    fileDocumentId = doc.id;
    sizeBytes = doc.size;
  } else if (args.contentBase64) {
    const buffer = Buffer.from(args.contentBase64, "base64");
    if (buffer.length === 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "The file is empty.",
      });
    }
    if (buffer.length > IMPORT_LIMITS.inlineFileBytesMax) {
      throw new TRPCError({
        code: "PAYLOAD_TOO_LARGE",
        message: "That file is too large to send inline — upload it first.",
      });
    }
    const contentHash = createHash("sha256").update(buffer).digest("hex");
    const staged = await stageSourceBlob({
      database,
      userId: args.userId,
      buffer,
      mimeType: args.mimeType,
      filename: args.filename,
      workspaceId: session.workspaceId,
      keyScope: `import-${contentHash.slice(0, 16)}`,
      metadata: {
        [INTAKE_SOURCE_METADATA_KEY]: sourceBase(contentHash),
        [IMPORT_ATTACHMENT_KEY]: itemRow.id,
      },
    });
    fileDocumentId = staged.documentId;
    sizeBytes = buffer.length;
  } else {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Send the file inline or the id of an uploaded document.",
    });
  }

  const next: ImportItemMetadata = {
    ...meta,
    source: {
      ...meta.source,
      filename: args.filename,
      mimeType: args.mimeType,
      sizeBytes,
      documentId: fileDocumentId,
    },
    contentStatus: "file",
  };
  const metadata = {
    ...((itemRow.metadata ?? {}) as Record<string, unknown>),
    [IMPORT_ITEM_KEY]: next,
  };
  await database
    .update(documents)
    .set({ metadata })
    .where(
      and(eq(documents.id, itemRow.id), eq(documents.userId, args.userId))
    );
  return toItemView({
    id: itemRow.id,
    metadata,
    createdAt: itemRow.createdAt,
  })!;
}
