/**
 * Documents Router
 * Handles document upload, retrieval, updates, and collaborative sessions
 *
 * Architecture: Hybrid approach
 * - AI operations (create via chat): Full events
 * - User edits (typing): Direct updates + session tracking
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { storage } from "@synap/storage";
import {
  db,
  eq,
  and,
  desc,
  documents,
  documentVersions,
  documentSessions,
} from "@synap/database";

import { requireUserId } from "../utils/user-scoped.js";
import { randomUUID } from "crypto";
import { emitRequestEvent } from "../utils/emit-event.js";

// ============================================================================
// SCHEMAS
// ============================================================================

const DocumentTypeSchema = z.enum(["text", "markdown", "code", "pdf", "docx"]);

const UploadDocumentSchema = z.object({
  type: DocumentTypeSchema,
  content: z.string(),
  title: z.string().optional(),
  language: z.string().optional(),
  mimeType: z.string().optional(),
  projectId: z.string().uuid().optional(),
});

const UpdateDocumentSchema = z.object({
  documentId: z.string(),
  delta: z
    .array(
      z.object({
        content: z.string(),
        // Add other OT fields as needed
      })
    )
    .optional(),
  version: z.number().int().positive(),
  message: z.string().optional(),
});

// ============================================================================
// ROUTER
// ============================================================================

export const documentsRouter = router({
  /**
   * Upload a new document
   */
  upload: protectedProcedure
    .input(UploadDocumentSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const documentId = randomUUID();

      await emitRequestEvent({
        type: "documents.create.requested",
        subjectId: documentId,
        subjectType: "document",
        data: {
          id: documentId,
          title: input.title,
          type: input.type,
          language: input.language || undefined,
          content: input.content,
          mimeType: input.mimeType || undefined,
          projectId: input.projectId || undefined,
          userId,
        },
        userId,
      });

      return {
        status: "requested",
        message: "Document upload requested",
        documentId,
      };
    }),

  /**
   * Get document by ID
   */
  get: protectedProcedure
    .input(z.object({ documentId: z.string() }))
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      const [document] = await db
        .select()
        .from(documents)
        .where(
          and(eq(documents.id, input.documentId), eq(documents.userId, userId))
        )
        .limit(1);

      if (!document) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Document not found",
        });
      }

      const contentBuffer = await storage.downloadBuffer(document.storageKey);
      const content =
        document.type === "pdf" || document.type === "docx"
          ? contentBuffer.toString("base64")
          : contentBuffer.toString("utf-8");

      return { document, content };
    }),

  /**
   * Update document (Hybrid: Storage sync + Event for Metadata/Governor)
   */
  update: protectedProcedure
    .input(UpdateDocumentSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      // 1. Verify existence & authorization ownership (Optimistic check)
      const [document] = await db
        .select()
        .from(documents)
        .where(
          and(eq(documents.id, input.documentId), eq(documents.userId, userId))
        )
        .limit(1);

      if (!document) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Document not found",
        });
      }

      // 2. Direct storage update (to handle large content without blocking)
      // Note: This bypasses strict governance for content, but governance will catch the metadata update
      const newContent = input.delta?.[0]?.content || "";
      const newVersion = document.currentVersion + 1;

      if (input.delta) {
        await storage.upload(
          document.storageKey,
          Buffer.from(newContent, "utf-8"),
          { contentType: document.mimeType || "text/plain" }
        );
      }

      // 3. Emit Event for Metadata/DB Update
      // This ensures the DB update goes through the unified flow (governance -> executor)
      await emitRequestEvent({
        type: "documents.update.requested",
        subjectId: input.documentId,
        subjectType: "document",
        data: {
          id: input.documentId,
          currentVersion: newVersion,
          title: document.title,
          version: newVersion,
          message: input.message,
          userId,
        },
        userId,
      });

      // 4. Optimistic Response
      // We assume storage succeeded and DB will follow.
      return { version: newVersion, success: true };
    }),

  /**
   * Delete document
   */
  delete: protectedProcedure
    .input(
      z.object({
        documentId: z.string(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const userId = requireUserId(ctx.userId);

      const document = await db.query.documents.findFirst({
        where: eq(documents.id, input.documentId),
      });

      if (!document) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Document not found",
        });
      }

      if (document.userId !== userId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Not authorized" });
      }

      await emitRequestEvent({
        type: "documents.delete.requested",
        subjectId: input.documentId,
        subjectType: "document",
        data: {
          id: input.documentId,
          userId,
        },
        userId,
      });

      // Storage delete kept synchronous for safety
      await storage.delete(document.storageKey);

      return { success: true };
    }),

  // ============================================================================
  // VERSION MANAGEMENT (Same pattern as whiteboards)
  // ============================================================================

  /**
   * Save document version manually (Cmd+S)
   */
  saveVersion: protectedProcedure
    .input(
      z.object({
        documentId: z.string(),
        message: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const userId = requireUserId(ctx.userId);

      // Publish event for worker to process
      const { inngest } = await import("@synap/jobs");
      await inngest.send({
        name: "documents.snapshot.requested",
        data: {
          documentId: input.documentId,
          message: input.message,
          userId,
        },
        user: { id: userId },
      });

      return {
        status: "requested",
        message: "Version save requested",
      };
    }),

  /**
   * List document versions
   */
  listVersions: protectedProcedure
    .input(
      z.object({
        documentId: z.string(),
        limit: z.number().default(20),
      })
    )
    .query(async ({ input }) => {
      const versions = await db.query.documentVersions.findMany({
        where: eq(documentVersions.documentId, input.documentId),
        orderBy: desc(documentVersions.createdAt),
        limit: input.limit,
      });

      const [document] = await db
        .select({
          currentVersion: documents.currentVersion,
          lastSavedVersion: documents.lastSavedVersion,
        })
        .from(documents)
        .where(eq(documents.id, input.documentId))
        .limit(1);

      return {
        versions: versions.map((v) => ({
          id: v.id,
          version: v.version,
          message: v.message,
          createdBy: v.authorId,
          createdAt: v.createdAt,
        })),
        latest: {
          currentVersion: document?.currentVersion || 1,
          lastSavedVersion: document?.lastSavedVersion || 0,
        },
      };
    }),

  /**
   * Restore document to specific version
   */
  restoreVersion: protectedProcedure
    .input(
      z.object({
        documentId: z.string(),
        versionId: z.string(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const userId = requireUserId(ctx.userId);

      const version = await db.query.documentVersions.findFirst({
        where: eq(documentVersions.id, input.versionId),
      });

      if (!version) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Version not found",
        });
      }

      // Publish event for worker
      const { inngest } = await import("@synap/jobs");
      await inngest.send({
        name: "documents.restore.requested",
        data: {
          documentId: input.documentId,
          versionId: input.versionId,
          userId,
        },
        user: { id: userId },
      });

      return {
        status: "requested",
        message: "Restore requested",
      };
    }),

  /**
   * Get version preview
   */
  getVersionPreview: protectedProcedure
    .input(
      z.object({
        versionId: z.string(),
      })
    )
    .query(async ({ input }) => {
      const version = await db.query.documentVersions.findFirst({
        where: eq(documentVersions.id, input.versionId),
      });

      if (!version) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      return version;
    }),

  /**
   * Start editing session
   */
  startSession: protectedProcedure
    .input(z.object({ documentId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      const [document] = await db
        .select()
        .from(documents)
        .where(
          and(eq(documents.id, input.documentId), eq(documents.userId, userId))
        )
        .limit(1);

      if (!document) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Document not found",
        });
      }

      const chatThreadId = randomUUID();

      const [session] = await db
        .insert(documentSessions)
        .values({
          documentId: input.documentId,
          userId,
          chatThreadId,
          isActive: true,
          activeCollaborators: [{ type: "user", id: userId }],
        })
        .returning();

      return { sessionId: session.id, chatThreadId };
    }),

  /**
   * List user's documents
   */
  list: protectedProcedure
    .input(
      z.object({
        projectId: z.string().optional(),
        type: DocumentTypeSchema.optional(),
        limit: z.number().min(1).max(100).default(50),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      const conditions = [eq(documents.userId, userId)];
      if (input.projectId)
        conditions.push(eq(documents.projectId, input.projectId));
      if (input.type) conditions.push(eq(documents.type, input.type));

      const docs = await db
        .select()
        .from(documents)
        .where(and(...conditions))
        .orderBy(desc(documents.updatedAt))
        .limit(input.limit);

      return { documents: docs, total: docs.length };
    }),
});
