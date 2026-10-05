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
 * (`files/<workspaceId|pod>/uploads/<userId>/<uuid>/<name>`), finalize refuses a
 * key that does not name the caller, and refuses a key some document already
 * owns (so one object can never back two documents — deleting one would delete
 * the other's bytes). No table, no migration.
 */

import { randomUUID } from "crypto";
import { createLogger } from "@synap-core/core";
import { storage, StorageUploadUnavailableError } from "@synap/storage";
import {
  db,
  eq,
  documents,
  eventRepository,
  EntityBodyService,
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
const KEY_RE = new RegExp(
  `^files/(${UUID}|pod)/uploads/([^/]+)/(${UUID})/([^/]+)$`
);

function safeFileName(filename: string): string {
  return (filename || "file").replace(/[\\/]/g, "_").replace(/\.\./g, "_");
}

/** Parse an upload token (storage key). `null` = not a presigned-upload key. */
export function parsePresignedUploadKey(
  key: string
): { workspaceId: string | null; userId: string; filename: string } | null {
  const m = KEY_RE.exec(key);
  if (!m) return null;
  return {
    workspaceId: m[1] === "pod" ? null : m[1]!,
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
 * Step 1. The caller has already authenticated `userId` and membership-checked
 * `workspaceId` (null = pod-personal).
 */
export async function requestPresignedUpload(params: {
  userId: string;
  workspaceId: string | null;
  filename: string;
  mimeType: string;
  size: number;
}): Promise<PresignedUploadTicket | PresignRefusal> {
  const { userId, workspaceId, mimeType, size } = params;
  if (!params.filename) {
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

  const key = `files/${workspaceId ?? "pod"}/uploads/${userId}/${randomUUID()}/${safeFileName(params.filename)}`;
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

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404;
}

export interface FinalizedUpload {
  ok: true;
  stored: StoredDocument;
  mimeType: string;
  filename: string;
  /** The workspace bound into the token at request time. */
  workspaceId: string | null;
}

/**
 * Step 3. Verifies the PUT landed and is what was declared, then writes the
 * `documents` row. Creates NO entity — the caller does, through the same path
 * as its buffered door. The caller must membership-check
 * {@link FinalizedUpload.workspaceId}; use {@link parsePresignedUploadKey} to
 * read it BEFORE calling this.
 */
export async function storeDocumentFromPresignedUpload(params: {
  userId: string;
  uploadToken: string;
  title?: string;
  /** Agent-key caller — provenance is `ai_agent`, never falsified as human. */
  actorAgentUserId?: string;
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

  const [already] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(eq(documents.storageKey, uploadToken))
    .limit(1);
  if (already) {
    return refuse(
      409,
      "ALREADY_FINALIZED",
      "This upload was already finalized"
    );
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

  const result = await new EntityBodyService(db, eventRepository).setBody({
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
      ? { createdByKind: "ai_agent", createdByUserId: params.actorAgentUserId }
      : { createdByKind: "human", createdByUserId: userId },
  });

  const [document] = await db
    .select()
    .from(documents)
    .where(eq(documents.id, result.documentId as string))
    .limit(1);

  return {
    ok: true,
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
