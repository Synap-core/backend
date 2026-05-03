/**
 * Hub Protocol REST — search
 */

import { z } from "@hono/zod-openapi";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  SearchCollectionQuerySchema,
  SearchDocumentsQuerySchema,
  SearchQuerySchema,
  SearchResponseSchema,
  VectorSearchQuerySchema,
} from "./_codecs/search.js";
import { getCaller, hasScope, logger, type HubHono } from "./_shared.js";

export function registerSearchRoutes(app: HubHono): void {
  // ── OpenAPI metadata ─────────────────────────────────────────────────────
  registerOpenApi(app, {
    method: "get",
    path: "/search/collection",
    tags: ["Search"],
    summary: "Search a single Typesense collection",
    request: {
      query: SearchCollectionQuerySchema,
    },
    responses: {
      200: { description: "Search results", schema: SearchResponseSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "get",
    path: "/search",
    tags: ["Search"],
    summary: "Cross-collection Typesense search",
    request: {
      query: SearchQuerySchema,
    },
    responses: {
      200: { description: "Search results", schema: SearchResponseSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "get",
    path: "/search/documents",
    tags: ["Search"],
    summary: "Search documents only",
    request: {
      query: SearchDocumentsQuerySchema,
    },
    responses: {
      200: {
        description: "Document hits",
        schema: z.array(z.record(z.string(), z.unknown())),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "get",
    path: "/vector-search",
    tags: ["Search"],
    summary: "PGVector semantic search",
    description:
      "Disabled on shared pods (returns empty / 503 when VECTOR_SEARCH_ENABLED=false).",
    request: {
      query: VectorSearchQuerySchema,
    },
    responses: {
      200: {
        description: "Vector search hits",
        schema: z.array(z.record(z.string(), z.unknown())),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  /**
   * GET /search/collection?userId=...&collection=entities&query=...&workspaceId=...
   */
  app.get("/search/collection", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const userId = c.req.query("userId");
    const collection = c.req.query("collection");
    const query = c.req.query("query");
    const workspaceId = c.req.query("workspaceId");
    const limit = c.req.query("limit");
    const page = c.req.query("page");
    if (!userId || !query || !collection) {
      return c.json(
        { error: "userId, collection and query are required" },
        400
      );
    }
    try {
      const caller = await getCaller(c);
      const result = await caller.search.searchCollection({
        userId,
        collection: collection as
          | "entities"
          | "documents"
          | "views"
          | "projects"
          | "chat_threads"
          | "agents",
        query,
        workspaceId: workspaceId || undefined,
        limit: limit ? parseInt(limit, 10) : 20,
        page: page ? parseInt(page, 10) : 1,
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "searchCollection failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * GET /search
   */
  app.get("/search", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const userId = c.req.query("userId");
    const query = c.req.query("query");
    const workspaceId = c.req.query("workspaceId");
    const collections = c.req.query("collections"); // comma-separated
    const limit = c.req.query("limit");
    const page = c.req.query("page");
    if (!userId || !query) {
      return c.json({ error: "userId and query are required" }, 400);
    }
    try {
      const effectiveWsId = workspaceId || undefined;
      const caller = await getCaller(c, { workspaceId: effectiveWsId ?? null });
      const result = await caller.search.search({
        userId,
        query,
        workspaceId: effectiveWsId,
        collections: collections
          ? (collections.split(",") as (
              | "entities"
              | "documents"
              | "views"
              | "projects"
              | "chat_threads"
              | "agents"
            )[])
          : undefined,
        limit: limit ? parseInt(limit, 10) : 20,
        page: page ? parseInt(page, 10) : 1,
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "search failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * GET /search/documents?userId=...&query=...&type=...&limit=...
   */
  app.get("/search/documents", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const userId = c.req.query("userId");
    const query = c.req.query("query");
    const type = c.req.query("type");
    const limit = c.req.query("limit");
    if (!userId || !query) {
      return c.json({ error: "userId and query are required" }, 400);
    }
    try {
      const caller = await getCaller(c);
      const result = await caller.search.searchDocuments({
        userId,
        query,
        type: type as "text" | "markdown" | "code" | "pdf" | "docx" | undefined,
        limit: limit ? parseInt(limit, 10) : 20,
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "searchDocuments failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * GET /vector-search?userId=...&query=...&types=...&limit=...
   */
  app.get("/vector-search", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const userId = c.req.query("userId");
    const query = c.req.query("query");
    const types = c.req.query("types"); // comma-separated
    const limit = c.req.query("limit");
    const workspaceId = c.req.query("workspaceId");
    if (!userId || !query) {
      return c.json({ error: "userId and query are required" }, 400);
    }
    try {
      const effectiveWsId = workspaceId || undefined;
      const caller = await getCaller(c, { workspaceId: effectiveWsId || null });
      const result = await caller.search.vectorSearch({
        userId,
        query,
        types: types ? types.split(",") : undefined,
        limit: limit ? parseInt(limit, 10) : 10,
        workspaceId: effectiveWsId,
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "vectorSearch failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
