/**
 * Hub Protocol - Documents Router
 *
 * Thin wrapper around regular API endpoints.
 * Uses API key authentication but calls regular API internally
 * to ensure all operations go through the same infrastructure.
 */

import { z } from "zod";
import { randomUUID } from "crypto";
import { router } from "../../trpc.js";
import { scopedProcedure } from "../../middleware/api-key-auth.js";
import { TRPCError } from "@trpc/server";
import { documentsRouter as regularDocumentsRouter } from "../documents.js";
import { createHubProtocolCallerContext } from "./utils.js";
import {
  db,
  normalizeDocumentType,
  DocumentRepository,
  eventRepository,
  documents,
  and,
  eq,
  desc,
  drizzleSql,
  type CreateDocumentInput,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { auditLog } from "../../utils/audit-log.js";
import { emitSideEffects } from "@synap/events";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import { createEventBackedProposal } from "../../utils/event-backed-proposal.js";
import {
  resolveWriteIdempotencyKey,
  idempotencyWindowSeconds,
} from "../../utils/write-door-idempotency.js";

const logger = createLogger({ module: "hub-documents" });

export const documentsRouter = router({
  /**
   * Create a new document (B4)
   * Requires: hub-protocol.write scope
   *
   * AI governance: always goes through checkPermissionOrPropose.
   * If not whitelisted (default): creates a pending proposal with content stored
   * in JSONB — no MinIO write until the user approves.
   * If auto-approved: writes to MinIO and DB immediately.
   */
  createDocument: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        userId: z.string(),
        workspaceId: z.string().uuid().nullable().optional(),
        title: z.string().min(1),
        content: z.string().default(""),
        type: z
          .enum(["text", "markdown", "code", "html", "pdf", "docx"])
          .default("markdown"),
        // Optional external URL reference: when set, the document is a pointer
        // to an external resource (storageUrl = url, storageKey = NULL,
        // metadata.external = true) — no bytes are stored and no version
        // snapshot is taken. `content` is ignored for external references.
        // https-only: a stored URL may later render as a clickable link, so
        // reject javascript:/data:/file: schemes (same guard as discord.ts,
        // sync.ts, and shell.openExternal).
        url: z
          .string()
          .url()
          .refine((u) => u.startsWith("https://"), "url must be https")
          .optional(),
        reasoning: z.string().optional(),
        // agentUserId: the per-human agent user acting on behalf of userId.
        agentUserId: z.string().uuid().optional(),
        // Optional caller idempotency key. Absent → derived from the document's
        // stable content (title + type + content/url + workspace). A retry with
        // the same content returns the prior document instead of a second row.
        idempotencyKey: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.userId!;
      const documentId = randomUUID();
      // Prefer explicit agentUserId from request; API key owner is a system account.
      const agentUserId = input.agentUserId ?? userId;
      const correlationId = randomUUID();

      // ── ACK INTEGRITY (C1) — content-hash idempotency ─────────────────────────
      // The auto-approved path writes a real `documents` row with no proposal to
      // hash-dedup against, so a client-perceived-failure retry duplicated it.
      // Derive a stable key from the write's content and (best-effort) return a
      // prior row created under the same key within the window. The proposed path
      // is separately covered by the proposal SSOT's own agent hash-dedup; the key
      // is still stamped into the proposal + document so both are traceable.
      const idempotencyKey = resolveWriteIdempotencyKey(
        input.idempotencyKey,
        "create_document",
        {
          userId,
          workspaceId: input.workspaceId ?? null,
          title: input.title,
          type: input.type,
          content: input.content,
          url: input.url ?? null,
        }
      );
      try {
        const [priorDoc] = await db
          .select({ id: documents.id })
          .from(documents)
          .where(
            and(
              eq(documents.userId, userId),
              // In-DB cutoff (no bound JS Date — postgres.js 3.4.8 crashes on the
              // pod image; this lookup is best-effort so it would silently degrade).
              drizzleSql`${documents.createdAt} >= now() - (${idempotencyWindowSeconds()}::int * interval '1 second')`,
              drizzleSql`${documents.metadata} ->> 'idempotencyKey' = ${idempotencyKey}`
            )
          )
          .orderBy(desc(documents.createdAt))
          .limit(1);
        if (priorDoc) {
          return {
            id: priorDoc.id,
            documentId: priorDoc.id,
            status: "created" as const,
            ackState: "duplicate-ignored" as const,
            priorDocumentId: priorDoc.id,
          };
        }
      } catch (err) {
        // Best-effort — a lookup hiccup must never block a real write.
        logger.warn({ err, userId }, "document dedup lookup failed — writing");
      }
      const requestedEvent = await auditLog({
        subjectType: "document",
        action: "create",
        phase: "requested",
        subjectId: documentId,
        userId: agentUserId,
        workspaceId: input.workspaceId ?? undefined,
        correlationId,
        source: input.agentUserId ? "intelligence" : "api",
        data: {
          title: input.title,
          type: input.type,
          workspaceId: input.workspaceId ?? null,
          userId,
        },
      });

      // Governance check — AI agent creating a document requires proposal by default
      const perm = await checkPermissionOrPropose({
        userId: agentUserId,
        agentUserId,
        workspaceId: input.workspaceId ?? undefined,
        subjectType: "document",
        action: "create",
        source: "intelligence",
        reasoning: input.reasoning,
        correlationId,
        requestedEventId: requestedEvent?.id,
        sourceMessageId: ctx.sourceMessageId ?? undefined,
        sessionId: ctx.sessionId ?? undefined,
        data: {
          id: documentId,
          title: input.title,
          type: input.type,
          // Content stored inline — written to MinIO only when approved.
          // For an external URL reference, `url` is carried instead.
          content: input.content,
          url: input.url ?? null,
          workspaceId: input.workspaceId ?? null,
          userId,
          // Stamped so an approved proposal's document carries the same key (kept
          // stable across retries → the SSOT agent hash-dedup collapses replays).
          idempotencyKey,
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }

      if ("proposalId" in perm) {
        // Not auto-approved: content is stored in proposal JSONB.
        // MinIO upload happens in proposals.approve when the user accepts.
        // `deduped` = the proposal SSOT returned an existing identical proposal
        // (an idempotent replay), so report duplicate-ignored, not a fresh propose.
        return {
          id: documentId,
          documentId,
          status: "proposed" as const,
          ackState: perm.deduped
            ? ("duplicate-ignored" as const)
            : ("proposed" as const),
          proposalId: perm.proposalId,
          summary: perm.summary,
          reasoning: perm.reasoning,
          reviewPath: perm.reviewPath,
          reviewUrl: perm.reviewUrl,
          message: "Document creation proposed, awaiting approval",
        };
      }

      // External URL reference: no bytes to store. Create the documents row
      // pointing at the external URL (storageKey NULL, metadata.external) and
      // skip the MinIO upload + version snapshot entirely. Link via
      // entities.documentId like any document (caller's responsibility).
      const docRepo = new DocumentRepository(db, eventRepository);
      if (input.url) {
        // External reference: storageKey NULL, no bytes, no version snapshot.
        // Routed through the ONE document door (DocumentRepository.create) instead
        // of a raw insert. NOTE: create() emits `document.create.completed` itself
        // (source "api"), so the manual auditLog(completed, source:"intelligence")
        // is dropped to avoid a double completed event; agent authorship is now
        // carried on the row's provenance columns. Typesense emitSideEffects kept.
        const created = await docRepo.create(
          {
            id: documentId,
            title: input.title,
            type: normalizeDocumentType(
              input.type,
              "markdown"
            ) as CreateDocumentInput["type"],
            storageUrl: input.url,
            storageKey: null,
            size: 0,
            mimeType: null,
            metadata: { external: true, idempotencyKey },
            userId,
            workspaceId: input.workspaceId ?? null,
            createdByKind: "ai_agent",
            createdByUserId: userId,
            agentUserId: input.agentUserId,
            correlationId,
          },
          userId
        );

        emitSideEffects({
          subjectType: "document",
          action: "create",
          subjectId: created.id,
          userId: agentUserId,
        });

        return {
          id: created.id,
          documentId: created.id,
          status: "created" as const,
          ackState: "applied" as const,
        };
      }

      // Auto-approved (matches workspace autoApproveFor whitelist):
      // write to MinIO and DB immediately. The current-content object is uploaded
      // here, then DocumentRepository.create writes the row + the immutable v1
      // snapshot atomically (its `content` arg replaces the hand-inlined
      // uploadDocumentVersionSnapshot + documentVersions insert). create() also
      // emits `document.create.completed`, so the prior manual auditLog(completed)
      // is dropped to avoid a double completed event; Typesense emitSideEffects
      // kept.
      const { storage } = await import("@synap/storage");
      const docType = normalizeDocumentType(input.type, "markdown");
      const extension = docType === "markdown" ? "md" : docType;
      const content = input.content || "";
      const storageKey = storage.buildPath(
        userId,
        "document",
        documentId,
        extension
      );
      const metadata = await storage.upload(storageKey, content, {
        contentType: "text/markdown",
      });

      const created = await docRepo.create(
        {
          id: documentId,
          title: input.title,
          type: docType as CreateDocumentInput["type"],
          storageUrl: metadata.url,
          storageKey: metadata.path,
          size: metadata.size,
          mimeType: "text/markdown",
          metadata: { idempotencyKey },
          userId,
          workspaceId: input.workspaceId ?? null,
          content, // → writes the v1 document_versions snapshot
          createdByKind: "ai_agent",
          createdByUserId: userId,
          agentUserId: input.agentUserId,
          correlationId,
        },
        userId
      );

      emitSideEffects({
        subjectType: "document",
        action: "create",
        subjectId: created.id,
        userId: agentUserId,
      });

      return {
        id: created.id,
        documentId: created.id,
        status: "created" as const,
        ackState: "applied" as const,
      };
    }),

  /**
   * Get document content by ID
   * Requires: hub-protocol.read scope
   *
   * Calls regular API's documents.get endpoint internally
   */
  getDocument: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        documentId: z.string().uuid(),
        userId: z.string(),
      })
    )
    .query(async ({ input, ctx }) => {
      const callerContext = await createHubProtocolCallerContext(
        ctx.userId!,
        ctx.scopes || []
      );
      const caller = regularDocumentsRouter.createCaller(callerContext);

      const result = await caller.get({
        documentId: input.documentId,
      });

      return {
        document: {
          id: result.document.id,
          title: result.document.title,
          type: result.document.type,
          language: result.document.language,
          content: result.content,
          updatedAt: result.document.updatedAt,
          createdAt: result.document.createdAt,
        },
      };
    }),

  /**
   * Create document proposal (for AI edits to existing documents)
   * Requires: hub-protocol.write scope
   *
   * Specialized Hub Protocol operation for AI-generated edit proposals on
   * existing documents. Creates a pending proposal that the user reviews.
   * This is intentionally direct (creating the proposal IS the governed action).
   */
  createDocumentProposal: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        documentId: z.string().uuid(),
        userId: z.string(),
        agentUserId: z.string().uuid().optional(),
        threadId: z.string().uuid().optional(),
        sourceMessageId: z.string().uuid().optional(),
        proposalType: z
          .enum(["ai_edit", "user_suggestion", "review_comment"])
          .default("ai_edit"),
        changes: z.array(
          z.object({
            op: z.enum(["insert", "delete", "replace"]),
            position: z.number().optional(),
            range: z.tuple([z.number(), z.number()]).optional(),
            text: z.string().optional(),
          })
        ),
        proposedContent: z.string(),
        originalContent: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.userId!;
      const { db, eq } = await import("@synap/database");
      const { documents, entities } = await import("@synap/database/schema");

      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);

      const doc = await db.query.documents.findFirst({
        where: eq(documents.id, input.documentId),
      });

      if (!doc) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Document not found",
        });
      }
      if (doc.userId !== userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Access denied to document",
        });
      }

      const entity = await db.query.entities.findFirst({
        where: eq(entities.documentId, input.documentId),
      });

      const workspaceId = entity?.workspaceId ?? doc.workspaceId ?? null;

      const createdBy = input.agentUserId ?? userId;
      const sourceMessageId =
        input.sourceMessageId ?? ctx.sourceMessageId ?? undefined;
      const threadId = input.threadId ?? undefined;

      const sessionId = ctx.sessionId ?? undefined;
      const { proposal } = await createEventBackedProposal({
        userId,
        workspaceId,
        targetType: "document",
        targetId: input.documentId,
        proposalType: input.proposalType,
        action: "update",
        source: "intelligence",
        summary: "AI document edit proposal",
        agentUserId: input.agentUserId ?? null,
        createdBy,
        threadId: threadId ?? null,
        sourceMessageId: sourceMessageId ?? null,
        sessionId,
        expiresAt,
        data: {
          source: "agent",
          sourceId: createdBy,
          proposedBy: "ai",
          changes: input.changes,
          originalContent: input.originalContent,
          proposedContent: input.proposedContent,
          expiresAt: expiresAt.toISOString(),
        },
      });

      const { broadcastSuccess } = await import("@synap/jobs");
      await broadcastSuccess(userId, "ai:proposal", {
        proposalId: proposal.id,
        operation: "create",
      });

      const { buildProposalResponseFields } =
        await import("../../utils/permission-check.js");
      const envelope = buildProposalResponseFields({
        proposalId: proposal.id,
        subjectType: "document",
        action: input.proposalType,
        data: { id: input.documentId, title: doc.title },
      });

      return {
        status: "proposed",
        proposalId: proposal.id,
        summary: envelope.summary,
        reasoning: envelope.reasoning,
        reviewPath: envelope.reviewPath,
        reviewUrl: envelope.reviewUrl,
        message: "Document edit proposed, awaiting approval",
        requestId: proposal.id,
      };
    }),
});
