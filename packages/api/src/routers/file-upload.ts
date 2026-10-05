/**
 * File Upload REST Endpoint (Hono)
 *
 * REST because tRPC doesn't support multipart/form-data.
 *
 * POST /upload — multipart file upload → entity creation
 * GET /:entityId/url — presigned download URL for a file entity
 */

import { Hono } from "hono";
import { randomUUID } from "crypto";
import { createLogger } from "@synap-core/core";
import { storage } from "@synap/storage";
import {
  db,
  eq,
  and,
  entities,
  documents,
  workspaceMembers,
  workspaces,
  materializeEntity,
  resolveImportEntityPlacement,
  eventRepository,
  EntityBodyService,
} from "@synap/database";
import { channelContextItems } from "@synap/database/schema";
import { authMiddleware } from "@synap/auth";
import { refuseGuestSession } from "../access/guest-containment.js";
import { TRPCError } from "@trpc/server";
import { assertWorkspaceWrite } from "../utils/workspace-write-access.js";
import {
  requestPresignedUpload,
  storeDocumentFromPresignedUpload,
  parsePresignedUploadKey,
} from "./file-upload-presign.js";

const logger = createLogger({ module: "file-upload" });

/** Max file size: 10 MB */
export const MAX_FILE_SIZE = 10 * 1024 * 1024;

/** Allowed MIME type prefixes and exact types */
const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "text/csv",
  "text/plain",
  "text/markdown",
  "application/json",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/zip",
  // Brand fonts (C4: 5 MB cap). Font files are inert data — no script vector.
  "font/woff2",
  "font/woff",
  "font/ttf",
  "font/otf",
]);

export function isAllowedMimeType(mimeType: string): boolean {
  if (mimeType.startsWith("image/")) return true;
  if (mimeType.startsWith("audio/")) return true;
  if (mimeType.startsWith("video/")) return true;
  return ALLOWED_MIME_TYPES.has(mimeType);
}

const MB = 1024 * 1024;

/**
 * Per-mime upload ceiling (contract C4). The buffered multipart doors are still
 * bounded by {@link MAX_FILE_SIZE} (the API holds the whole body in memory);
 * anything larger goes through the presigned lane (`file-upload-presign.ts`),
 * where the bytes go straight to object storage.
 */
export function maxUploadBytesForMimeType(mimeType: string): number {
  if (mimeType.startsWith("video/")) return 500 * MB;
  if (mimeType.startsWith("audio/")) return 100 * MB;
  if (mimeType === "application/zip") return 200 * MB;
  if (mimeType.startsWith("font/")) return 5 * MB;
  return MAX_FILE_SIZE;
}

/** Byte cap of the buffered (multipart / base64) doors for this mime. */
export function maxBufferedUploadBytes(mimeType: string): number {
  return Math.min(MAX_FILE_SIZE, maxUploadBytesForMimeType(mimeType));
}

/** `brand-asset.asset-kind` for an upload's mime (contract C3). */
export function brandAssetKindForMimeType(mimeType: string): string {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("font/")) return "font";
  if (mimeType === "application/pdf") return "document";
  return "other";
}

/**
 * The entity-shaping fields every upload door accepts — ONE parser, so the
 * Kratos `/upload`, the Hub `/files` multipart door and the presigned finalize
 * read `profileSlug` / `storageKeyProperty` / `properties` identically.
 */
export interface UploadEntityFields {
  profileSlug: string;
  storageKeyProperty: string;
  properties: Record<string, unknown>;
}

export function parseUploadEntityFields(
  body: Record<string, unknown>
): UploadEntityFields | { error: string } {
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  let properties: Record<string, unknown> = {};
  const raw = body["properties"];
  if (raw !== undefined && raw !== null && raw !== "") {
    let parsed: unknown = raw;
    if (typeof raw === "string") {
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { error: "properties must be valid JSON" };
      }
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "properties must be a JSON object" };
    }
    properties = parsed as Record<string, unknown>;
  }
  return {
    profileSlug: str(body["profileSlug"]) ?? "file",
    storageKeyProperty: str(body["storageKeyProperty"]) ?? "storageKey",
    properties,
  };
}

/**
 * The property bag a stored upload's entity is created with — shared by the
 * direct materializer path and the governed `entities.create` path so both
 * shape a `brand-asset` (asset-document-id + asset-kind) and a canonical `file`
 * (no duplicated storage pointers) the same way.
 */
export function uploadEntityProperties(params: {
  profileSlug: string;
  storageKeyProperty?: string;
  properties?: Record<string, unknown>;
  mimeType: string;
  size: number;
  filename: string;
  documentId: string;
  storageKey: string;
}): Record<string, unknown> {
  const { profileSlug, mimeType, filename, documentId } = params;
  const extraProperties = params.properties ?? {};
  const storageKeyProperty = params.storageKeyProperty || "storageKey";
  // Legacy callers can still choose the storage-key property, but brand uploads
  // link through asset-document-id so asset-url remains an actual external URL.
  const effectiveStorageKeyProperty =
    profileSlug === "brand-asset" && storageKeyProperty === "asset-url"
      ? "storageKey"
      : storageKeyProperty;
  const documentProperties =
    profileSlug === "brand-asset"
      ? {
          "asset-document-id": documentId,
          "asset-kind":
            (extraProperties["asset-kind"] as string | undefined) ??
            brandAssetKindForMimeType(mimeType),
        }
      : {};
  // Canonical `file` entities keep their storage pointers on the documents
  // row + entities.documentId ONLY — never duplicated into entity properties
  // (and `fileName` is dropped in favour of the entity title). Other profiles
  // (`brand-asset`) still receive the property pointers below.
  const storagePointerProperties =
    profileSlug === "file"
      ? {}
      : {
          fileName: filename,
          documentId,
          [effectiveStorageKeyProperty]: params.storageKey,
        };
  return {
    ...extraProperties,
    ...documentProperties,
    mimeType,
    fileSize: params.size,
    ...storagePointerProperties,
  };
}

/**
 * Result of {@link uploadBufferAsFileEntity}. Loosely typed on purpose so this
 * exported signature stays self-contained (no drizzle-inferred types leak into
 * the package `.d.ts`, which would break the `--declaration` portability check).
 */
export interface UploadedFileEntity {
  entity: { id: string; [k: string]: unknown };
  document: { id: string; storageKey: string | null; [k: string]: unknown };
  /** The document's canonical storage url (`metadata.url`). */
  url: string;
  /** The storage object key/path (`metadata.path`) — usable with `storage.getSignedUrl`. */
  storageKey: string;
}

/**
 * Result of {@link storeDocumentFromBuffer} — the STORE-ONLY half (blob →
 * `documents` row + immutable v1 `documentVersions` snapshot) with NO entity.
 * Loosely typed on `document` for the same `.d.ts` portability reason as
 * {@link UploadedFileEntity}.
 */
export interface StoredDocument {
  documentId: string;
  /** `metadata.path` — the object storage key (usable with `storage.getSignedUrl`). */
  storageKey: string;
  /** `metadata.url` — the document's canonical storage url. */
  storageUrl: string;
  /** `metadata.size` — stored byte size. */
  size: number;
  /** The inserted `documents` row. */
  document: { id: string; storageKey: string | null; [k: string]: unknown };
}

/**
 * STORE-ONLY half of the upload pipeline: uploads the blob to object storage
 * and writes the canonical `documents` row + immutable v1 `documentVersions`
 * snapshot — but creates NO entity.
 *
 * Extracted from {@link uploadBufferAsFileEntity} so the governed `/files`
 * multipart door can store the document, then mint its entity through the
 * governed `entities.create` procedure (same permission membrane as every other
 * write) instead of the direct `materializeEntity`. `uploadBufferAsFileEntity`
 * itself now calls this then materializes, so its existing callers are
 * unchanged.
 */
export async function storeDocumentFromBuffer(params: {
  userId: string;
  /** Workspace the document lands in. `null` = pod-personal. */
  workspaceId: string | null;
  buffer: Buffer;
  mimeType: string;
  filename: string;
  /** Human-facing document title. Defaults to `filename` when omitted. */
  title?: string;
  /**
   * The agent that stored this blob, when the caller is a machine/agent key
   * (ctx.agentUserId). When set, provenance is `ai_agent` attributed to this id
   * — NEVER falsified as `human`. Omit for a genuine human upload (Kratos).
   */
  actorAgentUserId?: string;
}): Promise<StoredDocument> {
  const { userId, workspaceId, buffer, mimeType, filename } = params;

  // Thin wrapper over the canonical body door (EntityBodyService bytes-mode):
  // it uploads the blob + the immutable v1 version snapshot and writes the
  // `documents` row (+ v1 `document_versions`) atomically through
  // DocumentRepository.create — the same storage/type/snapshot logic this
  // function used to inline. The service owns storage + version cleanup
  // (deleteBody), so callers no longer track the snapshot object key themselves.
  logger.info(
    { fileName: filename, size: buffer.length, mimeType },
    "Uploading file to storage"
  );
  const entityBodyService = new EntityBodyService(db, eventRepository);
  const result = await entityBodyService.setBody({
    // No entity exists yet — this id only namespaces the storage/version keys.
    entityId: randomUUID(),
    userId,
    workspaceId,
    title: params.title,
    filename,
    mimeType,
    bytes: buffer,
    // Honest provenance: an agent-key upload (the general `/files` door) is
    // attributed to the agent, a Kratos-session upload stays human. Never
    // falsify an agent write as human (the sibling entity is attributed to the
    // agent too — the document row must agree).
    provenance: params.actorAgentUserId
      ? { createdByKind: "ai_agent", createdByUserId: params.actorAgentUserId }
      : { createdByKind: "human", createdByUserId: userId },
  });

  // Re-read the inserted row so the return keeps the FULL `documents` record its
  // callers expect (title/type/metadata/…), not just the id the service returns.
  const [document] = await db
    .select()
    .from(documents)
    .where(eq(documents.id, result.documentId as string))
    .limit(1);

  return {
    documentId: result.documentId as string,
    storageKey: result.storageKey as string,
    storageUrl: result.storageUrl as string,
    size: result.size as number,
    document: document as {
      id: string;
      storageKey: string | null;
      [k: string]: unknown;
    },
  };
}

/**
 * Core upload → document → file-entity pipeline, shared by the Kratos-authed
 * `POST /upload` multipart route AND the Hub-Protocol (API-key) attachment route.
 *
 * Given a decoded `Buffer` + mime/filename, this:
 *   1. uploads the blob to object storage,
 *   2. creates the canonical `documents` row + immutable `documentVersions` v1
 *      snapshot,
 *   3. creates the `file` (or caller-specified profile) entity via
 *      `EntityRepository` — including the `brand-asset` property mapping the
 *      route used before — and cleans up storage/document on entity failure.
 *
 * This is a straight extraction of the original `/upload` handler body; the
 * route now calls it so both auth surfaces share ONE storage/entity path.
 */
export async function uploadBufferAsFileEntity(params: {
  userId: string;
  /** Workspace the document + entity land in. `null` = pod-personal. */
  workspaceId: string | null;
  buffer: Buffer;
  mimeType: string;
  filename: string;
  /** Human-facing document/entity title. Defaults to `filename` when omitted. */
  title?: string;
  /**
   * The agent that authored this upload, when the caller is a machine/agent key
   * (ctx.agentUserId). When set, provenance is recorded as `ai_agent` attributed
   * to this id — NOT falsified as `human`. Omit for a genuine human upload
   * (Kratos session), which stays `human`.
   */
  actorAgentUserId?: string;
  /** Defaults to "file" — same as the plain-file upload route. */
  profileSlug?: string;
  /** Property key that receives the storage path. Defaults to "storageKey". */
  storageKeyProperty?: string;
  /** Extra entity properties merged in (e.g. from the multipart `properties`). */
  properties?: Record<string, unknown>;
}): Promise<UploadedFileEntity> {
  const stored = await storeDocumentFromBuffer({
    userId: params.userId,
    workspaceId: params.workspaceId,
    buffer: params.buffer,
    mimeType: params.mimeType,
    filename: params.filename,
    title: params.title,
  });
  return createFileEntityForStoredDocument(stored, params);
}

/**
 * The entity half of {@link uploadBufferAsFileEntity}: given a stored document
 * (from the buffered door OR a finalized presigned upload), materialize its
 * entity and — on failure — reverse the document + storage objects.
 */
export async function createFileEntityForStoredDocument(
  stored: StoredDocument,
  params: {
    userId: string;
    workspaceId: string | null;
    mimeType: string;
    filename: string;
    title?: string;
    actorAgentUserId?: string;
    profileSlug?: string;
    storageKeyProperty?: string;
    properties?: Record<string, unknown>;
    /**
     * Keep the document + bytes when the entity create fails. The presigned
     * finalize sets it: its bytes cannot be re-sent cheaply, and a retry
     * resumes on the unclaimed document instead.
     */
    keepDocumentOnFailure?: boolean;
  }
): Promise<UploadedFileEntity> {
  const { userId, workspaceId, mimeType, filename } = params;
  // Human-facing title: caller-supplied (e.g. `synap upload --title`) or the
  // filename. `filename` remains the storage key / originalFileName provenance.
  const displayTitle = params.title?.trim() || filename;
  const profileSlug = params.profileSlug || "file";
  const document = stored.document;

  // D1: the upload's workspace is a CONTEXT signal — route placement through the
  // one door so a pod-scope kind (e.g. a generic `file`) lands pod-wide (NULL)
  // while a workspace-scoped one (e.g. `brand-asset`) stays in its lens.
  const resolvedWorkspaceId = await resolveImportEntityPlacement(db, {
    userId,
    profileSlug,
    sourceWorkspaceId: workspaceId,
  });
  let createdEntity;
  try {
    const materialized = await materializeEntity(
      {
        profileSlug,
        title: displayTitle,
        workspaceId: resolvedWorkspaceId,
        userId,
        documentId: document.id,
        properties: uploadEntityProperties({
          profileSlug,
          storageKeyProperty: params.storageKeyProperty,
          properties: params.properties,
          mimeType,
          size: stored.size,
          filename,
          documentId: document.id,
          storageKey: stored.storageKey,
        }),
      },
      {
        db,
        eventRepo: eventRepository,
        // Attribute honestly: an agent-key upload is `ai_agent` (attributed to
        // the agent), a Kratos-session upload is `human`. Never falsify agent
        // writes as human in the audit trail.
        provenance: params.actorAgentUserId
          ? {
              createdByKind: "ai_agent",
              createdByUserId: params.actorAgentUserId,
            }
          : { createdByKind: "human", createdByUserId: userId },
      }
    );
    createdEntity = materialized.entity;
  } catch (createError) {
    if (params.keepDocumentOnFailure) throw createError;
    try {
      // Reverse-cascade via the service — deletes the `documents` row AND its
      // storage objects (current + any version snapshot).
      await new EntityBodyService(db, eventRepository).deleteBody({
        documentId: document.id,
      });
    } catch (cleanupError) {
      logger.warn(
        { err: cleanupError, documentId: document.id },
        "Failed to clean up uploaded document after entity creation failure"
      );
    }
    throw createError;
  }

  return {
    entity: createdEntity as { id: string; [k: string]: unknown },
    document: document as {
      id: string;
      storageKey: string | null;
      [k: string]: unknown;
    },
    url: stored.storageUrl,
    storageKey: stored.storageKey,
  };
}

export const fileUploadApp = new Hono<{
  Variables: {
    userId: string;
    user: { id: string; email: string; name?: string };
    authenticated: boolean;
  };
}>();

// Auth: Kratos session cookie for all routes
fileUploadApp.use("/*", authMiddleware);
fileUploadApp.use("/*", refuseGuestSession);

// ---------------------------------------------------------------------------
// POST /upload — multipart file upload
// ---------------------------------------------------------------------------
fileUploadApp.post("/upload", async (c) => {
  const userId = c.get("userId");
  if (!userId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const body = await c.req.parseBody();

    const file = body["file"];
    const workspaceId = body["workspaceId"] as string | undefined;
    const channelId = body["channelId"] as string | undefined;
    // Optional: caller-specified profile slug (default "file") and which property key
    // receives the storage path (default "storageKey"). Allows callers to create any
    // entity type in one round-trip instead of upload + separate create.
    const fields = parseUploadEntityFields(body);
    if ("error" in fields) return c.json({ error: fields.error }, 400);
    const {
      profileSlug,
      storageKeyProperty,
      properties: extraProperties,
    } = fields;

    // Validate required fields
    if (!workspaceId || typeof workspaceId !== "string") {
      return c.json({ error: "workspaceId is required" }, 400);
    }

    // Same write gate as the presigned lane (`/uploads`): a session must
    // never write into a workspace it cannot edit.
    if (!(await canWriteWorkspace(userId, workspaceId))) {
      return c.json({ error: "Forbidden" }, 403);
    }

    if (!file || !(file instanceof File)) {
      return c.json({ error: "file is required (multipart file field)" }, 400);
    }

    // Validate MIME type
    const mimeType = file.type || "application/octet-stream";
    if (!isAllowedMimeType(mimeType)) {
      return c.json({ error: `MIME type not allowed: ${mimeType}` }, 415);
    }

    // Validate file size — this door buffers the body, so it is capped at the
    // smaller of the mime's cap and 10MB; larger files use the presigned lane.
    const maxBytes = maxBufferedUploadBytes(mimeType);
    if (file.size > maxBytes) {
      return c.json(
        {
          error: `File too large. Maximum size is ${maxBytes / 1024 / 1024}MB here${
            maxUploadBytesForMimeType(mimeType) > maxBytes
              ? " — use POST /uploads (presigned) for larger files"
              : ""
          }`,
        },
        413
      );
    }

    const originalFileName = file.name || "unnamed";

    // Read file into Buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Canonical storage + document + file-entity pipeline (shared with the
    // Hub-Protocol attachment route). Behavior is unchanged from the previous
    // inline implementation.
    const {
      entity: createdEntity,
      document,
      storageKey,
    } = await uploadBufferAsFileEntity({
      userId,
      workspaceId,
      buffer,
      mimeType,
      filename: originalFileName,
      profileSlug,
      storageKeyProperty,
      properties: extraProperties,
    });
    // Use the canonical entity ID returned by the repository
    const createdEntityId = createdEntity.id;

    logger.info(
      { entityId: createdEntityId, workspaceId, fileName: originalFileName },
      "File entity created"
    );

    return c.json(
      await finishUpload({
        userId,
        workspaceId,
        channelId,
        entityId: createdEntityId,
        documentId: document.id,
        storageKey,
        mimeType,
        fileName: originalFileName,
        size: file.size,
      })
    );
  } catch (error) {
    logger.error({ err: error }, "File upload failed");
    return c.json({ error: "File upload failed" }, 500);
  }
});

/**
 * The shared tail of the Kratos upload doors (buffered `/upload` and presigned
 * `/uploads/finalize`): optional channel-context link, image preview URL, and
 * the response body — so both doors answer in the same shape.
 */
async function finishUpload(p: {
  userId: string;
  workspaceId: string | null;
  channelId?: string;
  entityId: string;
  documentId: string;
  storageKey: string;
  mimeType: string;
  fileName: string;
  size: number;
}) {
  const { userId, workspaceId, channelId, mimeType, storageKey } = p;
  const createdEntityId = p.entityId;
  if (channelId) {
    try {
      await db
        .insert(channelContextItems)
        .values({
          channelId,
          objectType: "entity",
          objectId: createdEntityId,
          relationshipType: "used_as_context",
          userId,
          workspaceId,
        })
        .onConflictDoNothing();
    } catch (err) {
      // Non-fatal — entity is still created
      logger.warn(
        { err, entityId: createdEntityId, channelId },
        "Failed to link file to channel context"
      );
    }
  }

  // Generate a preview URL for images
  let previewUrl: string | undefined;
  if (mimeType.startsWith("image/")) {
    try {
      previewUrl = await storage.getSignedUrl(storageKey, 3600);
    } catch {
      // Non-fatal
    }
  }

  return {
    entityId: createdEntityId,
    fileName: p.fileName,
    mimeType,
    size: p.size,
    storageKey,
    documentId: p.documentId,
    previewUrl: previewUrl ?? null,
  };
}

/**
 * Kratos-door write gate: the canonical `assertWorkspaceWrite` floor (an
 * editor+ member row — a viewer cannot upload), plus the workspace OWNER, who
 * may hold no member row at all.
 */
async function canWriteWorkspace(
  userId: string,
  workspaceId: string
): Promise<boolean> {
  try {
    await assertWorkspaceWrite(db, userId, { workspaceId });
    return true;
  } catch (err) {
    if (!(err instanceof TRPCError && err.code === "FORBIDDEN")) throw err;
  }
  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: { ownerId: true },
  });
  return ws?.ownerId === userId;
}

// ---------------------------------------------------------------------------
// POST /uploads — presigned (large-file) upload, step 1: get a PUT URL.
// Body (JSON): { workspaceId, filename, mimeType, size }
// ---------------------------------------------------------------------------
fileUploadApp.post("/uploads", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const workspaceId = body.workspaceId;
  if (typeof workspaceId !== "string" || !workspaceId) {
    return c.json({ error: "workspaceId is required" }, 400);
  }
  if (!(await canWriteWorkspace(userId, workspaceId))) {
    return c.json({ error: "Forbidden" }, 403);
  }
  const ticket = await requestPresignedUpload({
    userId,
    workspaceId,
    filename: typeof body.filename === "string" ? body.filename : "",
    mimeType: typeof body.mimeType === "string" ? body.mimeType : "",
    size: Number(body.size),
  });
  if (!ticket.ok) {
    return c.json({ error: ticket.error, code: ticket.code }, ticket.status);
  }
  const { ok: _ok, ...rest } = ticket;
  return c.json(rest);
});

// ---------------------------------------------------------------------------
// POST /uploads/finalize — step 3: the PUT landed; create the entity exactly as
// `/upload` does. Body (JSON): { uploadToken, title?, channelId?, profileSlug?,
// storageKeyProperty?, properties? }
// ---------------------------------------------------------------------------
fileUploadApp.post("/uploads/finalize", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const fields = parseUploadEntityFields(body);
  if ("error" in fields) return c.json({ error: fields.error }, 400);
  const uploadToken =
    typeof body.uploadToken === "string" ? body.uploadToken : "";
  const bound = parsePresignedUploadKey(uploadToken);
  if (bound && !(await canWriteWorkspace(userId, bound.workspaceId))) {
    return c.json({ error: "Forbidden" }, 403);
  }
  try {
    const fin = await storeDocumentFromPresignedUpload({
      userId,
      uploadToken,
      title: typeof body.title === "string" ? body.title : undefined,
      profileSlug: fields.profileSlug,
    });
    if (!fin.ok) {
      return c.json({ error: fin.error, code: fin.code }, fin.status);
    }
    const { entity } = await createFileEntityForStoredDocument(fin.stored, {
      userId,
      workspaceId: fin.workspaceId,
      mimeType: fin.mimeType,
      filename: fin.filename,
      title: typeof body.title === "string" ? body.title : undefined,
      profileSlug: fields.profileSlug,
      storageKeyProperty: fields.storageKeyProperty,
      properties: fields.properties,
      keepDocumentOnFailure: true,
    });
    return c.json(
      await finishUpload({
        userId,
        workspaceId: fin.workspaceId,
        channelId:
          typeof body.channelId === "string" ? body.channelId : undefined,
        entityId: entity.id,
        documentId: fin.stored.documentId,
        storageKey: fin.stored.storageKey,
        mimeType: fin.mimeType,
        fileName: fin.filename,
        size: fin.stored.size,
      })
    );
  } catch (error) {
    logger.error({ err: error }, "Presigned upload finalize failed");
    return c.json({ error: "File upload failed" }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /documents/:documentId/url — presigned download URL for document storage
// ---------------------------------------------------------------------------
fileUploadApp.get("/documents/:documentId/url", async (c) => {
  const userId = c.get("userId");
  if (!userId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const documentId = c.req.param("documentId");

  try {
    const document = await db.query.documents.findFirst({
      where: eq(documents.id, documentId),
      columns: {
        id: true,
        userId: true,
        workspaceId: true,
        storageKey: true,
      },
    });

    if (!document || !document.storageKey) {
      return c.json({ error: "Document file not found" }, 404);
    }

    if (document.userId !== userId) {
      if (!document.workspaceId) {
        return c.json({ error: "Forbidden" }, 403);
      }
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, document.workspaceId),
          eq(workspaceMembers.userId, userId)
        ),
      });
      if (!membership) {
        return c.json({ error: "Forbidden" }, 403);
      }
    }

    const expiresInSeconds = 3600;
    const url = await storage.getSignedUrl(
      document.storageKey,
      expiresInSeconds
    );
    const expiresAt = new Date(
      Date.now() + expiresInSeconds * 1000
    ).toISOString();

    return c.json({ url, expiresAt });
  } catch (error) {
    logger.error(
      { err: error, documentId },
      "Failed to generate document presigned URL"
    );
    return c.json({ error: "Failed to generate URL" }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /:entityId/url — presigned download URL
// ---------------------------------------------------------------------------
fileUploadApp.get("/:entityId/url", async (c) => {
  const userId = c.get("userId");
  if (!userId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const entityId = c.req.param("entityId");

  try {
    const entity = await db.query.entities.findFirst({
      where: eq(entities.id, entityId),
      columns: {
        id: true,
        userId: true,
        properties: true,
        workspaceId: true,
        documentId: true,
      },
    });

    if (!entity) {
      return c.json({ error: "File entity not found" }, 404);
    }

    // Verify ownership (userId must match)
    if (entity.userId !== userId) {
      return c.json({ error: "Forbidden" }, 403);
    }

    // The kind filter was intentionally dropped: bytes resolve for ANY entity
    // that carries a documentId (file, brand-asset) — the canonical link, not
    // the kind, gates downloadability. Access is owner-gated above
    // (entity.userId === userId) AND again on the documents row below.
    //
    // The entity check alone used to be the whole story ("authorize on the
    // entity, not the documents row"), and it was true only while
    // `entities.document_id` was unreachable from user input. It was not:
    // `attachSourceBlob` wrote it from a proposal-carried `documentId`, so an
    // entity could be pointed at ANOTHER user's document and this endpoint
    // would presign it. That leg is now gated at the writer too — this
    // predicate is the second lock, and the one that holds for any future
    // writer of the column.
    // Canonical path: resolve bytes via entities.documentId → documents.storageKey.
    // Read-time fallback to the legacy properties.storageKey for un-migrated
    // rows (early `file` entities stored the storage key in entity properties
    // rather than on the documents row).
    let storageKey: string | undefined;
    if (entity.documentId) {
      const doc = await db.query.documents.findFirst({
        where: and(
          eq(documents.id, entity.documentId),
          eq(documents.userId, userId)
        ),
        columns: { storageKey: true },
      });
      storageKey = doc?.storageKey ?? undefined;
    }
    if (!storageKey) {
      const props = entity.properties as Record<string, unknown>;
      storageKey = props.storageKey as string | undefined;
    }

    if (!storageKey) {
      return c.json({ error: "File has no storage key" }, 404);
    }

    const expiresInSeconds = 3600;
    const url = await storage.getSignedUrl(storageKey, expiresInSeconds);
    const expiresAt = new Date(
      Date.now() + expiresInSeconds * 1000
    ).toISOString();

    return c.json({ url, expiresAt });
  } catch (error) {
    logger.error({ err: error, entityId }, "Failed to generate presigned URL");
    return c.json({ error: "Failed to generate URL" }, 500);
  }
});

export default fileUploadApp;
