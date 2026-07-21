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
  documentVersions,
  workspaceMembers,
  materializeEntity,
  resolveImportEntityPlacement,
  eventRepository,
  storedVersionValues,
  uploadDocumentVersionSnapshot,
} from "@synap/database";
import { channelContextItems } from "@synap/database/schema";
import { authMiddleware } from "@synap/auth";

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
]);

export function isAllowedMimeType(mimeType: string): boolean {
  if (mimeType.startsWith("image/")) return true;
  if (mimeType.startsWith("audio/")) return true;
  if (mimeType.startsWith("video/")) return true;
  return ALLOWED_MIME_TYPES.has(mimeType);
}

function documentTypeForMimeType(mimeType: string): string {
  if (mimeType === "text/markdown") return "markdown";
  if (mimeType === "text/html") return "html";
  if (mimeType.startsWith("text/")) return "text";
  if (mimeType === "application/json") return "code";
  if (mimeType === "application/pdf") return "pdf";
  if (
    mimeType ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return "docx";
  }
  return "file";
}

function brandAssetKindForMimeType(mimeType: string): string {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType === "application/pdf") return "document";
  return "other";
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
  /**
   * The version-snapshot blob key. Exposed so a downstream failure (e.g. an
   * entity-create that follows) can clean up BOTH storage objects, preserving
   * the original single-function cleanup behavior.
   */
  snapshotStorageKey: string;
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
}): Promise<StoredDocument> {
  const { userId, workspaceId, buffer, mimeType, filename } = params;
  const displayTitle = params.title?.trim() || filename;

  const storageId = randomUUID();
  // Sanitize the caller-supplied filename for the storage KEY (defense-in-depth
  // for a local-fs storage backend; object stores treat keys literally). The
  // random storageId already namespaces each blob; this just strips separators
  // and parent refs. The original `filename` is still used for the display title.
  const safeName = (filename || "file")
    .replace(/[\\/]/g, "_")
    .replace(/\.\./g, "_");
  const storagePath = `files/${workspaceId ?? "pod"}/${storageId}/${safeName}`;

  // Upload current file content to storage (MinIO / R2).
  logger.info(
    { storageId, fileName: filename, size: buffer.length, mimeType },
    "Uploading file to storage"
  );
  const metadata = await storage.upload(storagePath, buffer, {
    contentType: mimeType,
  });

  // Canonical path: each uploaded blob gets a document row plus an immutable
  // v1 snapshot. Entities link to the document; raw storage is never the only
  // source of truth.
  const documentId = randomUUID();
  const versionId = randomUUID();
  const documentType = documentTypeForMimeType(mimeType);
  const snapshot = await uploadDocumentVersionSnapshot({
    userId,
    documentId,
    versionId,
    documentType,
    mimeType,
    content: buffer,
  });
  const [document] = await db.transaction(async (tx) => {
    const [doc] = await tx
      .insert(documents)
      .values({
        id: documentId,
        userId,
        workspaceId,
        title: displayTitle,
        type: documentType,
        storageUrl: metadata.url,
        storageKey: metadata.path,
        size: metadata.size,
        mimeType,
        currentVersion: 1,
        lastSavedVersion: 1,
        metadata: {
          originalFileName: filename,
          uploadKind: "file-upload",
        },
      })
      .returning();

    await tx.insert(documentVersions).values({
      id: versionId,
      documentId,
      version: 1,
      ...storedVersionValues(snapshot),
      author: "user",
      authorId: userId,
      message: "Initial upload",
    });

    return [doc];
  });

  return {
    documentId,
    storageKey: metadata.path,
    storageUrl: metadata.url,
    size: metadata.size,
    snapshotStorageKey: snapshot.storageKey,
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
  const { userId, workspaceId, buffer, mimeType, filename } = params;
  // Human-facing title: caller-supplied (e.g. `synap upload --title`) or the
  // filename. `filename` remains the storage key / originalFileName provenance.
  const displayTitle = params.title?.trim() || filename;
  const profileSlug = params.profileSlug || "document";
  const storageKeyProperty = params.storageKeyProperty || "storageKey";
  const extraProperties = params.properties ?? {};

  // Store the blob → documents row + immutable v1 snapshot (the extracted
  // store-only half). Behavior is identical to the previous inline body.
  const stored = await storeDocumentFromBuffer({
    userId,
    workspaceId,
    buffer,
    mimeType,
    filename,
    title: params.title,
  });
  const document = stored.document;

  // Create entity via the governed materializer (wraps EntityRepository.create)
  // — handles profile resolution, property indexing, event emission, plus
  // provenance. A file upload is a direct HUMAN action, so provenance = human.
  // Merge caller-provided properties. Legacy callers can still choose the
  // storage-key property, but brand uploads link through asset-document-id so
  // asset-url remains an actual external URL field.
  const effectiveStorageKeyProperty =
    profileSlug === "brand-asset" && storageKeyProperty === "asset-url"
      ? "storageKey"
      : storageKeyProperty;
  const documentProperties =
    profileSlug === "brand-asset"
      ? {
          "asset-document-id": document.id,
          "asset-kind":
            (extraProperties["asset-kind"] as string | undefined) ??
            brandAssetKindForMimeType(mimeType),
        }
      : {};
  // Canonical `document` entities keep their storage pointers on the documents
  // row + entities.documentId ONLY — never duplicated into entity properties
  // (and `fileName` is dropped in favour of the entity title). Other profiles
  // (legacy `file`, `brand-asset`) still receive the property pointers below.
  const isCanonicalDocument = profileSlug === "document";
  const storagePointerProperties = isCanonicalDocument
    ? {}
    : {
        fileName: filename,
        documentId: document.id,
        [effectiveStorageKeyProperty]: stored.storageKey,
      };
  // D1: the upload's workspace is a CONTEXT signal — route placement through the
  // one door so a pod-scope kind (e.g. a generic `file`) lands pod-wide (NULL)
  // while a workspace-scoped one (e.g. `brand-asset`) stays in its lens. The 400
  // requiring a workspace above is kept deliberately: the storage path and the
  // brand-asset branch make the workspace context genuinely load-bearing here,
  // so we demote pod-scope kinds via the resolver rather than by relaxing intake.
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
        properties: {
          ...extraProperties,
          ...documentProperties,
          mimeType,
          fileSize: buffer.length,
          ...storagePointerProperties,
        },
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
    try {
      await db.delete(documents).where(eq(documents.id, document.id));
      await Promise.allSettled([
        storage.delete(stored.storageKey),
        storage.delete(stored.snapshotStorageKey),
      ]);
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
    const profileSlug =
      (body["profileSlug"] as string | undefined) || "document";
    const storageKeyProperty =
      (body["storageKeyProperty"] as string | undefined) || "storageKey";
    let extraProperties: Record<string, unknown> = {};
    const propertiesRaw = body["properties"] as string | undefined;
    if (propertiesRaw) {
      try {
        extraProperties = JSON.parse(propertiesRaw) as Record<string, unknown>;
      } catch {
        return c.json({ error: "properties must be valid JSON" }, 400);
      }
    }

    // Validate required fields
    if (!workspaceId || typeof workspaceId !== "string") {
      return c.json({ error: "workspaceId is required" }, 400);
    }

    if (!file || !(file instanceof File)) {
      return c.json({ error: "file is required (multipart file field)" }, 400);
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      return c.json(
        {
          error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB`,
        },
        413
      );
    }

    // Validate MIME type
    const mimeType = file.type || "application/octet-stream";
    if (!isAllowedMimeType(mimeType)) {
      return c.json({ error: `MIME type not allowed: ${mimeType}` }, 415);
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

    // If channelId provided, link to channel context
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

    return c.json({
      entityId: createdEntityId,
      fileName: originalFileName,
      mimeType,
      size: file.size,
      storageKey,
      documentId: document.id,
      previewUrl: previewUrl ?? null,
    });
  } catch (error) {
    logger.error({ err: error }, "File upload failed");
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
    // that carries a documentId (document, legacy file, brand-asset) — the
    // canonical link, not the kind, gates downloadability. Access is still
    // owner-gated above (entity.userId === userId).
    // Canonical path: resolve bytes via entities.documentId → documents.storageKey.
    // Read-time fallback to the legacy properties.storageKey for un-migrated rows
    // (documents created before the file→document consolidation stored the key
    // in entity properties).
    let storageKey: string | undefined;
    if (entity.documentId) {
      const doc = await db.query.documents.findFirst({
        where: eq(documents.id, entity.documentId),
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
