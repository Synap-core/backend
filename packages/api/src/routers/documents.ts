/**
 * Documents Router
 * Handles document upload, retrieval, updates, and collaborative sessions
 *
 * Architecture: Synchronous CRUD
 * - All operations are direct DB + storage calls
 * - Audit logging via events table (fire-and-forget)
 * - Side-effects (search indexing, webhooks) via pg-boss queue
 */

import { z } from "zod";
import {
  podAdminProcedure,
  protectedProcedure,
  router,
  workspaceProcedure,
} from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { storage } from "@synap/storage";
import {
  db,
  eq,
  and,
  or,
  desc,
  ilike,
  isNotNull,
  isNull,
  documents,
  documentVersions,
  documentSessions,
  normalizeDocumentType,
} from "@synap/database";

import { requireUserId } from "../utils/user-scoped.js";
import { randomUUID } from "crypto";
import { auditLog } from "../utils/audit-log.js";
import { emitSideEffects, getBoss } from "@synap/events";

// ============================================================================
// SCHEMAS
// ============================================================================

const DocumentTypeSchema = z.enum([
  "text",
  "markdown",
  "code",
  "html",
  "pdf",
  "docx",
]);

function mimeTypeForDocType(type: string): string {
  const map: Record<string, string> = {
    markdown: "text/markdown",
    html: "text/html",
    code: "text/plain",
    text: "text/plain",
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
  return map[type] ?? "text/plain";
}

const UploadDocumentSchema = z.object({
  type: DocumentTypeSchema,
  content: z.string(),
  title: z.string().optional(),
  language: z.string().optional(),
  mimeType: z.string().optional(),
  projectId: z.string().uuid().optional(),
  /** Optional: when omitted, uses X-Workspace-Id header (workspaceLink). */
  workspaceId: z.string().uuid().optional(),
});

const UpdateDocumentSchema = z.object({
  documentId: z.string(),
  delta: z
    .array(
      z.object({
        content: z.string(),
      })
    )
    .optional(),
  version: z.number().int().positive().optional(),
  message: z.string().optional(),
  title: z.string().optional(),
});

const CreateDocumentSchema = z.object({
  title: z.string().min(1),
  content: z.string().default(""),
  type: DocumentTypeSchema.default("markdown"),
  projectId: z.string().uuid().optional(),
  /** Optional: when omitted, uses X-Workspace-Id header (workspaceLink). */
  workspaceId: z.string().uuid().optional(),
});

// ============================================================================
// ROUTER
// ============================================================================

export const documentsRouter = router({
  /**
   * Create a new empty document.
   * Synchronous: inserts directly into DB + MinIO so the document ID is
   * immediately usable by the frontend (no event-pipeline race condition).
   */
  create: workspaceProcedure
    .input(CreateDocumentSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const workspaceId = input.workspaceId ?? ctx.workspaceId ?? null;
      if (!workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Workspace ID required. Pass workspaceId or set active workspace (X-Workspace-Id).",
        });
      }
      const documentId = randomUUID();
      const docType = normalizeDocumentType(input.type, "markdown");
      const extension = docType === "markdown" ? "md" : docType;
      const storageKey = storage.buildPath(
        userId,
        "document",
        documentId,
        extension
      );

      // 1. Upload content to MinIO
      const content = input.content || "";
      const resolvedMimeType = mimeTypeForDocType(docType);
      const metadata = await storage.upload(storageKey, content, {
        contentType: resolvedMimeType,
      });

      // 2. Insert document into DB
      const [document] = await db
        .insert(documents)
        .values({
          id: documentId,
          userId,
          workspaceId,
          title: input.title,
          type: docType as
            | "text"
            | "markdown"
            | "code"
            | "html"
            | "pdf"
            | "docx",
          storageUrl: metadata.url,
          storageKey: metadata.path,
          size: metadata.size,
          mimeType: resolvedMimeType,
          currentVersion: 1,
        })
        .returning();

      return {
        status: "created",
        message: "Document created",
        document: {
          id: document.id,
          title: document.title,
        },
      };
    }),

  /**
   * Upload a new document.
   * Synchronous: inserts directly into DB + MinIO.
   */
  upload: workspaceProcedure
    .input(UploadDocumentSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const workspaceId = input.workspaceId ?? ctx.workspaceId ?? null;
      if (!workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Workspace ID required. Pass workspaceId or set active workspace (X-Workspace-Id).",
        });
      }
      const documentId = randomUUID();
      const docType = normalizeDocumentType(input.type, "markdown");
      const extension = docType === "markdown" ? "md" : docType;
      const mimeType = input.mimeType || "text/plain";
      const storageKey = storage.buildPath(
        userId,
        "document",
        documentId,
        extension
      );

      // 1. Upload content to MinIO
      const metadata = await storage.upload(storageKey, input.content, {
        contentType: mimeType,
      });

      // 2. Insert document into DB
      const [document] = await db
        .insert(documents)
        .values({
          id: documentId,
          userId,
          workspaceId,
          title: input.title || "Untitled",
          type: docType as "text" | "markdown" | "code" | "pdf" | "docx",
          language: input.language || undefined,
          storageUrl: metadata.url,
          storageKey: metadata.path,
          size: metadata.size,
          mimeType,
          currentVersion: 1,
        })
        .returning();

      return {
        status: "created",
        message: "Document uploaded",
        documentId: document.id,
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

      // All documents use MinIO storage (unified approach)
      // Current content is always in storage, versions are snapshots in database
      const contentBuffer = await storage.downloadBuffer(document.storageKey!);
      const content =
        document.type === "pdf" || document.type === "docx"
          ? contentBuffer.toString("base64")
          : contentBuffer.toString("utf-8");

      return { document, content };
    }),

  /**
   * Update document (Synchronous: Direct DB + Storage)
   */
  update: protectedProcedure
    .input(UpdateDocumentSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      // 1. Verify existence & authorization ownership
      const [document] = await db
        .select()
        .from(documents)
        .where(
          and(eq(documents.id, input.documentId), eq(documents.userId, userId))
        )
        .limit(1);

      if (!document) {
        console.warn(
          `[documents.update] 404 — documentId=${input.documentId} userId=${userId}`
        );
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Document not found",
        });
      }

      // 2. Direct storage update for legacy content path
      // NOTE: Primary content editing should go through Yjs realtime (WebSocket),
      // not through this tRPC endpoint. This path exists for non-realtime updates only.
      if (input.delta) {
        const newContent = input.delta[0]?.content || "";
        await storage.upload(
          document.storageKey!,
          Buffer.from(newContent, "utf-8"),
          { contentType: document.mimeType || "text/plain" }
        );
      }

      // 3. Direct DB update for metadata (title)
      // Version is NOT incremented here — versioning is handled by the snapshot system
      // (manual save, auto-save cron, session close). This prevents version inflation
      // from per-keystroke or frequent metadata updates.
      const updateFields: Record<string, unknown> = {
        updatedAt: new Date(),
      };
      if (input.title) {
        updateFields.title = input.title;
      }

      await db
        .update(documents)
        .set(updateFields)
        .where(eq(documents.id, input.documentId));

      // 4. Audit log (fire-and-forget)
      auditLog({
        subjectType: "document",
        action: "update",
        phase: "completed",
        subjectId: input.documentId,
        userId,
        data: {
          id: input.documentId,
          title: input.title || document.title,
          message: input.message,
        },
      });

      // 5. Side-effects (search indexing, webhooks — fire-and-forget)
      emitSideEffects({
        subjectType: "document",
        action: "update",
        subjectId: input.documentId,
        userId,
        data: {
          id: input.documentId,
          title: input.title || document.title,
        },
      });

      // 6. Response
      return { version: document.currentVersion, success: true };
    }),

  /**
   * Delete document (Synchronous: Direct DB + Storage delete)
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

      // 1. Delete from DB
      await db.delete(documents).where(eq(documents.id, input.documentId));

      // 2. Delete from storage
      await storage.delete(document.storageKey!);

      // 3. Audit log (fire-and-forget)
      auditLog({
        subjectType: "document",
        action: "delete",
        phase: "completed",
        subjectId: input.documentId,
        userId,
        data: { id: input.documentId },
      });

      // 4. Side-effects (search de-index, webhooks — fire-and-forget)
      emitSideEffects({
        subjectType: "document",
        action: "delete",
        subjectId: input.documentId,
        userId,
        data: { id: input.documentId },
      });

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

      // Enqueue snapshot job via pg-boss
      await getBoss().send("document-snapshot", {
        documentId: input.documentId,
        message: input.message,
        userId,
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

      // Enqueue restore job via pg-boss
      await getBoss().send("document-restore", {
        documentId: input.documentId,
        versionId: input.versionId,
        userId,
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
   *
   * Creates working version N+1 when realtime session starts (N+1 versioning pattern).
   * This ensures the saved version (N) stays immutable while edits go to working version (N+1).
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
        console.warn(
          `[documents.startSession] 404 — documentId=${input.documentId} userId=${userId}`
        );
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Document not found",
        });
      }

      // Session tracking only — no version bump on start.
      // Versions are created when the editing session ends (room close)
      // or on explicit save (Cmd+S / auto-save cron).
      const channelId = randomUUID();

      const [session] = await db
        .insert(documentSessions)
        .values({
          documentId: input.documentId,
          userId,
          channelId,
          isActive: true,
          activeCollaborators: [{ type: "user", id: userId }],
        })
        .returning();

      return { sessionId: session.id, channelId };
    }),

  /**
   * End editing session
   *
   * Marks the session as inactive. The Yjs server handles version snapshot
   * creation when all users disconnect from the room (all-document-connections-closed).
   * This endpoint is for explicit session cleanup from the client.
   */
  endSession: protectedProcedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      const session = await db.query.documentSessions.findFirst({
        where: and(
          eq(documentSessions.id, input.sessionId),
          eq(documentSessions.userId, userId)
        ),
      });

      if (!session) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Session not found",
        });
      }

      if (!session.isActive) {
        return { success: true, alreadyEnded: true };
      }

      await db
        .update(documentSessions)
        .set({
          isActive: false,
          endedAt: new Date(),
        })
        .where(eq(documentSessions.id, input.sessionId));

      return { success: true };
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
      if (input.type) {
        conditions.push(eq(documents.type, input.type));
      }

      const docs = await db
        .select()
        .from(documents)
        .where(and(...conditions))
        .orderBy(desc(documents.updatedAt))
        .limit(input.limit);

      return { documents: docs, total: docs.length };
    }),

  /**
   * List documents in the active workspace (any member).
   * When `markdownOnly` is true (default), returns markdown/text and titles ending in .md / .markdown, file-backed only.
   */
  listInWorkspace: workspaceProcedure
    .input(
      z.object({
        markdownOnly: z.boolean().default(true),
        limit: z.number().min(1).max(200).default(100),
      })
    )
    .query(async ({ ctx, input }) => {
      const workspaceId = ctx.workspaceId;
      if (!workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Workspace ID required (X-Workspace-Id).",
        });
      }

      const base = and(
        eq(documents.workspaceId, workspaceId),
        isNull(documents.deletedAt),
        isNotNull(documents.storageKey)
      );

      const markdownish = or(
        eq(documents.type, "markdown"),
        eq(documents.type, "text"),
        ilike(documents.title, "%.md"),
        ilike(documents.title, "%.markdown")
      );

      const docs = await db
        .select({
          id: documents.id,
          title: documents.title,
          type: documents.type,
          mimeType: documents.mimeType,
          updatedAt: documents.updatedAt,
          createdAt: documents.createdAt,
          size: documents.size,
          userId: documents.userId,
        })
        .from(documents)
        .where(input.markdownOnly ? and(base, markdownish) : base)
        .orderBy(desc(documents.updatedAt))
        .limit(input.limit);

      return { documents: docs, total: docs.length };
    }),

  /**
   * Read document body for admin preview. Workspace members; UTF-8 text / markdown only (no PDF/DOCX).
   */
  getInWorkspace: workspaceProcedure
    .input(z.object({ documentId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const workspaceId = ctx.workspaceId;
      if (!workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Workspace ID required (X-Workspace-Id).",
        });
      }

      const [document] = await db
        .select()
        .from(documents)
        .where(
          and(
            eq(documents.id, input.documentId),
            eq(documents.workspaceId, workspaceId),
            isNull(documents.deletedAt)
          )
        )
        .limit(1);

      if (!document) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Document not found in this workspace.",
        });
      }

      if (!document.storageKey) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "This document has no file storage (e.g. whiteboard). Open it in Synap Browser.",
        });
      }

      if (document.type === "pdf" || document.type === "docx") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Admin preview does not support PDF or Word files.",
        });
      }

      const title = document.title ?? "";
      const allowedType =
        document.type === "markdown" ||
        document.type === "text" ||
        document.type === "code" ||
        /\.md$/i.test(title) ||
        /\.markdown$/i.test(title);

      if (!allowedType) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Admin preview supports markdown, plain text, and code files only.",
        });
      }

      const contentBuffer = await storage.downloadBuffer(document.storageKey);
      const content = contentBuffer.toString("utf-8");

      return {
        document: {
          id: document.id,
          title: document.title,
          type: document.type,
          language: document.language,
          mimeType: document.mimeType,
          updatedAt: document.updatedAt,
        },
        content,
      };
    }),

  /**
   * Pod-admin document listing across all workspaces.
   * Markdown-safe mode focuses on markdown/text files.
   */
  listGlobal: podAdminProcedure
    .input(
      z.object({
        markdownOnly: z.boolean().default(true),
        limit: z.number().min(1).max(500).default(200),
      })
    )
    .query(async ({ input }) => {
      const base = and(
        isNull(documents.deletedAt),
        isNotNull(documents.storageKey)
      );

      const markdownish = or(
        eq(documents.type, "markdown"),
        eq(documents.type, "text"),
        ilike(documents.title, "%.md"),
        ilike(documents.title, "%.markdown")
      );

      const docs = await db
        .select({
          id: documents.id,
          title: documents.title,
          type: documents.type,
          mimeType: documents.mimeType,
          updatedAt: documents.updatedAt,
          createdAt: documents.createdAt,
          size: documents.size,
          userId: documents.userId,
          workspaceId: documents.workspaceId,
        })
        .from(documents)
        .where(input.markdownOnly ? and(base, markdownish) : base)
        .orderBy(desc(documents.updatedAt))
        .limit(input.limit);

      return { documents: docs, total: docs.length };
    }),

  /**
   * Pod-admin text/markdown preview across all workspaces.
   */
  getGlobal: podAdminProcedure
    .input(z.object({ documentId: z.string().uuid() }))
    .query(async ({ input }) => {
      const [document] = await db
        .select()
        .from(documents)
        .where(
          and(eq(documents.id, input.documentId), isNull(documents.deletedAt))
        )
        .limit(1);

      if (!document) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Document not found.",
        });
      }

      if (!document.storageKey) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "This document has no file storage (e.g. whiteboard). Open it in Synap Browser.",
        });
      }

      if (document.type === "pdf" || document.type === "docx") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Admin preview does not support PDF or Word files.",
        });
      }

      const title = document.title ?? "";
      const allowedType =
        document.type === "markdown" ||
        document.type === "text" ||
        document.type === "code" ||
        /\.md$/i.test(title) ||
        /\.markdown$/i.test(title);

      if (!allowedType) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Admin preview supports markdown, plain text, and code files only.",
        });
      }

      const contentBuffer = await storage.downloadBuffer(document.storageKey);
      const content = contentBuffer.toString("utf-8");

      return {
        document: {
          id: document.id,
          title: document.title,
          type: document.type,
          language: document.language,
          mimeType: document.mimeType,
          updatedAt: document.updatedAt,
          workspaceId: document.workspaceId,
          userId: document.userId,
        },
        content,
      };
    }),
});
