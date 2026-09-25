/**
 * Hub Protocol - Documents Router
 *
 * Thin wrapper around regular API endpoints.
 * Uses API key authentication but calls regular API internally
 * to ensure all operations go through the same infrastructure.
 */

import { z } from "zod";
import { decodeHtmlEntities } from "@synap-core/types/text";
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
import {
  resolveWriteIdempotencyKey,
  idempotencyWindowSeconds,
} from "../../utils/write-door-idempotency.js";

import { recordSessionArtifact } from "../../services/focus-sessions/record-session-artifact.js";
import {
  readSessionDocument,
  upsertSessionDocumentSection,
} from "../../services/session-document/upsert-section.js";
import {
  applyDocumentPatch,
  loadPatchDocument,
} from "../../services/document-patch/apply-document-patch.js";
import { DocumentPatchOpsSchema } from "../../services/document-patch/patch-ops.js";
import {
  DOCUMENT_READ_FORMATS,
  currentDiagnostics,
  projectAgentDocument,
} from "../../services/document-patch/read-document.js";

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
        /**
         * The declared session-output slot this document fulfils, exactly as
         * declared on `focus_sessions.expectedOutputs[].label`. Forwarded to
         * `recordSessionArtifact` — see `session-outputs.ts` for how it joins.
         * Never guessed when absent; governance's claim resolver still handles
         * name matches on the proposal path.
         */
        expectedLabel: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Decode an agent's XML-escaped title once, at the one door both MCP
      // (synap_create_document) and Hub REST call through — see
      // `entities/create.ts` for the full rationale.
      const decodedTitle = decodeHtmlEntities(input.title);
      if (decodedTitle !== input.title) input.title = decodedTitle;
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
        const { isJoinGate, proposedMessageFor } =
          await import("../../utils/permission-check.js");
        // JOIN GATE: no document proposal was filed at all (a workspace-join
        // request was filed instead), so the pre-allocated `documentId` can
        // never resolve. Same family as the PHANTOM ENVELOPE ID FIX in
        // `entities/create.ts`: an id that cannot resolve is worse than an
        // absent field.
        const joinGate = isJoinGate(perm.proposalType);
        return {
          ...(joinGate ? {} : { id: documentId, documentId }),
          status: "proposed" as const,
          proposalType: perm.proposalType,
          ackState: perm.deduped
            ? ("duplicate-ignored" as const)
            : ("proposed" as const),
          proposalId: perm.proposalId,
          summary: perm.summary,
          reasoning: perm.reasoning,
          reviewPath: perm.reviewPath,
          reviewUrl: perm.reviewUrl,
          message: proposedMessageFor(
            perm.proposalType,
            "Document creation proposed, awaiting approval"
          ),
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

        // OUTPUT LEDGER — see `record-session-artifact.ts`. Until this, a
        // document created inside a session was attributed to nothing:
        // `documents` has no sessionId column and `links` has no `document`
        // endpoint type, so the session that asked for it could not see it.
        await recordSessionArtifact({
          sessionId: ctx.sessionId,
          workspaceId: input.workspaceId,
          userId,
          kind: "document",
          refId: created.id,
          title: created.title,
          agentUserId: input.agentUserId,
          expectedLabel: input.expectedLabel,
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

      // OUTPUT LEDGER — same reason as the external-reference path above.
      await recordSessionArtifact({
        sessionId: ctx.sessionId,
        workspaceId: input.workspaceId,
        userId,
        kind: "document",
        refId: created.id,
        title: created.title,
        agentUserId: input.agentUserId,
        expectedLabel: input.expectedLabel,
      });

      return {
        id: created.id,
        documentId: created.id,
        status: "created" as const,
        ackState: "applied" as const,
      };
    }),

  /**
   * Get a document for an agent: its content (`format: raw` = the stored
   * markdown, `readable` = embeds replaced by their fallback), the `revision`
   * a guarded edit passes back as `baseRevision`, its top-level `sections`
   * (id, owner, heading) and `diagnostics` (what will not render).
   * Requires: hub-protocol.read scope. Access: `documents.get` (the read floor).
   */
  getDocument: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        documentId: z.string().uuid(),
        userId: z.string(),
        format: z.enum(DOCUMENT_READ_FORMATS).default("raw"),
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
      const doc = result.document;
      const raw = result.content ?? "";
      const diagnostics = await currentDiagnostics({
        documentId: doc.id,
        workspaceId: doc.workspaceId ?? null,
        metadata: doc.metadata,
        revision: doc.contentRevision,
        content: raw,
        readerUserId: ctx.userId!,
      });

      return {
        document: projectAgentDocument(doc, raw, input.format, diagnostics),
      };
    }),

  /**
   * Edit a document with ops — THE agent document edit door
   * (`services/document-patch/apply-document-patch.ts`). Applies, or files a
   * proposal, per governance; refuses stale bases, ambiguous `replace_text`,
   * agent changes to a person's section, and embed removal without
   * `allowRemovingEmbeds`. Requires: hub-protocol.write scope.
   */
  patchDocument: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        documentId: z.string().uuid(),
        agentUserId: z.string().uuid().optional(),
        baseRevision: z.number().int().min(0).optional(),
        ops: DocumentPatchOpsSchema,
        allowRemovingEmbeds: z.boolean().optional(),
        reasoning: z.string().max(2_000).optional(),
        sourceMessageId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input, ctx }) =>
      applyDocumentPatch({
        userId: ctx.userId!,
        // The authenticated agent key's identity when the body names none.
        agentUserId:
          input.agentUserId ?? (ctx.agentUserId as string | undefined) ?? null,
        documentId: input.documentId,
        ...(input.baseRevision !== undefined
          ? { baseRevision: input.baseRevision }
          : {}),
        ops: input.ops,
        allowRemovingEmbeds: input.allowRemovingEmbeds,
        reasoning: input.reasoning,
        sourceMessageId:
          input.sourceMessageId ?? ctx.sourceMessageId ?? undefined,
        provenanceSessionId: ctx.sessionId ?? null,
      })
    ),

  /**
   * Full-replacement edit — an ALIAS onto `patchDocument` with one
   * `replace_all` op (the shape REST `PATCH /documents/:id`,
   * `POST /documents/proposals`, MCP `synap_update_entity.content` and the IS
   * `update_document` content form send). Governed like every patch: an agent's
   * full replacement is always a proposal, and it may not change a person's
   * section or drop an embed. Without `baseRevision` the revision is pinned
   * HERE, at filing, so approval still refuses over a later human save.
   */
  createDocumentProposal: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        documentId: z.string().uuid(),
        userId: z.string(),
        agentUserId: z.string().uuid().optional(),
        sourceMessageId: z.string().uuid().optional(),
        proposedContent: z.string(),
        baseRevision: z.number().int().min(0).optional(),
        allowRemovingEmbeds: z.boolean().optional(),
        reasoning: z.string().max(2_000).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.userId!;
      const baseRevision =
        input.baseRevision ??
        (await loadPatchDocument(input.documentId)).contentRevision;
      return applyDocumentPatch({
        userId,
        agentUserId:
          input.agentUserId ?? (ctx.agentUserId as string | undefined) ?? null,
        documentId: input.documentId,
        baseRevision,
        ops: [{ op: "replace_all", content: input.proposedContent }],
        allowRemovingEmbeds: input.allowRemovingEmbeds,
        reasoning: input.reasoning,
        sourceMessageId:
          input.sourceMessageId ?? ctx.sourceMessageId ?? undefined,
        provenanceSessionId: ctx.sessionId ?? null,
      });
    }),

  /**
   * The session's designated document: id, current version (the `baseVersion`
   * a section write must pass), content, and each section's owner + stamps.
   */
  getSessionDocument: scopedProcedure(["hub-protocol.read"])
    .input(z.object({ sessionId: z.string().uuid() }))
    .query(async ({ input, ctx }) =>
      readSessionDocument({ sessionId: input.sessionId, userId: ctx.userId! })
    ),

  /**
   * Write ONE section of the session's document (see
   * `services/session-document/upsert-section.ts`). Applies, or files a
   * proposal, per governance; refuses human-owned sections and stale bases.
   */
  upsertSessionSection: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        sessionId: z.string().uuid(),
        agentUserId: z.string().uuid().optional(),
        sectionId: z.string().min(1).max(64),
        title: z.string().min(1).max(200),
        body: z.string().max(100_000),
        baseVersion: z.number().int().min(1).nullable(),
        baseRevision: z.number().int().min(0).optional(),
        reasoning: z.string().max(2_000).optional(),
        sourceMessageId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input, ctx }) =>
      upsertSessionDocumentSection({
        userId: ctx.userId!,
        // The authenticated agent key's identity when the body names none — a
        // body-only agent id is how agent writes previously ran as the human.
        agentUserId:
          input.agentUserId ?? (ctx.agentUserId as string | undefined) ?? null,
        sessionId: input.sessionId,
        ambientSessionId: ctx.sessionId ?? null,
        sectionId: input.sectionId,
        title: input.title,
        body: input.body,
        baseVersion: input.baseVersion,
        ...(input.baseRevision !== undefined
          ? { baseRevision: input.baseRevision }
          : {}),
        reasoning: input.reasoning,
        sourceMessageId:
          input.sourceMessageId ?? ctx.sourceMessageId ?? undefined,
      })
    ),
});
