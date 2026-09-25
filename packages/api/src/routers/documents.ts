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
  podProcedure,
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
  storedVersionValues,
  uploadDocumentVersionSnapshot,
  readDocumentVersionContent,
  claimDocumentRevision,
  EntityBodyService,
  eventRepository,
  resolveWorkspacePlacement,
} from "@synap/database";

import { requireUserId } from "../utils/user-scoped.js";
import { resolveActorNames } from "../utils/resolve-actor-names.js";
import { assertWorkspaceWrite } from "../utils/workspace-write-access.js";
import {
  canEditDocument,
  loadEditableDocument,
  loadReadableDocument,
} from "../utils/document-edit-access.js";
import { recordSessionArtifact } from "../services/focus-sessions/record-session-artifact.js";
import { accessScopeWhere } from "../utils/project-scope.js";
import { paginatedInput, buildPaginatedResponse } from "../utils/pagination.js";
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
  /**
   * The `content_revision` the editor last loaded or saved. Present ⇒ the save
   * is refused (CONFLICT) when anything else wrote the document since — an
   * approved AI edit, a restore, another editor. Absent ⇒ unchecked.
   */
  baseRevision: z.number().int().positive().optional(),
  /**
   * The realtime room's leader writing the room's content back as markdown
   * (D-collab). Marks the room's Yjs cache as current for the new revision.
   */
  collab: z.boolean().optional(),
  message: z.string().optional(),
  title: z.string().optional(),
});

const CreateDocumentSchema = z.object({
  title: z.string().min(1),
  content: z.string().default(""),
  type: DocumentTypeSchema.default("markdown"),
  /** Optional: when omitted, uses X-Workspace-Id header (workspaceLink). */
  workspaceId: z.string().uuid().optional(),
  /**
   * The declared session-output slot this document fulfils, exactly as declared
   * on `focus_sessions.expectedOutputs[].label`. Forwarded to
   * `recordSessionArtifact` below, never guessed when absent.
   *
   * DOOR PARITY with the Hub twin (`hub-protocol/documents.ts createDocument`),
   * which has carried it since the Output-Loop W5 wave. Until now the HUMAN
   * door could not claim a slot at all: a person working in a session and
   * writing the document they were asked for produced an object the session
   * could not join to the deliverable — the exact gap `expectedLabel` exists to
   * close, left open on the door people actually use.
   */
  expectedLabel: z.string().min(1).max(500).optional(),
  /**
   * "Duplicate as new document" (D-branch: no branches, forks keep lineage).
   * The source must be a document the caller can READ; its revision at the
   * moment of the copy is read here, never taken from the client. Stored on
   * `metadata.duplicatedFrom = { documentId, revision }`.
   */
  duplicatedFrom: z.object({ documentId: z.string().uuid() }).optional(),
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
  create: podProcedure
    .input(CreateDocumentSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      // Placement via the ONE door (no 400): an explicit input/header workspace
      // wins (rung 1); with no signal a document lands pod-wide — documents are
      // pod-wide-natured and the MinIO path keys on userId, not workspace.
      const placement = await resolveWorkspacePlacement(db, {
        userId,
        explicitWorkspaceId: input.workspaceId ?? ctx.workspaceId ?? undefined,
        ambientWorkspaceId: ctx.workspaceId ?? null,
      });
      const workspaceId = placement.workspaceId;
      // podProcedure dropped workspaceProcedure's membership gate — re-assert the
      // write on the RESOLVED workspace (editor+ for a workspace row; the owner
      // for a pod-wide row), never a request-supplied id.
      await assertWorkspaceWrite(db, userId, { workspaceId, ownerId: userId });
      // Lineage only to a document the caller may read (NOT_FOUND otherwise),
      // so a copy can never point at someone else's hidden document.
      const duplicatedFrom = input.duplicatedFrom
        ? await loadReadableDocument(
            userId,
            input.duplicatedFrom.documentId
          ).then((source) => ({
            documentId: source.id,
            revision: source.contentRevision,
          }))
        : null;
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
      const versionId = randomUUID();
      const snapshot = await uploadDocumentVersionSnapshot({
        userId,
        documentId,
        versionId,
        documentType: docType,
        mimeType: resolvedMimeType,
        content,
      });

      // 2. Insert document + immutable v1 snapshot into DB
      const [document] = await db.transaction(async (tx) => {
        const [doc] = await tx
          .insert(documents)
          .values({
            id: documentId,
            userId,
            workspaceId,
            title: input.title,
            type: docType,
            storageUrl: metadata.url,
            storageKey: metadata.path,
            size: metadata.size,
            mimeType: resolvedMimeType,
            currentVersion: 1,
            lastSavedVersion: 1,
            ...(duplicatedFrom ? { metadata: { duplicatedFrom } } : {}),
          })
          .returning();

        await tx.insert(documentVersions).values({
          id: versionId,
          documentId,
          version: 1,
          ...storedVersionValues(snapshot),
          author: "user",
          authorId: userId,
          message: "Initial version",
        });

        return [doc];
      });

      // OUTPUT LEDGER — the same writer the Hub twin and `entities.create` use.
      // `ctx.sessionId` is the VERIFIED header handle (`resolveHubSessionHeader`
      // rejects a session that is not the caller's), so this can only ever
      // attribute to the caller's own session; absent ⇒ the recorder no-ops on
      // its first line and nothing is written.
      await recordSessionArtifact({
        sessionId: ctx.sessionId,
        workspaceId,
        userId,
        kind: "document",
        refId: document.id,
        title: document.title,
        expectedLabel: input.expectedLabel,
      });

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
  upload: podProcedure
    .input(UploadDocumentSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      // Placement via the ONE door (no 400): an explicit input/header workspace
      // wins (rung 1); with no signal an uploaded document lands pod-wide — the
      // MinIO path keys on userId, so nothing storage-related needs the workspace.
      const placement = await resolveWorkspacePlacement(db, {
        userId,
        explicitWorkspaceId: input.workspaceId ?? ctx.workspaceId ?? undefined,
        ambientWorkspaceId: ctx.workspaceId ?? null,
      });
      const workspaceId = placement.workspaceId;
      // podProcedure dropped workspaceProcedure's membership gate — re-assert the
      // write on the RESOLVED workspace, never a request-supplied id.
      await assertWorkspaceWrite(db, userId, { workspaceId, ownerId: userId });
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
      const versionId = randomUUID();
      const snapshot = await uploadDocumentVersionSnapshot({
        userId,
        documentId,
        versionId,
        documentType: docType,
        mimeType,
        content: input.content,
      });

      // 2. Insert document + immutable v1 snapshot into DB
      const [document] = await db.transaction(async (tx) => {
        const [doc] = await tx
          .insert(documents)
          .values({
            id: documentId,
            userId,
            workspaceId,
            title: input.title || "Untitled",
            type: docType,
            language: input.language || undefined,
            storageUrl: metadata.url,
            storageKey: metadata.path,
            size: metadata.size,
            mimeType,
            currentVersion: 1,
            lastSavedVersion: 1,
          })
          .returning();

        await tx.insert(documentVersions).values({
          id: versionId,
          documentId,
          version: 1,
          ...storedVersionValues(snapshot),
          author: "user",
          authorId: userId,
          message: "Initial version",
        });

        return [doc];
      });

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

      // The documents read floor (owner, workspace member, exposure) — the
      // same predicate the edit gate builds on, so a reader and an editor can
      // never disagree about which document they are looking at.
      const document = await loadReadableDocument(userId, input.documentId);

      // Read the body via the 3-state resolver (never non-null-asserts
      // `storageKey` — fixes B2, where an external-URL reference document
      // [storageKey NULL, storageUrl set] crashed here on `storageKey!`).
      //   - stored bytes → base64 for pdf/docx, else utf-8 (behavior-preserving)
      //   - external ref → the URL string (previously an unreadable crash)
      //   - inline       → the latest version's inline content
      const entityBodyService = new EntityBodyService(db, eventRepository);
      const body = await entityBodyService.getBytes(input.documentId);
      let content = "";
      if (body?.kind === "bytes") {
        content =
          document.type === "pdf" || document.type === "docx"
            ? body.buffer.toString("base64")
            : body.buffer.toString("utf-8");
      } else if (body?.kind === "external") {
        content = body.url;
      } else if (body?.kind === "inline") {
        content = body.content;
      }

      // Edit rights by the document's own floor — the SAME gate every write
      // uses — so the surface never offers an edit the pod would refuse.
      // Only FORBIDDEN reads as false; a failed membership read fails the get.
      const canEdit = await canEditDocument(userId, document);

      return { document, content, canEdit };
    }),

  /**
   * Update document (Synchronous: Direct DB + Storage)
   */
  update: protectedProcedure
    .input(UpdateDocumentSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      // 1. Edit rights follow the document's own floor (workspace editor+,
      //    or the owner of a pod-wide document).
      const document = await loadEditableDocument(userId, input.documentId);

      // 2. Content goes through the ONE content-write door: compare-and-set on
      //    the content revision, author-switch checkpoint, storage upload.
      let revision = document.contentRevision;
      if (input.delta) {
        const newContent = input.delta[0]?.content || "";
        const claimed = await db.transaction((tx) =>
          claimDocumentRevision(
            tx,
            input.documentId,
            input.baseRevision,
            { authorKind: "user", authorId: userId },
            {
              content: newContent,
              ...(input.collab ? { source: "collab-writeback" as const } : {}),
            }
          )
        );
        revision = claimed.revision;
      }

      // 3. Metadata (title). A same-author save cuts no checkpoint (the
      //    door above only cuts one on an author switch), so saves do not
      //    inflate the history rail.
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
        workspaceId: document.workspaceId,
        data: {
          id: input.documentId,
          title: input.title || document.title,
        },
      });

      // 6. Response — `revision` is the editor's next `baseRevision`.
      return { version: document.currentVersion, revision, success: true };
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

      const versions = await db.query.documentVersions.findMany({
        where: eq(documentVersions.documentId, input.documentId),
      });

      // 1. Delete from DB
      await db.delete(documents).where(eq(documents.id, input.documentId));

      // 2. Delete from storage
      if (document.storageKey) {
        await storage.delete(document.storageKey);
      }
      await Promise.allSettled(
        versions
          .map((version) => version.storageKey)
          .filter((key): key is string => !!key)
          .map((key) => storage.delete(key))
      );

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

      // Gate on edit rights BEFORE enqueuing — the worker trusts the payload
      // userId, so the check must happen here.
      await loadEditableDocument(userId, input.documentId);

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
    .query(async ({ input, ctx }) => {
      // Gate on the parent document's read floor BEFORE listing versions —
      // document_versions has no own user/workspace, so this is the only guard.
      const document = await loadReadableDocument(
        requireUserId(ctx.userId),
        input.documentId
      );

      const versions = await db.query.documentVersions.findMany({
        where: eq(documentVersions.documentId, input.documentId),
        orderBy: desc(documentVersions.createdAt),
        limit: input.limit,
      });
      // The author's display name — an agent is rarely a workspace member, so
      // the rail cannot name it from the member list alone.
      const authorNames = await resolveActorNames(
        versions.map((v) => v.authorId)
      );

      return {
        versions: versions.map((v) => ({
          id: v.id,
          version: v.version,
          message: v.message,
          // Provenance: 'user' | 'ai' | 'system' (declared in the schema). The
          // version rail reads this to say who drafted a version.
          author: v.author,
          createdBy: v.authorId,
          authorName: authorNames.get(v.authorId) ?? null,
          createdAt: v.createdAt,
          size: v.size,
          mimeType: v.mimeType,
          checksum: v.checksum,
          hasStoredSnapshot: !!v.storageKey,
        })),
        latest: {
          currentVersion: document.currentVersion,
          lastSavedVersion: document.lastSavedVersion,
          revision: document.contentRevision,
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

      // Gate on edit rights BEFORE enqueuing — the worker overwrites the
      // document's content trusting the payload. Also confirm the version
      // actually belongs to the target document.
      await loadEditableDocument(userId, input.documentId);
      if (version.documentId !== input.documentId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Document not found",
        });
      }
      // A row the realtime server once wrote holds Yjs binary state, not text.
      // Restoring it would write base64 over the markdown body.
      if (version.content.startsWith("yjs:")) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "This version holds realtime editor state, not the document text, so it cannot be restored. Pick another version.",
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
    .query(async ({ input, ctx }) => {
      const version = await db.query.documentVersions.findFirst({
        where: eq(documentVersions.id, input.versionId),
      });

      if (!version) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      // Verify the caller may read the parent document before returning
      // content (the version row carries no user/workspace of its own).
      await loadReadableDocument(requireUserId(ctx.userId), version.documentId);

      const content = await readDocumentVersionContent(version);

      return {
        ...version,
        content,
      };
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

      // An editing session is an editing act: the same edit-rights floor.
      await loadEditableDocument(userId, input.documentId);

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
      paginatedInput.extend({
        type: DocumentTypeSchema.optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      // USER FLOOR (not eq(userId)): a document in a workspace the user belongs
      // to is visible even when owned by another member. accessScopeWhere is the
      // DATA-table resolver — it owner-gates NULL-workspace (pod-personal) rows,
      // so a personal doc never leaks pod-wide, while shared-workspace docs are
      // included. No lens here = the full floor; a workspace lens would narrow.
      const conditions = [
        accessScopeWhere({
          workspaceIdColumn: documents.workspaceId,
          entityIdColumn: documents.id,
          ownerColumn: documents.userId,
          userId,
          // Same floor as the registered `documents` rule: a document follows
          // its pod-shared entity.
          documentFollowsEntity: true,
        }),
      ];
      if (input.type) {
        conditions.push(eq(documents.type, input.type));
      }

      const docs = await db
        .select()
        .from(documents)
        .where(and(...conditions))
        .orderBy(desc(documents.updatedAt))
        .limit(input.limit + 1)
        .offset(input.offset);

      const { items, pagination } = buildPaginatedResponse(docs, input);

      return {
        documents: items,
        total: items.length,
        pagination,
      };
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
