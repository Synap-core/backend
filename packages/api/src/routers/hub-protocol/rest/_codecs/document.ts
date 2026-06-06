/**
 * Document Wire Codecs — Hub Protocol REST schemas for documents (Yjs-backed).
 */

import { z } from "@hono/zod-openapi";

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
    workspaceId: z.string().nullable().optional(),
    title: z.string(),
    content: z.string().optional(),
    type: DocumentTypeSchema.optional(),
    reasoning: z.string().optional(),
    agentUserId: z.string().optional(),
    sourceMessageId: z.string().optional(),
  })
  .openapi("CreateDocumentRequest");

/** GET /documents/{documentId} query. */
export const GetDocumentQuerySchema = z
  .object({
    userId: z.string(),
  })
  .openapi("GetDocumentQuery");

/** Document edit operation. */
export const DocumentChangeSchema = z
  .object({
    op: z.enum(["insert", "delete", "replace"]),
    position: z.number().optional(),
    range: z.tuple([z.number(), z.number()]).optional(),
    text: z.string().optional(),
  })
  .openapi("DocumentChange");

/** POST /documents/proposals request body. */
export const CreateDocumentProposalRequestSchema = z
  .object({
    documentId: z.string(),
    userId: z.string(),
    agentUserId: z.string().optional(),
    threadId: z.string().optional(),
    sourceMessageId: z.string().optional(),
    proposalType: z
      .enum(["ai_edit", "user_suggestion", "review_comment"])
      .optional(),
    changes: z.array(DocumentChangeSchema),
    proposedContent: z.string(),
    originalContent: z.string().optional(),
  })
  .openapi("CreateDocumentProposalRequest");
