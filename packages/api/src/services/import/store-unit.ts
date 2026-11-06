/**
 * ONE store-first import unit: an entity (title, body, properties) plus an
 * optional source file attached as its provenance.
 *
 * Two doors reach it, and this is the only implementation either has:
 *   - `POST /import/store-unit` (multipart, one unit per request): the file
 *     arrives as BYTES in the request;
 *   - the `import-units` background job (`POST /import/enqueue-units`): the
 *     file was PUT straight to storage through a presigned URL
 *     (`POST /import/unit-uploads`), so it arrives as an upload token.
 *
 * Governance is per unit and identical on both: the entity is created through
 * the caller's hub `entities.createEntity` (the governed create door, passed in
 * so the door keeps its own caller), and the file is attached through
 * `gateAndAttachStagedSourceBlob` (the `entity.update` gate, then attach). A
 * create the ladder parks returns the proposal receipt and attaches nothing.
 */

import { randomUUID } from "crypto";
import {
  db,
  documents,
  eq,
  EntityBodyService,
  eventRepository,
} from "@synap/database";
import { storage } from "@synap/storage";
import type { HUB_WRITE_SOURCES } from "@synap-core/types/proposals";
import { createLogger } from "@synap-core/core";
import {
  stageSourceBlob,
  gateAndAttachStagedSourceBlob,
  SourceBlobTooLargeError,
  SourceBlobEmptyError,
  type StagedSourceBlob,
} from "../../utils/store-entity-source-blob.js";
import {
  isAllowedMimeType,
  maxUploadBytesForMimeType,
} from "../../routers/file-upload.js";
import {
  parseImportUnitUploadKey,
  isNotFound,
} from "../../routers/file-upload-presign.js";

const logger = createLogger({ module: "import-store-unit" });

type HubWriteSource = (typeof HUB_WRITE_SOURCES)[number];

/** What the create door receives — the hub `entities.createEntity` input. */
export interface ImportUnitCreateInput {
  userId: string;
  profileSlug: string;
  title: string;
  description?: string;
  content?: string;
  properties: Record<string, unknown>;
  workspaceId?: string;
  source: HubWriteSource;
  idempotencyKey?: string;
}

export interface ImportUnit {
  title: string;
  profileSlug: string;
  content?: string;
  description?: string;
  properties: Record<string, unknown>;
  source: HubWriteSource;
  /** Explicit pin; omit for a pod-wide kind (entityScope decides placement). */
  workspaceId?: string | null;
  /**
   * The caller's stable id for this unit. Becomes the create door's
   * `idempotencyKey`, so a unit submitted twice lands on ONE entity.
   */
  idempotencyKey?: string;
}

/** The unit's source file: bytes in the request, or an object already PUT. */
export type ImportUnitFile =
  | { kind: "bytes"; buffer: Buffer; mimeType: string; filename: string }
  | { kind: "upload"; uploadToken: string };

export interface ImportUnitAudio {
  documentId: string;
  storageKey: string;
  size: number;
  mimeType: string;
}

export type StoreImportUnitResult =
  | {
      status: "stored";
      entityId: string;
      profileSlug: string;
      title: string;
      audio: ImportUnitAudio | null;
      audioSkippedReason: string | null;
    }
  | {
      status: "proposed";
      message: string;
      proposalId?: string;
      proposalType?: string;
      reviewUrl?: string;
      profileSlug: string;
      title: string;
      audio: null;
      audioSkippedReason: string | null;
    };

/** An upload token the job cannot adopt. `reason` is the unit's skip reason. */
export class ImportUploadRefusedError extends Error {
  constructor(
    readonly reason:
      | "upload_not_yours"
      | "upload_missing"
      | "upload_already_used"
      | "mime_not_allowed",
    message: string
  ) {
    super(message);
    this.name = "ImportUploadRefusedError";
  }
}

/**
 * Adopt an object a client PUT through `POST /import/unit-uploads` as a STAGED
 * source blob: verify it is the caller's, that it landed, and that its real
 * size and type are allowed, then write its `documents` row through the
 * canonical stored-object door (`EntityBodyService`, the presigned finalize's
 * own writer). Touches no entity: the attach gate does that.
 */
export async function stageImportUnitUpload(input: {
  userId: string;
  uploadToken: string;
  workspaceId?: string | null;
  agentUserId?: string | null;
}): Promise<StagedSourceBlob> {
  const { userId, uploadToken } = input;
  const parsed = parseImportUnitUploadKey(uploadToken);
  if (!parsed || parsed.userId !== userId) {
    throw new ImportUploadRefusedError(
      "upload_not_yours",
      "uploadToken is not an import upload of this user"
    );
  }
  // One object never backs two documents: deleting one would delete the
  // other's bytes.
  const [existing] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(eq(documents.storageKey, uploadToken))
    .limit(1);
  if (existing) {
    throw new ImportUploadRefusedError(
      "upload_already_used",
      "This upload is already stored"
    );
  }

  let info: { size: number; contentType: string };
  try {
    info = await storage.getMetadata(uploadToken);
  } catch (err) {
    if (isNotFound(err)) {
      throw new ImportUploadRefusedError(
        "upload_missing",
        "No uploaded object for this token: the PUT never landed"
      );
    }
    throw err;
  }
  const mimeType = info.contentType;
  const discard = () =>
    storage.delete(uploadToken).catch((err: unknown) => {
      logger.warn({ err, key: uploadToken }, "Failed to delete refused upload");
    });
  if (!isAllowedMimeType(mimeType)) {
    await discard();
    throw new ImportUploadRefusedError(
      "mime_not_allowed",
      `MIME type not allowed: ${mimeType}`
    );
  }
  if (info.size <= 0) {
    await discard();
    throw new SourceBlobEmptyError();
  }
  const maxBytes = maxUploadBytesForMimeType(mimeType);
  if (info.size > maxBytes) {
    await discard();
    throw new SourceBlobTooLargeError(info.size, maxBytes);
  }

  const body = await new EntityBodyService(db, eventRepository).setBody({
    // Stored-object mode writes no entity body: the id only satisfies the
    // shared signature (the presigned finalize passes a fresh one too).
    entityId: randomUUID(),
    userId,
    workspaceId: input.workspaceId ?? null,
    title: parsed.filename,
    storedObject: {
      storageKey: uploadToken,
      size: info.size,
      mimeType,
      filename: parsed.filename,
    },
    provenance: input.agentUserId
      ? { createdByKind: "ai_agent", createdByUserId: input.agentUserId }
      : { createdByKind: "human", createdByUserId: userId },
  });
  return {
    documentId: body.documentId as string,
    storageKey: uploadToken,
    storageUrl: body.storageUrl as string,
    size: info.size,
    mimeType,
    filename: parsed.filename,
  };
}

/** The skip reason a failed attach reports (the entity is kept). */
function attachSkipReason(err: unknown): string {
  if (err instanceof SourceBlobTooLargeError) return "over_limit";
  if (err instanceof SourceBlobEmptyError) return "empty";
  if (err instanceof ImportUploadRefusedError) return err.reason;
  return "storage_error";
}

/**
 * Store one unit: create the entity through `createEntity`, then attach its
 * file. Never throws for the FILE (the entity is kept and the skip is
 * reported); a create failure throws, as the door's own error.
 */
export async function storeImportUnit(args: {
  /** The governed create door of the acting caller (hub `entities.createEntity`). */
  createEntity: (input: ImportUnitCreateInput) => Promise<unknown>;
  userId: string;
  unit: ImportUnit;
  file?: ImportUnitFile;
  agentUserId?: string | null;
}): Promise<StoreImportUnitResult> {
  const { unit, userId, file } = args;
  const workspaceId = unit.workspaceId ?? undefined;

  const created = (await args.createEntity({
    userId,
    profileSlug: unit.profileSlug,
    title: unit.title,
    ...(unit.description ? { description: unit.description } : {}),
    ...(unit.content ? { content: unit.content } : {}),
    properties: unit.properties,
    ...(workspaceId ? { workspaceId } : {}),
    source: unit.source,
    ...(unit.idempotencyKey ? { idempotencyKey: unit.idempotencyKey } : {}),
  })) as {
    status?: string;
    id?: unknown;
    message?: string;
    proposalId?: string;
    proposalType?: string;
    reviewUrl?: string;
  };

  // The create door is GOVERNED: when the ladder parks the write it returns
  // `{ status: "proposed" }` and NO `id`. The file is NOT stored: there is no
  // entity to anchor it to, and staging it would leak on rejection.
  if (created.status === "proposed" || typeof created.id !== "string") {
    let audioSkippedReason: string | null = null;
    if (file?.kind === "bytes" && file.buffer.length > 0) {
      audioSkippedReason = "entity_proposed";
    } else if (file?.kind === "upload") {
      audioSkippedReason = "entity_proposed";
      // The bytes are already in storage. Only the caller's own upload is
      // deleted: a token naming another user is never touched.
      if (parseImportUnitUploadKey(file.uploadToken)?.userId === userId) {
        await storage.delete(file.uploadToken).catch((err: unknown) => {
          logger.warn(
            { err, key: file.uploadToken },
            "Failed to delete the upload of a proposed unit"
          );
        });
      }
    }
    return {
      status: "proposed",
      message: created.message ?? "Entity creation proposed for review",
      ...(created.proposalId ? { proposalId: created.proposalId } : {}),
      ...(created.proposalType ? { proposalType: created.proposalType } : {}),
      ...(created.reviewUrl ? { reviewUrl: created.reviewUrl } : {}),
      profileSlug: unit.profileSlug,
      title: unit.title,
      audio: null,
      audioSkippedReason,
    };
  }

  const entityId = created.id;
  let audio: ImportUnitAudio | null = null;
  let audioSkippedReason: string | null = null;

  const hasFile =
    file?.kind === "upload" || (file?.kind === "bytes" && file.buffer.length);
  if (file && hasFile) {
    try {
      const staged =
        file.kind === "bytes"
          ? await stageSourceBlob({
              database: db,
              userId,
              buffer: file.buffer,
              mimeType: file.mimeType,
              filename: file.filename,
              workspaceId: workspaceId ?? null,
              keyScope: entityId,
            })
          : await stageImportUnitUpload({
              userId,
              uploadToken: file.uploadToken,
              workspaceId: workspaceId ?? null,
              agentUserId: args.agentUserId ?? null,
            });
      const attached = await gateAndAttachStagedSourceBlob({
        database: db,
        userId,
        entityId,
        staged,
        workspaceId: workspaceId ?? null,
      });
      if (attached.status === "proposed") {
        // Governance parked the attach. The bytes ARE staged and ride the
        // proposal, so approval attaches them.
        audioSkippedReason = "proposed";
      } else {
        audio = {
          documentId: attached.documentId,
          storageKey: attached.storageKey,
          size: attached.size,
          mimeType: attached.mimeType,
        };
      }
    } catch (err) {
      audioSkippedReason = attachSkipReason(err);
      if (audioSkippedReason === "storage_error") {
        logger.warn(
          { err, entityId, userId },
          "import unit: source file failed (entity kept)"
        );
      }
    }
  }

  return {
    status: "stored",
    entityId,
    profileSlug: unit.profileSlug,
    title: unit.title,
    audio,
    audioSkippedReason,
  };
}
