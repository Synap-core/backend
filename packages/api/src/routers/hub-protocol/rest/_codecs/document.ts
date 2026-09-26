/**
 * Document Wire Codecs — Hub Protocol REST schemas for documents (Yjs-backed).
 */

import { z } from "@hono/zod-openapi";
import { DocumentPatchOpsSchema } from "../../../../services/document-patch/patch-ops.js";
import { DOCUMENT_READ_FORMATS } from "../../../../services/document-patch/read-document.js";
import { uuidQueryParam } from "./_openapi.js";

export const DocumentTypeSchema = z
  .enum(["text", "markdown", "code", "html", "pdf", "docx"])
  .openapi("DocumentType");

/** Wire shape of a document row. */
export const WireDocumentSchema = z
  .object({
    id: z.string(),
    userId: z.string(),
    workspaceId: z.string().nullable().optional(),
    title: z.string(),
    content: z.string().optional(),
    type: DocumentTypeSchema.optional(),
    createdAt: z.union([z.string(), z.date()]).optional(),
    updatedAt: z.union([z.string(), z.date()]).optional(),
  })
  .passthrough()
  .openapi("Document");

/** POST /documents request body. */
export const CreateDocumentRequestSchema = z
  .object({
    userId: z.string(),
    workspaceId: uuidQueryParam.nullable().optional(),
    title: z.string(),
    content: z.string().optional(),
    type: DocumentTypeSchema.optional(),
    reasoning: z.string().optional(),
    agentUserId: z.string().optional(),
    sourceMessageId: z.string().optional(),
    sessionId: z.string().optional(),
    /** The declared session-output slot this document fulfils, by label. */
    expectedLabel: z.string().optional(),
    /** External https reference: a pointer document, no stored bytes. */
    url: z.string().optional(),
    /**
     * Attach the created document as this entity's body — a governed entity
     * update, reported on the response as `attached`.
     */
    entityId: z.string().optional(),
    /** A retry with the same key returns the prior document. */
    idempotencyKey: z.string().optional(),
  })
  .openapi("CreateDocumentRequest");

/** GET /documents/{documentId} query. */
export const GetDocumentQuerySchema = z
  .object({
    userId: z.string(),
    /** `raw` (default) = stored markdown; `readable` = embeds replaced by their fallback. */
    format: z.enum(DOCUMENT_READ_FORMATS).optional(),
  })
  .openapi("GetDocumentQuery");

/**
 * POST /documents/proposals request body — a full replacement, an ALIAS onto
 * the patch door (one `replace_all` op). Prefer `POST /documents/{id}/patch`.
 */
export const CreateDocumentProposalRequestSchema = z
  .object({
    documentId: z.string(),
    userId: z.string(),
    agentUserId: z.string().optional(),
    sourceMessageId: z.string().optional(),
    sessionId: z.string().optional(),
    proposedContent: z.string(),
    /** The revision you read (GET /documents/{id} → `revision`). */
    baseRevision: z.number().int().min(0).optional(),
    allowRemovingEmbeds: z.boolean().optional(),
    reasoning: z.string().optional(),
  })
  .openapi("CreateDocumentProposalRequest");

/** POST /documents/{documentId}/patch request body — THE document edit door. */
export const PatchDocumentRequestSchema = z
  .object({
    userId: z.string().optional(),
    agentUserId: z.string().optional(),
    sourceMessageId: z.string().optional(),
    sessionId: z.string().optional(),
    /** The revision you read (GET /documents/{id} → `revision`). Required for `replace_all`. */
    baseRevision: z.number().int().min(0).optional(),
    ops: DocumentPatchOpsSchema,
    /** Removing an embed is refused unless this is true. */
    allowRemovingEmbeds: z.boolean().optional(),
    reasoning: z.string().optional(),
  })
  .openapi("PatchDocumentRequest");
