/**
 * Thread Wire Codec — schemas for `/threads*` Hub Protocol endpoints.
 *
 * Threads are channels of type THREAD/AGENT_COLLAB/FEED. Messages belong to a
 * thread by `channelId`. The schemas here mirror the Drizzle column shape but
 * are deliberately loose (no enums / no DB-level constraints) so external
 * agents and sidecars can read them without coupling to internal types.
 */

import { z } from "@hono/zod-openapi";
import { AskSchema } from "@synap-core/types/ask";
import { uuidQueryParam } from "./_openapi.js";
import {
  ROOM_POST_KINDS,
  ROOM_POST_SLOT_LABEL_MAX,
} from "../../../../services/messaging/room-post-kind.js";
import {
  SESSION_POST_INTENTS,
  SESSION_POST_REF_KINDS,
  SESSION_POST_REFS_MAX,
} from "@synap-core/types/agents";

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
    workspaceId: uuidQueryParam,
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
    kind: z
      .enum(ROOM_POST_KINDS)
      .optional()
      .describe(
        "An AGENT's post only: 'question' when the person is needed (in a session room it pushes them, once per session window); 'update' (default) for progress/results — in-app only, never a push."
      ),
    slotLabel: z
      .string()
      .max(ROOM_POST_SLOT_LABEL_MAX)
      .optional()
      .describe(
        "With kind 'question' (agent posts only): the label of the session output the question is about. The question is filed ON that output (the owner's, with the question as its why), and the owner's answer is recorded as its `answer` and hands it back to the agent."
      ),
    ask: AskSchema.optional().describe(
      "With kind 'question' + slotLabel (agent posts only): HOW the person answers — the output's typed ask (confirm | choose | form | act | provide). Omit for a free-text answer."
    ),
    intent: z
      .enum(SESSION_POST_INTENTS)
      .optional()
      .describe(
        "An AGENT's message to ANOTHER session — the session whose room this thread is: blocked_on_you | handoff (may wake its agent) | done | fyi (never wake). The pod stamps the sender session and the target; it never notifies the person."
      ),
    fromSessionId: z
      .string()
      .uuid()
      .optional()
      .describe(
        "With intent: YOUR session, when it is not the one this conversation is bound to. It must be yours."
      ),
    refs: z
      .array(
        z.object({
          kind: z.enum(SESSION_POST_REF_KINDS),
          id: z.string().uuid(),
          label: z.string().max(500).optional(),
        })
      )
      .max(SESSION_POST_REFS_MAX)
      .optional()
      .describe(
        "With intent: the state behind the message (a blocked_by session, a delegated slot, a proposal)."
      ),
    cause: z
      .string()
      .uuid()
      .optional()
      .describe(
        "With intent: the id of the session_message that woke you, when this replies to it."
      ),
  })
  .openapi("PostMessageRequest");

/** Response for POST /threads/:threadId/messages. */
export const PostMessageResponseSchema = z
  .object({
    success: z.literal(true),
    messageId: z.string(),
    slot: z
      .object({ status: z.string() })
      .optional()
      .describe(
        "An agent's question naming a slotLabel: 'blocked' when the question is now that output's ask; otherwise why not (unknown_label, already_done, no_session, not_found, failed)."
      ),
    sessionPost: z
      .object({
        intent: z.enum(SESSION_POST_INTENTS),
        from: z.object({ sessionId: z.string().nullable() }),
        to: z.object({ sessionId: z.string() }),
        hop: z.number().int(),
        wake: z.boolean(),
        wakeHeld: z.enum(["hop_limit", "rate_limited"]).optional(),
      })
      .optional()
      .describe(
        "With intent: what the pod stamped — the sender and target sessions, and whether the delivery may wake the target's agent."
      ),
    note: z
      .string()
      .optional()
      .describe(
        "With intent: why a wake-worthy message was delivered without waking anyone."
      ),
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
