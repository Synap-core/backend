/**
 * Hub Protocol REST — threads (a legacy-named facade over the `channels` table)
 *
 * A "thread" here IS a typed channel: every route below reads/writes the
 * `channels` table (`channelType="thread"` and friends). The `/threads/*` wire
 * paths and the `threadId` path params are KEPT for backward compatibility —
 * browser, CLI, and IS clients depend on them, so renaming the wire surface to
 * channel vocabulary is intentionally deferred (see WAVE4-ROUTES-REPORT.md).
 * Internally the data is channel rows.
 *
 * Routes are wired via `app.openapi(routeDef, handler)` so request bodies /
 * params / query strings are validated against the per-route Zod schema BEFORE
 * the handler runs. Validation failures bubble up through the `defaultHook` set
 * on the parent `OpenAPIHono` (see hub-protocol-rest.ts).
 *
 * Mount order matters: `POST /threads/:threadId/messages.batch` is registered
 * BEFORE `POST /threads/:threadId/messages` so the literal `.batch` segment
 * wins over Hono's first-match dynamic param resolution.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { TRPCError } from "@trpc/server";
import {
  db,
  channels,
  messages,
  drizzleSql,
  eq,
  and,
  or,
  asc,
  desc,
  inArray,
} from "@synap/database";
import { ChannelType, type MessageRole } from "@synap/database/schema";

import { ErrorSchema } from "./_codecs/_openapi.js";
import {
  CreateThreadRequestSchema,
  CreateThreadResponseSchema,
  LinkDocumentRequestSchema,
  LinkEntityRequestSchema,
  LooseObjectResponseSchema,
  MessageSchema,
  PostMessageBatchRequestSchema,
  PostMessageBatchResponseSchema,
  PostMessageRequestSchema,
  PostMessageResponseSchema,
  SuccessResponseSchema,
  ThreadBranchesResponseSchema,
  ThreadSchema,
  UpdateThreadContextRequestSchema,
} from "./_codecs/thread.js";
import {
  getCaller,
  getUserAccessibleWorkspaceIds,
  hasScope,
  logger,
  type HubHono,
} from "./_shared.js";
import { channelVisibilityWhere } from "../../../utils/channel-visibility.js";

export function registerThreadsRoutes(app: HubHono): void {
  // ── GET /threads ────────────────────────────────────────────────────────
  // List chat threads for a user (with parentThreadId for tree construction).
  const listThreadsRoute = createRoute({
    method: "get",
    path: "/threads",
    tags: ["Threads"],
    summary: "List chat threads for a user",
    description:
      "Returns threads owned by `userId`, scoped to either the requested " +
      "`workspaceId` or all of the user's accessible workspaces (plus " +
      "pod-wide personal/feed channels).",
    request: {
      query: z.object({
        userId: z.string(),
        workspaceId: z.string().optional(),
        limit: z.string().optional(),
      }),
    },
    responses: {
      200: {
        description: "Threads list",
        content: { "application/json": { schema: z.array(ThreadSchema) } },
      },
      400: {
        description: "Bad request",
        content: { "application/json": { schema: ErrorSchema } },
      },
      403: {
        description: "Forbidden",
        content: { "application/json": { schema: ErrorSchema } },
      },
      500: {
        description: "Internal error",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(listThreadsRoute, async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const query = c.req.valid("query");
    const userId = query.userId;
    const workspaceId = query.workspaceId;
    const limit = parseInt(query.limit ?? "50", 10);
    try {
      let whereClause;
      const podWideFilter = or(
        eq(channels.channelType, ChannelType.PERSONAL),
        eq(channels.channelType, ChannelType.FEED)
      );

      const visibility = channelVisibilityWhere(userId);
      if (workspaceId) {
        whereClause = and(
          visibility,
          or(eq(channels.workspaceId, workspaceId), podWideFilter)
        );
      } else {
        const accessibleWsIds = await getUserAccessibleWorkspaceIds(userId);
        whereClause = and(
          visibility,
          or(
            ...(accessibleWsIds.length > 0
              ? [inArray(channels.workspaceId, accessibleWsIds)]
              : []),
            podWideFilter
          )
        );
      }
      const channelRows = await db
        .select({
          id: channels.id,
          title: channels.title,
          assignedAgentId: channels.assignedAgentId,
          parentChannelId: channels.parentChannelId,
          branchPurpose: channels.branchPurpose,
          contextSummary: channels.contextSummary,
          createdAt: channels.createdAt,
          updatedAt: channels.updatedAt,
        })
        .from(channels)
        .where(whereClause)
        .orderBy(desc(channels.updatedAt))
        .limit(Math.min(limit, 200));
      return c.json(channelRows, 200);
    } catch (err) {
      logger.error({ err, userId }, "listThreads failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── GET /threads/:threadId/context ──────────────────────────────────────
  const getThreadContextRoute = createRoute({
    method: "get",
    path: "/threads/{threadId}/context",
    tags: ["Threads"],
    summary: "Get a thread's context summary + linked items",
    request: { params: z.object({ threadId: z.string() }) },
    responses: {
      200: {
        description: "Context envelope",
        content: { "application/json": { schema: LooseObjectResponseSchema } },
      },
      403: {
        description: "Forbidden",
        content: { "application/json": { schema: ErrorSchema } },
      },
      500: {
        description: "Internal error",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(getThreadContextRoute, async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const { threadId } = c.req.valid("param");
    try {
      const caller = await getCaller(c);
      const result = await caller.context.getThreadContext({ threadId });
      return c.json(result as Record<string, unknown>, 200);
    } catch (err) {
      logger.error({ err, threadId }, "getThreadContext failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── PATCH /threads/:threadId/context ────────────────────────────────────
  const updateThreadContextRoute = createRoute({
    method: "patch",
    path: "/threads/{threadId}/context",
    tags: ["Threads"],
    summary: "Update a thread's context summary or personality fingerprint",
    request: {
      params: z.object({ threadId: z.string() }),
      body: {
        content: {
          "application/json": { schema: UpdateThreadContextRequestSchema },
        },
      },
    },
    responses: {
      200: {
        description: "Updated",
        content: { "application/json": { schema: SuccessResponseSchema } },
      },
      403: {
        description: "Forbidden",
        content: { "application/json": { schema: ErrorSchema } },
      },
      500: {
        description: "Internal error",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(updateThreadContextRoute, async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const { threadId } = c.req.valid("param");
    const body = c.req.valid("json");
    try {
      if (body.contextSummary !== undefined) {
        const caller = await getCaller(c);
        await caller.context.updateThreadContext({
          threadId,
          contextSummary: body.contextSummary ?? "",
        });
      }
      if (body.personalityFingerprint !== undefined) {
        await db
          .update(channels)
          .set({
            metadata: drizzleSql`COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
            'personalityFingerprint', ${body.personalityFingerprint},
            'personalityFingerprintAt', ${new Date().toISOString()}
          )`,
          })
          .where(eq(channels.id, threadId));
      }
      return c.json({ success: true }, 200);
    } catch (err) {
      logger.error({ err, threadId }, "updateThreadContext failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── POST /threads/:threadId/link-entity ─────────────────────────────────
  const linkEntityRoute = createRoute({
    method: "post",
    path: "/threads/{threadId}/link-entity",
    tags: ["Threads"],
    summary: "Link an entity to a thread",
    request: {
      params: z.object({ threadId: z.string() }),
      body: {
        content: {
          "application/json": { schema: LinkEntityRequestSchema },
        },
      },
    },
    responses: {
      200: {
        description: "Link result",
        content: { "application/json": { schema: LooseObjectResponseSchema } },
      },
      403: {
        description: "Forbidden",
        content: { "application/json": { schema: ErrorSchema } },
      },
      404: {
        description: "Thread not found",
        content: { "application/json": { schema: ErrorSchema } },
      },
      500: {
        description: "Internal error",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(linkEntityRoute, async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const { threadId } = c.req.valid("param");
    const body = c.req.valid("json");
    try {
      const caller = await getCaller(c);
      const result = await caller.linking.linkEntity({
        userId: body.userId,
        ...(body.agentUserId ? { agentUserId: body.agentUserId } : {}),
        threadId,
        entityId: body.entityId,
        relationshipType: body.relationshipType ?? "referenced",
        sourceMessageId: body.sourceMessageId,
      });
      return c.json(result as Record<string, unknown>, 200);
    } catch (err) {
      logger.error({ err, threadId }, "linkEntity failed");
      if (err instanceof TRPCError && err.code === "NOT_FOUND") {
        return c.json(
          { error: err instanceof Error ? err.message : "Unknown error" },
          404
        );
      }
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── POST /threads/:threadId/link-document ───────────────────────────────
  const linkDocumentRoute = createRoute({
    method: "post",
    path: "/threads/{threadId}/link-document",
    tags: ["Threads"],
    summary: "Link a document to a thread",
    request: {
      params: z.object({ threadId: z.string() }),
      body: {
        content: {
          "application/json": { schema: LinkDocumentRequestSchema },
        },
      },
    },
    responses: {
      200: {
        description: "Link result",
        content: { "application/json": { schema: LooseObjectResponseSchema } },
      },
      403: {
        description: "Forbidden",
        content: { "application/json": { schema: ErrorSchema } },
      },
      404: {
        description: "Thread not found",
        content: { "application/json": { schema: ErrorSchema } },
      },
      500: {
        description: "Internal error",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(linkDocumentRoute, async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const { threadId } = c.req.valid("param");
    const body = c.req.valid("json");
    try {
      const caller = await getCaller(c);
      const result = await caller.linking.linkDocument({
        userId: body.userId,
        ...(body.agentUserId ? { agentUserId: body.agentUserId } : {}),
        threadId,
        documentId: body.documentId,
        relationshipType: body.relationshipType ?? "referenced",
        sourceMessageId: body.sourceMessageId,
      });
      return c.json(result as Record<string, unknown>, 200);
    } catch (err) {
      logger.error({ err, threadId }, "linkDocument failed");
      if (err instanceof TRPCError && err.code === "NOT_FOUND") {
        return c.json(
          { error: err instanceof Error ? err.message : "Unknown error" },
          404
        );
      }
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── POST /threads ───────────────────────────────────────────────────────
  // Creates a new chat thread, OR upserts on (externalSource, externalId)
  // when both are provided.
  //
  // Upsert semantics:
  //   - If externalSource + externalId are both set, we look up an existing
  //     channel with that pair owned by the same userId. On hit we return
  //     `{ id, title, reused: true }` with HTTP 200. This lets sidecar
  //     pipelines (Open WebUI, etc.) idempotently mirror conversations
  //     without an in-process cache that resets on container restart.
  //   - On insert race, the partial unique index
  //     `channels_external_source_id_unique` raises a 23505 unique violation;
  //     we catch it, re-SELECT, and return that surviving row.
  const createThreadRoute = createRoute({
    method: "post",
    path: "/threads",
    tags: ["Threads"],
    summary: "Create or upsert a thread",
    description:
      "Creates a new thread, OR upserts on (externalSource, externalId) when " +
      "both are provided. Race-safe via partial unique index. Supports `Idempotency-Key`.",
    request: {
      body: {
        content: {
          "application/json": { schema: CreateThreadRequestSchema },
        },
      },
    },
    responses: {
      200: {
        description: "Thread created or reused",
        content: {
          "application/json": { schema: CreateThreadResponseSchema },
        },
      },
      403: {
        description: "Forbidden",
        content: { "application/json": { schema: ErrorSchema } },
      },
      500: {
        description: "Internal error",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(createThreadRoute, async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const body = c.req.valid("json");

    const hasExternalKey =
      typeof body.externalSource === "string" &&
      body.externalSource.length > 0 &&
      typeof body.externalId === "string" &&
      body.externalId.length > 0;

    try {
      // Fast path: existing dedup row owned by the same caller
      if (hasExternalKey) {
        const existing = await db.query.channels.findFirst({
          where: and(
            eq(channels.externalSource, body.externalSource as string),
            eq(channels.externalId, body.externalId as string),
            eq(channels.userId, body.userId)
          ),
          columns: { id: true, title: true },
        });
        if (existing) {
          return c.json(
            {
              id: existing.id,
              title: existing.title,
              reused: true,
            },
            200
          );
        }
      }

      const { randomUUID } = await import("crypto");
      const threadId = randomUUID();
      try {
        const [thread] = await db
          .insert(channels)
          .values({
            id: threadId,
            userId: body.userId,
            workspaceId: body.workspaceId,
            title: body.title ?? "New Thread",
            parentChannelId: body.parentChannelId ?? null,
            assignedAgentId: body.agentId ?? null,
            branchPurpose: body.branchPurpose ?? null,
            contextObjectType: body.contextObjectType ?? null,
            contextObjectId: body.contextObjectId ?? null,
            ...(hasExternalKey
              ? {
                  externalSource: body.externalSource,
                  externalId: body.externalId,
                }
              : {}),
          })
          .returning();
        return c.json({ id: thread.id, title: thread.title }, 200);
      } catch (insertErr) {
        // Concurrent insert hit the partial unique index — recover by SELECT.
        // Postgres unique-violation: SQLSTATE 23505.
        const code = (insertErr as { code?: string } | null)?.code;
        if (hasExternalKey && code === "23505") {
          const existing = await db.query.channels.findFirst({
            where: and(
              eq(channels.externalSource, body.externalSource as string),
              eq(channels.externalId, body.externalId as string)
            ),
            columns: { id: true, title: true },
          });
          if (existing) {
            return c.json(
              {
                id: existing.id,
                title: existing.title,
                reused: true,
              },
              200
            );
          }
        }
        throw insertErr;
      }
    } catch (err) {
      logger.error({ err }, "createThread failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── GET /threads/:threadId/branches ─────────────────────────────────────
  const getThreadBranchesRoute = createRoute({
    method: "get",
    path: "/threads/{threadId}/branches",
    tags: ["Threads"],
    summary: "List active branches under a thread",
    request: { params: z.object({ threadId: z.string() }) },
    responses: {
      200: {
        description: "Branches",
        content: {
          "application/json": { schema: ThreadBranchesResponseSchema },
        },
      },
      403: {
        description: "Forbidden",
        content: { "application/json": { schema: ErrorSchema } },
      },
      500: {
        description: "Internal error",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(getThreadBranchesRoute, async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const { threadId } = c.req.valid("param");
    try {
      const branches = await db
        .select({
          channelId: channels.id,
          branchPurpose: channels.branchPurpose,
          status: channels.status,
        })
        .from(channels)
        .where(
          and(
            eq(channels.parentChannelId, threadId),
            eq(channels.status, "active")
          )
        )
        .orderBy(asc(channels.createdAt));
      return c.json({ branches }, 200);
    } catch (err) {
      logger.error({ err, threadId }, "getBranches failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── GET /threads/:threadId/messages ─────────────────────────────────────
  const getThreadMessagesRoute = createRoute({
    method: "get",
    path: "/threads/{threadId}/messages",
    tags: ["Threads"],
    summary: "List messages in a thread",
    request: { params: z.object({ threadId: z.string() }) },
    responses: {
      200: {
        description: "Messages",
        content: { "application/json": { schema: z.array(MessageSchema) } },
      },
      403: {
        description: "Forbidden",
        content: { "application/json": { schema: ErrorSchema } },
      },
      500: {
        description: "Internal error",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(getThreadMessagesRoute, async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const { threadId } = c.req.valid("param");
    try {
      const msgs = await db
        .select({
          id: messages.id,
          role: messages.role,
          content: messages.content,
          userId: messages.userId,
          timestamp: messages.timestamp,
          sessionId: messages.sessionId,
          authorType: messages.authorType,
          metadata: messages.metadata,
        })
        .from(messages)
        .where(eq(messages.channelId, threadId))
        .orderBy(asc(messages.timestamp));
      return c.json(msgs, 200);
    } catch (err) {
      logger.error({ err, threadId }, "getThreadMessages failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── POST /threads/:threadId/messages.batch ──────────────────────────────
  // Insert N messages for a thread in a single transaction. Use cases:
  //   - Sidecar pipelines mirroring an entire conversation in one shot
  //   - Importers replaying historical chat logs
  //
  // Limits & guarantees:
  //   - 1..100 messages per request (enforced server-side via Zod)
  //   - All inserts run inside a single Drizzle transaction — partial
  //     batches roll back on any per-row failure (validation or DB).
  //   - Hash matches the single-message endpoint exactly:
  //     sha256(JSON.stringify({threadId, content, role})).
  //   - autoRespond fires for AT MOST ONE user message — the LAST in the
  //     batch — so a 50-message replay does not spawn 50 IS jobs.
  //
  // MUST be registered before the dynamic `/threads/:threadId/messages`
  // route so Hono matches `messages.batch` literally.
  const postMessagesBatchRoute = createRoute({
    method: "post",
    path: "/threads/{threadId}/messages.batch",
    tags: ["Threads"],
    summary: "Append up to 100 messages atomically",
    description:
      "All inserts run in a single Drizzle transaction. autoRespond fires for " +
      "AT MOST ONE message — the LAST user message in the batch. Supports `Idempotency-Key`.",
    request: {
      params: z.object({ threadId: z.string() }),
      body: {
        content: {
          "application/json": { schema: PostMessageBatchRequestSchema },
        },
      },
    },
    responses: {
      200: {
        description: "Inserted message ids",
        content: {
          "application/json": { schema: PostMessageBatchResponseSchema },
        },
      },
      400: {
        description: "Bad request",
        content: { "application/json": { schema: ErrorSchema } },
      },
      403: {
        description: "Forbidden",
        content: { "application/json": { schema: ErrorSchema } },
      },
      500: {
        description: "Internal error",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(postMessagesBatchRoute, async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const { threadId } = c.req.valid("param");
    const body = c.req.valid("json");
    const items = body.messages;
    // Schema enforces min(1), max(100), and per-item required fields.

    try {
      const { randomUUID, createHash } = await import("crypto");

      const prepared = items.map((m) => {
        const id = randomUUID();
        const hash = createHash("sha256")
          .update(
            JSON.stringify({
              threadId,
              content: m.content,
              role: m.role,
            })
          )
          .digest("hex");
        return {
          id,
          channelId: threadId,
          role: m.role as MessageRole,
          content: m.content,
          userId: m.userId,
          hash,
          ...(m.metadata ? { metadata: m.metadata } : {}),
        };
      });

      const messageIds = await db.transaction(async (tx) => {
        const inserted: string[] = [];
        for (const row of prepared) {
          await tx.insert(messages).values(row);
          inserted.push(row.id);
        }
        return inserted;
      });

      // autoRespond: only fire for the LAST user message in the batch to
      // avoid spawning N IS jobs for an N-message replay.
      if (body.autoRespond === true) {
        let lastUserIdx = -1;
        for (let i = items.length - 1; i >= 0; i--) {
          if (items[i].role === "user") {
            lastUserIdx = i;
            break;
          }
        }
        if (lastUserIdx >= 0) {
          const lastUser = items[lastUserIdx];
          const lastUserMsgId = messageIds[lastUserIdx];
          const channel = await db.query.channels.findFirst({
            where: eq(channels.id, threadId),
          });
          if (
            channel?.workspaceId &&
            (channel.channelType === ChannelType.THREAD ||
              channel.channelType === ChannelType.AGENT_COLLAB)
          ) {
            try {
              const { resolveIntelligenceService } =
                await import("../../../utils/intelligence-routing.js");
              const { getBoss, A2AI_TRIGGER_QUEUE, A2AI_TRIGGER_JOB_OPTIONS } =
                await import("@synap/jobs");
              const resolvedService = await resolveIntelligenceService({
                userId: channel.userId,
                workspaceId: channel.workspaceId,
                capability: "chat",
              });
              await getBoss().send(
                A2AI_TRIGGER_QUEUE,
                {
                  channelId: threadId,
                  userMessageId: lastUserMsgId,
                  content: lastUser.content,
                  userId: channel.userId,
                  workspaceId: channel.workspaceId,
                  agentType: "meta",
                  sourceAgentUserId: lastUser.userId,
                  serviceUrl: resolvedService.endpoint,
                  serviceApiKey: resolvedService.serviceApiKey,
                  serviceId: resolvedService.serviceId,
                  agentUserId: resolvedService.agentUserId,
                },
                A2AI_TRIGGER_JOB_OPTIONS
              );
            } catch (err) {
              logger.warn(
                { err, threadId },
                "postMessagesBatch autoRespond trigger failed"
              );
            }
          }
        }
      }

      return c.json({ messageIds }, 200);
    } catch (err) {
      logger.error({ err, threadId }, "postMessagesBatch failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── POST /threads/:threadId/messages ────────────────────────────────────
  const postMessageRoute = createRoute({
    method: "post",
    path: "/threads/{threadId}/messages",
    tags: ["Threads"],
    summary: "Append a single message to a thread",
    description:
      "Inserts one message. When `autoRespond=true` and `role=user`, schedules " +
      "an A2AI agent reply via pg-boss. Supports `Idempotency-Key`.",
    request: {
      params: z.object({ threadId: z.string() }),
      body: {
        content: {
          "application/json": { schema: PostMessageRequestSchema },
        },
      },
    },
    responses: {
      200: {
        description: "Inserted message id",
        content: {
          "application/json": { schema: PostMessageResponseSchema },
        },
      },
      400: {
        description: "Bad request",
        content: { "application/json": { schema: ErrorSchema } },
      },
      403: {
        description: "Forbidden",
        content: { "application/json": { schema: ErrorSchema } },
      },
      500: {
        description: "Internal error",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(postMessageRoute, async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const { threadId } = c.req.valid("param");
    const body = c.req.valid("json");
    try {
      const { randomUUID, createHash } = await import("crypto");
      const msgId = randomUUID();
      const hash = createHash("sha256")
        .update(
          JSON.stringify({ threadId, content: body.content, role: body.role })
        )
        .digest("hex");
      await db.insert(messages).values({
        id: msgId,
        channelId: threadId,
        role: body.role as MessageRole,
        content: body.content,
        userId: body.userId,
        hash,
        ...(body.metadata ? { metadata: body.metadata } : {}),
      });

      if (body.autoRespond === true && body.role === "user") {
        const channel = await db.query.channels.findFirst({
          where: eq(channels.id, threadId),
        });
        if (
          channel?.workspaceId &&
          (channel.channelType === ChannelType.THREAD ||
            channel.channelType === ChannelType.AGENT_COLLAB)
        ) {
          try {
            const { resolveIntelligenceService } =
              await import("../../../utils/intelligence-routing.js");
            const { getBoss, A2AI_TRIGGER_QUEUE, A2AI_TRIGGER_JOB_OPTIONS } =
              await import("@synap/jobs");
            const resolvedService = await resolveIntelligenceService({
              userId: channel.userId,
              workspaceId: channel.workspaceId,
              capability: "chat",
            });
            await getBoss().send(
              A2AI_TRIGGER_QUEUE,
              {
                channelId: threadId,
                userMessageId: msgId,
                content: body.content,
                userId: channel.userId,
                workspaceId: channel.workspaceId,
                agentType: "meta",
                sourceAgentUserId: body.userId,
                serviceUrl: resolvedService.endpoint,
                serviceApiKey: resolvedService.serviceApiKey,
                serviceId: resolvedService.serviceId,
                agentUserId: resolvedService.agentUserId,
              },
              A2AI_TRIGGER_JOB_OPTIONS
            );
          } catch (err) {
            logger.warn(
              { err, threadId },
              "postMessage autoRespond trigger failed"
            );
          }
        }
      }

      return c.json({ success: true as const, messageId: msgId }, 200);
    } catch (err) {
      logger.error({ err, threadId }, "postMessage failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
