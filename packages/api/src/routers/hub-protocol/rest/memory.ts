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
import { db, knowledgeFacts, knowledgeRepository, eq } from "@synap/database";

import { ErrorSchema } from "./_codecs/_openapi.js";
import {
  CreateMemoryRequestSchema,
  MemoryFactSchema,
  MemorySearchRequestSchema,
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
    try {
      // Embedding is optional — if not provided, use a zero vector.
      const embedding = Array.isArray(body.embedding)
        ? body.embedding
        : new Array(1536).fill(0);
      const record = await knowledgeRepository.saveFact({
        userId: body.userId,
        fact: body.fact,
        confidence: body.confidence ?? 0.8,
        embedding,
        sourceEntityId: body.sourceEntityId,
        sourceMessageId: body.sourceMessageId,
      });
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
    try {
      await db.delete(knowledgeFacts).where(eq(knowledgeFacts.id, id));
      return c.json({ success: true }, 200);
    } catch (err) {
      logger.error({ err, id }, "deleteFact failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
