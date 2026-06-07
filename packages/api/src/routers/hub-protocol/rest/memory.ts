/**
 * Hub Protocol REST — memory (knowledge facts: episodic memory)
 *
 * All routes are wired via `app.openapi(routeDef, handler)` so the request body
 * / params / query are validated against the per-route Zod schema BEFORE the
 * handler runs. Validation failures bubble up through the `defaultHook` set on
 * the parent `OpenAPIHono` (see hub-protocol-rest.ts) which emits the canonical
 * `{ error: string }` 400 response.
 */

import { createRoute, z } from "@hono/zod-openapi";
import {
  db,
  knowledgeFacts,
  knowledgeRepository,
  eq,
  and,
} from "@synap/database";

import { ErrorSchema } from "./_codecs/_openapi.js";
import {
  CreateMemoryRequestSchema,
  MemoryBatchResponseSchema,
  MemoryFactSchema,
  MemorySearchRequestSchema,
  MemorySessionRequestSchema,
  MemoryTurnsRequestSchema,
  MemoryWritesRequestSchema,
} from "./_codecs/memory.js";
import { hasScope, logger, type HubHono } from "./_shared.js";

const DeleteMemoryResponseSchema = z
  .object({ success: z.boolean() })
  .openapi("DeleteMemoryResponse");

export function registerMemoryRoutes(app: HubHono): void {
  // ── POST /memory ────────────────────────────────────────────────────────
  const createMemoryRoute = createRoute({
    method: "post",
    path: "/memory",
    tags: ["Memory"],
    summary: "Save a memory fact",
    description:
      "Stores a user-scoped episodic fact. The embedding is optional — when " +
      "omitted, a zero vector is used so agents without embedding access can " +
      "still write facts. Supports `Idempotency-Key`.",
    request: {
      body: {
        content: { "application/json": { schema: CreateMemoryRequestSchema } },
      },
    },
    responses: {
      200: {
        description: "Saved fact",
        content: { "application/json": { schema: MemoryFactSchema } },
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

  app.openapi(createMemoryRoute, async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const body = c.req.valid("json");
    const userId = body.userId ?? (c.get("userId") as string | undefined);
    if (!userId) {
      return c.json(
        {
          error: "userId is required (pass in body or authenticate via Bearer)",
        },
        400
      );
    }
    try {
      // Embedding is optional — if not provided, use a zero vector.
      const embedding = Array.isArray(body.embedding)
        ? body.embedding
        : new Array(1536).fill(0);
      const record = await knowledgeRepository.saveFact({
        userId,
        fact: body.fact,
        confidence: body.confidence ?? 0.8,
        embedding,
        sourceEntityId: body.sourceEntityId,
        sourceMessageId: body.sourceMessageId,
      });

      // Identity linking: when the bearer API key has a linked_user_id, write
      // the same fact for the linked human so it appears in their timeline too.
      // Guard: skip under sub-tokens — userId is already remapped to the human
      // user, so writing to linkedUserId (the pod owner) would be wrong.
      const isSubToken = !!(c.get("parentKeyId") as string | undefined);
      const linkedUserId = c.get("linkedUserId") as string | undefined;
      if (!isSubToken && linkedUserId && linkedUserId !== userId) {
        void knowledgeRepository
          .saveFact({
            userId: linkedUserId,
            fact: body.fact,
            confidence: body.confidence ?? 0.8,
            embedding,
            sourceEntityId: body.sourceEntityId,
            sourceMessageId: body.sourceMessageId,
          })
          .catch((err: unknown) => {
            logger.warn(
              { err, linkedUserId },
              "identity-link dual-write failed (non-fatal)"
            );
          });
      }

      return c.json(record, 200);
    } catch (err) {
      logger.error({ err }, "saveFact failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── GET /memory ─────────────────────────────────────────────────────────
  const listMemoryRoute = createRoute({
    method: "get",
    path: "/memory",
    tags: ["Memory"],
    summary: "Full-text search facts",
    request: {
      query: z.object({
        userId: z.string().optional(),
        query: z.string().optional(),
        q: z.string().optional(),
        limit: z.string().optional(),
      }),
    },
    responses: {
      200: {
        description: "Matching facts",
        content: { "application/json": { schema: z.array(MemoryFactSchema) } },
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

  app.openapi(listMemoryRoute, async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const authUserId = c.get("userId") as string;
    const query = c.req.valid("query");
    const userId = query.userId || authUserId;
    if (!userId) {
      return c.json({ error: "userId is required" }, 400);
    }
    const q = query.query ?? query.q ?? "";
    const limit = parseInt(query.limit ?? "10", 10);
    try {
      const facts = await knowledgeRepository.searchFacts({
        userId,
        query: q,
        limit,
      });
      return c.json(facts, 200);
    } catch (err) {
      logger.error({ err }, "searchFacts failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── POST /memory/search ─────────────────────────────────────────────────
  const searchMemoryRoute = createRoute({
    method: "post",
    path: "/memory/search",
    tags: ["Memory"],
    summary: "Semantic search facts by embedding",
    description: "Requires pgvector — disabled on shared pods.",
    request: {
      body: {
        content: { "application/json": { schema: MemorySearchRequestSchema } },
      },
    },
    responses: {
      200: {
        description: "Matching facts",
        content: { "application/json": { schema: z.array(MemoryFactSchema) } },
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

  app.openapi(searchMemoryRoute, async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const body = c.req.valid("json");
    try {
      const facts = await knowledgeRepository.searchFactsSemantic({
        userId: body.userId,
        embedding: body.embedding,
        limit: body.limit,
      });
      return c.json(facts, 200);
    } catch (err) {
      logger.error({ err }, "searchFactsSemantic failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── DELETE /memory/:id ──────────────────────────────────────────────────
  const deleteMemoryRoute = createRoute({
    method: "delete",
    path: "/memory/{id}",
    tags: ["Memory"],
    summary: "Delete a fact",
    request: {
      params: z.object({ id: z.string() }),
      query: z.object({ userId: z.string() }),
    },
    responses: {
      200: {
        description: "Deleted",
        content: {
          "application/json": { schema: DeleteMemoryResponseSchema },
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

  app.openapi(deleteMemoryRoute, async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const { id } = c.req.valid("param");
    // Scope the delete to the caller's OWN facts — without the userId guard any
    // agent with hub-protocol.write could delete ANY fact by id (cross-user).
    // Idempotent: a no-match delete still returns 200 (and doesn't reveal
    // whether the id exists under another user).
    const authUserId = c.get("userId") as string;
    try {
      await db
        .delete(knowledgeFacts)
        .where(
          and(eq(knowledgeFacts.id, id), eq(knowledgeFacts.userId, authUserId))
        );
      return c.json({ success: true }, 200);
    } catch (err) {
      logger.error({ err, id }, "deleteFact failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── POST /memory/turns ──────────────────────────────────────────────────
  const turnsRoute = createRoute({
    method: "post",
    path: "/memory/turns",
    tags: ["Memory"],
    summary: "Store grouped chat turns",
    description:
      "Stores user/assistant/system turns grouped by sessionId. Each turn is " +
      "persisted as a tagged fact for semantic retrieval plus a summary fact.",
    request: {
      body: {
        content: { "application/json": { schema: MemoryTurnsRequestSchema } },
      },
    },
    responses: {
      200: {
        description: "Batch result",
        content: { "application/json": { schema: MemoryBatchResponseSchema } },
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

  app.openapi(turnsRoute, async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const body = c.req.valid("json");
    const userId = body.userId ?? (c.get("userId") as string | undefined);
    if (!userId) {
      return c.json({ error: "userId is required" }, 400);
    }
    try {
      const created: (typeof knowledgeFacts.$inferSelect)[] = [];

      // Store each turn as a tagged fact
      for (let i = 0; i < body.turns.length; i++) {
        const turn = body.turns[i];
        const turnFact = `${body.sessionId}[turn:${i}] ${turn.role}: ${turn.content}`;
        const record = await knowledgeRepository.saveFact({
          userId,
          fact: turnFact,
          confidence: body.confidence ?? 0.8,
          embedding: Array.isArray(body.embedding)
            ? body.embedding
            : new Array(1536).fill(0),
          sourceEntityId: body.sourceEntityId,
          sourceMessageId: body.sourceMessageId,
        });
        created.push(
          record as typeof knowledgeFacts.$inferSelect & {
            embedding?: number[];
          }
        );
      }

      // Store a summary fact if provided
      if (body.summary) {
        const summaryRecord = await knowledgeRepository.saveFact({
          userId,
          fact: `${body.sessionId} [summary] ${body.summary}`,
          confidence: body.confidence ?? 0.9,
          embedding: Array.isArray(body.embedding)
            ? body.embedding
            : new Array(1536).fill(0),
          sourceEntityId: body.sourceEntityId,
          sourceMessageId: body.sourceMessageId,
        });
        created.push(
          summaryRecord as typeof knowledgeFacts.$inferSelect & {
            embedding?: number[];
          }
        );
      }

      return c.json(
        {
          success: true,
          facts: created,
          count: created.length,
        },
        200
      );
    } catch (err) {
      logger.error({ err }, "saveTurns failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── POST /memory/sessions ───────────────────────────────────────────────
  const sessionRoute = createRoute({
    method: "post",
    path: "/memory/sessions",
    tags: ["Memory"],
    summary: "Store session metadata",
    description:
      "Stores session metadata as a high-confidence fact for list/dedup purposes.",
    request: {
      body: {
        content: { "application/json": { schema: MemorySessionRequestSchema } },
      },
    },
    responses: {
      200: {
        description: "Session metadata stored",
        content: { "application/json": { schema: MemoryBatchResponseSchema } },
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

  app.openapi(sessionRoute, async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const body = c.req.valid("json");
    const userId = body.userId ?? (c.get("userId") as string | undefined);
    if (!userId) {
      return c.json({ error: "userId is required" }, 400);
    }
    try {
      const metadataJson = body.metadata ? JSON.stringify(body.metadata) : "";
      const tagsStr = body.tags ? body.tags.join(",") : "";
      const fact = `${body.sessionId} summary: ${body.summary} turns: ${body.turnCount ?? 0} tags: ${tagsStr} metadata: ${metadataJson}`;

      const record = await knowledgeRepository.saveFact({
        userId,
        fact,
        confidence: body.confidence ?? 0.95,
        embedding: new Array(1536).fill(0),
      });

      return c.json({ success: true, facts: [record], count: 1 }, 200);
    } catch (err) {
      logger.error({ err }, "saveSession failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── POST /memory/writes ─────────────────────────────────────────────────
  const writesRoute = createRoute({
    method: "post",
    path: "/memory/writes",
    tags: ["Memory"],
    summary: "Batch structured writes",
    description:
      "Batch write of structured memory entries (remember/update/forget).",
    request: {
      body: {
        content: { "application/json": { schema: MemoryWritesRequestSchema } },
      },
    },
    responses: {
      200: {
        description: "Batch result",
        content: { "application/json": { schema: MemoryBatchResponseSchema } },
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

  app.openapi(writesRoute, async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const body = c.req.valid("json");
    const userId = body.userId ?? (c.get("userId") as string | undefined);
    if (!userId) {
      return c.json({ error: "userId is required" }, 400);
    }
    try {
      const created: (typeof knowledgeFacts.$inferSelect)[] = [];

      for (const entry of body.entries) {
        const entryFact = `[write:${entry.action}:${entry.target}] ${entry.content}`;
        const record = await knowledgeRepository.saveFact({
          userId,
          fact: entryFact,
          confidence: body.confidence ?? 0.9,
          embedding: new Array(1536).fill(0),
        });
        created.push(
          record as typeof knowledgeFacts.$inferSelect & {
            embedding?: number[];
          }
        );
      }

      return c.json(
        {
          success: true,
          facts: created,
          count: created.length,
        },
        200
      );
    } catch (err) {
      logger.error({ err }, "batchWrite failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
