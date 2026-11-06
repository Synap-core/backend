/**
 * Presigned (large-file) upload lane — the core shared by every auth surface.
 *
 * The buffered doors (`POST /api/files/upload`, `POST /api/hub/files`) hold the
 * whole body in Node memory and sit behind the pod's 10MB request ceiling. For
 * anything bigger the client never sends the bytes to the API at all:
 *
 *   1. request  — `requestPresignedUpload` validates mime + declared size
 *                 against the per-mime cap (C4) and returns a presigned PUT URL
 *                 (Content-Type + Content-Length are SIGNED) plus an upload
 *                 token.
 *   2. PUT      — the client PUTs the bytes straight to object storage.
 *   3. finalize — `storeDocumentFromPresignedUpload` HEADs the object, re-checks
 *                 its real size/type, and writes the `documents` row through the
 *                 canonical body door (EntityBodyService stored-object mode).
 *                 The caller then creates the entity EXACTLY as its buffered
 *                 sibling does (same profileSlug/properties/governance).
 *
 * The upload token IS the storage key, and it is stateless on purpose: the key
 * embeds the workspace and the uploading user
 * (`files/<workspaceId>/uploads/<userId>/<uuid>/<name>`) and finalize refuses a
 * key that does not name the caller. One object never backs two documents
 * (deleting one would delete the other's bytes): finalize refuses a key whose
 * document is already CLAIMED (an entity references it, or a pending proposal
 * will create one), and migration 0300's partial unique index on
 * `documents.storage_key` closes the concurrent-finalize race (23505 → 409).
 *
 * Finalize is RESUMABLE. It writes the `documents` row before the caller creates
 * the entity, and that create can still fail (permission, required props). A
 * retry then finds an UNCLAIMED document on the key and reuses it instead of
 * answering 409 — so a failed create never strands a 500MB object behind a
 * "already finalized" wall.
 */

import { randomUUID } from "crypto";
import { createLogger } from "@synap-core/core";
import { storage, StorageUploadUnavailableError } from "@synap/storage";
import {
  db,
  eq,
  and,
  or,
  drizzleSql,
  documents,
  entities,
  proposals,
  eventRepository,
  EntityBodyService,
  ProfileResolutionService,
  isUniqueViolation,
} from "@synap/database";
import {
  isAllowedMimeType,
  maxUploadBytesForMimeType,
  type StoredDocument,
} from "./file-upload.js";

const logger = createLogger({ module: "file-upload-presign" });

/** Seconds a presigned PUT URL stays valid. */
export const PRESIGNED_UPLOAD_TTL_SECONDS = 900;

/** A refusal every door maps 1:1 onto its HTTP response. */
export interface PresignRefusal {
  ok: false;
  status: 400 | 403 | 404 | 409 | 413 | 415 | 501;
  code: string;
  error: string;
}

const refuse = (
  status: PresignRefusal["status"],
  code: string,
  error: string
): PresignRefusal => ({ ok: false, status, code, error });

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// Both request doors require a workspace, so a key always names one.
const KEY_RE = new RegExp(
  `^files/(${UUID})/uploads/([^/]+)/(${UUID})/([^/]+)$`
);

function safeFileName(filename: string): string {
  return (filename || "file").replace(/[\\/]/g, "_").replace(/\.\./g, "_");
}

/** Parse an upload token (storage key). `null` = not a presigned-upload key. */
export function parsePresignedUploadKey(
  key: string
): { workspaceId: string; userId: string; filename: string } | null {
  const m = KEY_RE.exec(key);
  if (!m) return null;
  return {
    workspaceId: m[1]!,
    userId: m[2]!,
    filename: m[4]!,
  };
}

export interface PresignedUploadTicket {
  ok: true;
  uploadUrl: string;
  method: "PUT";
  /** Send exactly these headers with the PUT (they are signed). */
  headers: { "Content-Type": string };
  /** Opaque — pass it to finalize. */
  uploadToken: string;
  expiresAt: string;
  maxBytes: number;
}

/**
 * The declared file of a presigned request: a name, an allowed mime, a size
 * under that mime's cap (C4). The ONE check both request doors run, so the
 * single upload and the import batch can never accept different files.
 */
function checkDeclaredUpload(file: {
  filename: string;
  mimeType: string;
  size: number;
}): { ok: true; maxBytes: number } | PresignRefusal {
  const { mimeType, size } = file;
  if (!file.filename) {
    return refuse(400, "FILENAME_REQUIRED", "filename is required");
  }
  if (!isAllowedMimeType(mimeType)) {
    return refuse(
      415,
      "MIME_NOT_ALLOWED",
      `MIME type not allowed: ${mimeType}`
    );
  }
  if (!Number.isInteger(size) || size <= 0) {
    return refuse(400, "SIZE_REQUIRED", "size must be a positive integer");
  }
  const maxBytes = maxUploadBytesForMimeType(mimeType);
  if (size > maxBytes) {
    return refuse(
      413,
      "FILE_TOO_LARGE",
      `File too large. Maximum size for ${mimeType} is ${maxBytes / 1024 / 1024}MB`
    );
  }
  return { ok: true, maxBytes };
}

/**
 * Step 1. The caller has already authenticated `userId` and write-checked
 * `workspaceId`.
 */
export async function requestPresignedUpload(params: {
  userId: string;
  workspaceId: string;
  filename: string;
  mimeType: string;
  size: number;
}): Promise<PresignedUploadTicket | PresignRefusal> {
  const { userId, workspaceId, mimeType, size } = params;
  const declared = checkDeclaredUpload(params);
  if (!declared.ok) return declared;
  const { maxBytes } = declared;

  const key = `files/${workspaceId}/uploads/${userId}/${randomUUID()}/${safeFileName(params.filename)}`;
  try {
    const uploadUrl = await storage.getSignedUploadUrl(key, {
      contentType: mimeType,
      contentLength: size,
      expiresIn: PRESIGNED_UPLOAD_TTL_SECONDS,
    });
    return {
      ok: true,
      uploadUrl,
      method: "PUT",
      headers: { "Content-Type": mimeType },
      uploadToken: key,
      expiresAt: new Date(
        Date.now() + PRESIGNED_UPLOAD_TTL_SECONDS * 1000
      ).toISOString(),
      maxBytes,
    };
  } catch (err) {
    if (err instanceof StorageUploadUnavailableError) {
      return refuse(501, err.code, err.message);
    }
    throw err;
  }
}

// ─── Import unit uploads (batch) ────────────────────────────────────────────
//
// The bulk import's file lane (`POST /import/unit-uploads`): ONE request mints
// the PUT URLs of many files, so an import of N recordings costs N / batch hub
// requests instead of N multipart bodies through the API. The bytes go
// straight to storage; the background import job (`POST /import/enqueue-units`)
// then adopts each object as the unit's source file through
// `stageImportUnitUpload` (services/import/store-unit.ts).
//
// No workspace in the key: an import unit is usually a pod-wide kind (a note),
// and its source file's document follows the entity's placement exactly as the
// buffered `/import/store-unit` door's does. The key names the uploading user,
// and the job refuses a key that does not name the job's own user.

/** Files one `POST /import/unit-uploads` call may mint. */
export const IMPORT_UNIT_UPLOADS_MAX = 100;

const IMPORT_KEY_RE = new RegExp(`^imports/([^/]+)/(${UUID})/([^/]+)$`);

/** Parse an import-unit upload token. `null` = not one. */
export function parseImportUnitUploadKey(
  key: string
): { userId: string; filename: string } | null {
  const m = IMPORT_KEY_RE.exec(key);
  if (!m) return null;
  return { userId: m[1]!, filename: m[3]! };
}

/** One minted upload of a batch (no `ok`: the batch answers as a whole). */
export type ImportUnitUploadTicket = Omit<PresignedUploadTicket, "ok">;

/**
 * Mint the PUT URLs of a batch of import files. All-or-nothing: one refused
 * file refuses the batch and names its index, so a client never uploads half a
 * batch it believes whole. The caller has already authenticated `userId`.
 */
export async function requestImportUnitUploads(params: {
  userId: string;
  files: ReadonlyArray<{ filename: string; mimeType: string; size: number }>;
}): Promise<{ ok: true; uploads: ImportUnitUploadTicket[] } | PresignRefusal> {
  const { userId, files } = params;
  if (files.length === 0 || files.length > IMPORT_UNIT_UPLOADS_MAX) {
    return refuse(
      400,
      "BATCH_SIZE",
      `files must hold 1..${IMPORT_UNIT_UPLOADS_MAX} entries`
    );
  }
  const checked: number[] = [];
  for (const [index, file] of files.entries()) {
    const declared = checkDeclaredUpload(file);
    if (!declared.ok) {
      return { ...declared, error: `files[${index}]: ${declared.error}` };
    }
    checked.push(declared.maxBytes);
  }
  const expiresAt = new Date(
    Date.now() + PRESIGNED_UPLOAD_TTL_SECONDS * 1000
  ).toISOString();
  try {
    const uploads = await Promise.all(
      files.map(async (file, index) => {
        const key = `imports/${userId}/${randomUUID()}/${safeFileName(file.filename)}`;
        const uploadUrl = await storage.getSignedUploadUrl(key, {
          contentType: file.mimeType,
          contentLength: file.size,
          expiresIn: PRESIGNED_UPLOAD_TTL_SECONDS,
        });
        return {
          uploadUrl,
          method: "PUT" as const,
          headers: { "Content-Type": file.mimeType },
          uploadToken: key,
          expiresAt,
          maxBytes: checked[index]!,
        };
      })
    );
    return { ok: true, uploads };
  } catch (err) {
    if (err instanceof StorageUploadUnavailableError) {
      return refuse(501, err.code, err.message);
    }
    throw err;
  }
}

/** A storage HEAD/GET that found no object (S3 `NotFound` or a 404). */
export function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404;
}

export interface FinalizedUpload {
  ok: true;
  stored: StoredDocument;
  mimeType: string;
  filename: string;
  /** The workspace bound into the token at request time. */
  workspaceId: string;
  /** `true` = an unclaimed document already held this key (a retry). */
  resumed: boolean;
}

/**
 * Is this document already spoken for? An entity references it, or a PENDING
 * proposal will create one on approval (the governed create spreads its input,
 * `documentId` included, into `proposals.data`). Either way a second finalize
 * must not mint another entity over the same bytes.
 *
 * The source-file attach (`gateAndAttachStagedSourceBlob`, reached by the agent
 * upload's `attachToEntityId`) claims a document through other fields: the
 * entity's `properties.sourceFileDocumentId` (its `document_id` is only taken
 * when still NULL), or a pending proposal's `data.sourceFile`. Both count.
 */
async function isDocumentClaimed(documentId: string): Promise<boolean> {
  const [entity] = await db
    .select({ id: entities.id })
    .from(entities)
    .where(
      or(
        eq(entities.documentId, documentId),
        drizzleSql`${entities.properties}->>'sourceFileDocumentId' = ${documentId}`
      )
    )
    .limit(1);
  if (entity) return true;
  const [pending] = await db
    .select({ id: proposals.id })
    .from(proposals)
    .where(
      and(
        eq(proposals.status, "pending"),
        or(
          drizzleSql`${proposals.data}->>'documentId' = ${documentId}`,
          drizzleSql`${proposals.data}->'sourceFile'->>'documentId' = ${documentId}`
        )
      )
    )
    .limit(1);
  return !!pending;
}

/**
 * Step 3. Verifies the PUT landed and is what was declared, then writes the
 * `documents` row. Creates NO entity — the caller does, through the same path
 * as its buffered door. The caller must write-check
 * {@link FinalizedUpload.workspaceId}; use {@link parsePresignedUploadKey} to
 * read it BEFORE calling this.
 */
export async function storeDocumentFromPresignedUpload(params: {
  userId: string;
  uploadToken: string;
  title?: string;
  /** Agent-key caller — provenance is `ai_agent`, never falsified as human. */
  actorAgentUserId?: string;
  /**
   * The entity kind the caller will create. When given, it is resolved BEFORE
   * any row is written, so an unknown kind is a 400 and not a stranded upload.
   */
  profileSlug?: string;
}): Promise<FinalizedUpload | PresignRefusal> {
  const { userId, uploadToken } = params;
  const parsed = parsePresignedUploadKey(uploadToken);
  if (!parsed) {
    return refuse(400, "INVALID_UPLOAD_TOKEN", "uploadToken is not valid");
  }
  if (parsed.userId !== userId) {
    return refuse(
      403,
      "UPLOAD_NOT_YOURS",
      "uploadToken belongs to another user"
    );
  }

  if (params.profileSlug) {
    const profile = await new ProfileResolutionService(db).resolveProfile(
      params.profileSlug,
      userId,
      parsed.workspaceId
    );
    if (!profile) {
      return refuse(
        400,
        "UNKNOWN_PROFILE",
        `No entity kind "${params.profileSlug}" in this workspace`
      );
    }
  }

  const alreadyFinalized = () =>
    refuse(409, "ALREADY_FINALIZED", "This upload was already finalized");

  const [existing] = await db
    .select()
    .from(documents)
    .where(eq(documents.storageKey, uploadToken))
    .limit(1);
  if (existing) {
    if (await isDocumentClaimed(existing.id)) return alreadyFinalized();
    // Resume: a previous finalize wrote the row, then its entity create
    // failed. Hand back the same document so the caller can retry the create.
    return {
      ok: true,
      resumed: true,
      mimeType: existing.mimeType ?? "application/octet-stream",
      filename: parsed.filename,
      workspaceId: parsed.workspaceId,
      stored: {
        documentId: existing.id,
        storageKey: uploadToken,
        storageUrl: existing.storageUrl ?? "",
        size: existing.size,
        document: existing as {
          id: string;
          storageKey: string | null;
          [k: string]: unknown;
        },
      },
    };
  }

  let info: { size: number; contentType: string };
  try {
    info = await storage.getMetadata(uploadToken);
  } catch (err) {
    // A missing object is the caller's mistake (PUT never happened or failed);
    // any other storage failure is ours and surfaces as a 500 — never folded
    // into "not found".
    if (isNotFound(err)) {
      return refuse(
        404,
        "UPLOAD_NOT_FOUND",
        "No uploaded object for this token — PUT the bytes to uploadUrl first"
      );
    }
    throw err;
  }

  const mimeType = info.contentType;
  const reject = async (r: PresignRefusal) => {
    await storage.delete(uploadToken).catch((err: unknown) => {
      logger.warn({ err, key: uploadToken }, "Failed to delete refused upload");
    });
    return r;
  };
  if (!isAllowedMimeType(mimeType)) {
    return reject(
      refuse(415, "MIME_NOT_ALLOWED", `MIME type not allowed: ${mimeType}`)
    );
  }
  const maxBytes = maxUploadBytesForMimeType(mimeType);
  if (info.size <= 0 || info.size > maxBytes) {
    return reject(
      refuse(
        413,
        "FILE_TOO_LARGE",
        `Uploaded object is ${info.size} bytes; ${mimeType} allows 1..${maxBytes}`
      )
    );
  }

  let result: Awaited<ReturnType<EntityBodyService["setBody"]>>;
  try {
    result = await new EntityBodyService(db, eventRepository).setBody({
      entityId: randomUUID(),
      userId,
      workspaceId: parsed.workspaceId,
      title: params.title,
      storedObject: {
        storageKey: uploadToken,
        size: info.size,
        mimeType,
        filename: parsed.filename,
      },
      provenance: params.actorAgentUserId
        ? {
            createdByKind: "ai_agent",
            createdByUserId: params.actorAgentUserId,
          }
        : { createdByKind: "human", createdByUserId: userId },
    });
  } catch (err) {
    // A concurrent finalize of the same key won the unique index (0300).
    if (isUniqueViolation(err)) return alreadyFinalized();
    throw err;
  }

  const [document] = await db
    .select()
    .from(documents)
    .where(eq(documents.id, result.documentId as string))
    .limit(1);

  return {
    ok: true,
    resumed: false,
    mimeType,
    filename: parsed.filename,
    workspaceId: parsed.workspaceId,
    stored: {
      documentId: result.documentId as string,
      storageKey: uploadToken,
      storageUrl: result.storageUrl as string,
      size: info.size,
      document: document as {
        id: string;
        storageKey: string | null;
        [k: string]: unknown;
      },
    },
  };
}
