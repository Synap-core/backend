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
  EntityRepository,
  eventRepository,
} from "@synap/database";
import { channelContextItems } from "@synap/database/schema";
import { authMiddleware } from "@synap/auth";

const logger = createLogger({ module: "file-upload" });

/** Max file size: 10 MB */
const MAX_FILE_SIZE = 10 * 1024 * 1024;

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

function isAllowedMimeType(mimeType: string): boolean {
  if (mimeType.startsWith("image/")) return true;
  if (mimeType.startsWith("audio/")) return true;
  if (mimeType.startsWith("video/")) return true;
  return ALLOWED_MIME_TYPES.has(mimeType);
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
    const storageId = randomUUID();
    const storagePath = `files/${workspaceId}/${storageId}/${originalFileName}`;

    // Read file into Buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Upload to storage (MinIO / R2)
    logger.info(
      { storageId, fileName: originalFileName, size: file.size, mimeType },
      "Uploading file to storage"
    );

    await storage.upload(storagePath, buffer, { contentType: mimeType });

    // Create entity via EntityRepository — handles profile resolution, property indexing, event emission
    const entityRepo = new EntityRepository(db, eventRepository);
    const createdEntity = await entityRepo.create(
      {
        profileSlug: "file",
        title: originalFileName,
        workspaceId,
        userId,
        properties: {
          fileName: originalFileName,
          mimeType,
          fileSize: file.size,
          storageKey: storagePath,
        },
      },
      userId
    );
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
        previewUrl = await storage.getSignedUrl(storagePath, 3600);
      } catch {
        // Non-fatal
      }
    }

    return c.json({
      entityId: createdEntityId,
      fileName: originalFileName,
      mimeType,
      size: file.size,
      storageKey: storagePath,
      previewUrl: previewUrl ?? null,
    });
  } catch (error) {
    logger.error({ err: error }, "File upload failed");
    return c.json({ error: "File upload failed" }, 500);
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
      where: and(eq(entities.id, entityId), eq(entities.type, "file")),
      columns: { id: true, userId: true, properties: true, workspaceId: true },
    });

    if (!entity) {
      return c.json({ error: "File entity not found" }, 404);
    }

    // Verify ownership (userId must match)
    if (entity.userId !== userId) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const props = entity.properties as Record<string, unknown>;
    const storageKey = props.storageKey as string;

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
