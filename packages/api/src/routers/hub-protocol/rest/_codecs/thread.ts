/**
 * Thread Wire Codec — schemas for `/threads*` Hub Protocol endpoints.
 *
 * Threads are channels of type THREAD/AGENT_COLLAB/FEED. Messages belong to a
 * thread by `channelId`. The schemas here mirror the Drizzle column shape but
 * are deliberately loose (no enums / no DB-level constraints) so external
 * agents and sidecars can read them without coupling to internal types.
 */

import { z } from "@hono/zod-openapi";

/** Single thread (channel) row as returned by GET /threads. */
export const ThreadSchema = z
  .object({
    id: z.string(),
    title: z.string().nullable().optional(),
    assignedAgentId: z.string().nullable().optional(),
    parentChannelId: z.string().nullable().optional(),
    branchPurpose: z.string().nullable().optional(),
    contextSummary: z.string().nullable().optional(),
    createdAt: z.union([z.string(), z.date()]).optional(),
    updatedAt: z.union([z.string(), z.date()]).optional(),
  })
  .openapi("Thread");

/** Single chat message. */
export const MessageSchema = z
  .object({
    id: z.string(),
    role: z.enum(["system", "assistant", "user"]),
    content: z.string(),
    userId: z.string(),
    timestamp: z.union([z.string(), z.date()]).optional(),
    sessionId: z.string().nullable().optional(),
    authorType: z.string().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .openapi("Message");

/** Body for POST /threads. */
export const CreateThreadRequestSchema = z
  .object({
    userId: z.string(),
    workspaceId: z.string(),
    title: z.string().optional(),
    parentChannelId: z.string().optional(),
    agentId: z.string().optional(),
    branchPurpose: z.string().optional(),
    contextObjectType: z.string().optional(),
    contextObjectId: z.string().optional(),
    /** When set together, the route upserts on (externalSource, externalId). */
    externalSource: z.string().optional(),
    externalId: z.string().optional(),
  })
  .openapi("CreateThreadRequest");

/** Response for POST /threads. */
export const CreateThreadResponseSchema = z
  .object({
    id: z.string(),
    title: z.string().nullable().optional(),
    /** True when the thread was deduplicated against an existing external key. */
    reused: z.boolean().optional(),
  })
  .openapi("CreateThreadResponse");

/** Body for POST /threads/:threadId/messages. */
export const PostMessageRequestSchema = z
  .object({
    role: z.enum(["system", "assistant", "user"]),
    content: z.string(),
    userId: z.string(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    autoRespond: z
      .boolean()
      .optional()
      .describe(
        "If true and role=user, schedules an A2AI agent reply via pg-boss."
      ),
  })
  .openapi("PostMessageRequest");

/** Response for POST /threads/:threadId/messages. */
export const PostMessageResponseSchema = z
  .object({
    success: z.literal(true),
    messageId: z.string(),
  })
  .openapi("PostMessageResponse");

/** Body for POST /threads/:threadId/messages.batch. */
export const PostMessageBatchRequestSchema = z
  .object({
    messages: z
      .array(
        z.object({
          role: z.enum(["system", "assistant", "user"]),
          content: z.string(),
          userId: z.string(),
          metadata: z.record(z.string(), z.unknown()).optional(),
        })
      )
      .min(1)
      .max(100),
    autoRespond: z
      .boolean()
      .optional()
      .describe(
        "If true, the LAST user message in the batch fires an A2AI reply."
      ),
  })
  .openapi("PostMessageBatchRequest");

/** Response for POST /threads/:threadId/messages.batch. */
export const PostMessageBatchResponseSchema = z
  .object({
    messageIds: z.array(z.string()),
  })
  .openapi("PostMessageBatchResponse");

/** Response for GET /threads/:threadId/branches. */
export const ThreadBranchesResponseSchema = z
  .object({
    branches: z.array(
      z.object({
        channelId: z.string(),
        branchPurpose: z.string().nullable().optional(),
        status: z.string().nullable().optional(),
      })
    ),
  })
  .openapi("ThreadBranchesResponse");

/**
 * Body for PATCH /threads/:threadId/context. The handler reads two optional
 * fields and side-effects independently — both can be null/missing, in which
 * case the request is a no-op.
 */
export const UpdateThreadContextRequestSchema = z
  .object({
    contextSummary: z.string().optional(),
    personalityFingerprint: z.string().optional(),
  })
  .openapi("UpdateThreadContextRequest");

/** Body for POST /threads/:threadId/link-entity. */
export const LinkEntityRequestSchema = z
  .object({
    userId: z.string(),
    agentUserId: z.string().optional(),
    entityId: z.string(),
    relationshipType: z
      .enum([
        "created",
        "updated",
        "used_as_context",
        "referenced",
        "inherited_from_parent",
      ])
      .optional(),
    sourceMessageId: z.string().optional(),
  })
  .openapi("LinkEntityRequest");

/** Body for POST /threads/:threadId/link-document. */
export const LinkDocumentRequestSchema = z
  .object({
    userId: z.string(),
    agentUserId: z.string().optional(),
    documentId: z.string(),
    relationshipType: z
      .enum([
        "created",
        "updated",
        "used_as_context",
        "referenced",
        "inherited_from_parent",
      ])
      .optional(),
    sourceMessageId: z.string().optional(),
  })
  .openapi("LinkDocumentRequest");

/**
 * Loose envelope for routes whose tRPC return shape is complex / version-bound
 * (e.g. getThreadContext). Documented as an opaque object; callers should not
 * treat the OpenAPI shape as a stable contract beyond the existence of the
 * payload itself.
 */
export const LooseObjectResponseSchema = z
  .record(z.string(), z.unknown())
  .openapi("LooseObjectResponse");

/** Generic success ack for context-update / link-* style writes. */
export const SuccessResponseSchema = z
  .object({ success: z.boolean() })
  .openapi("SuccessResponse");
