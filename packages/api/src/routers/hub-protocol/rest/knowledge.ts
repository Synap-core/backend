/**
 * Hub Protocol REST — knowledge keys + graph traversal
 *
 * `knowledge_keys` is pod-wide procedural documentation addressed by key string
 * (e.g. "deploy:backend"). Distinct from /memory which is user-scoped episodic
 * memory.
 *
 * Routes are wired via `app.openapi(routeDef, handler)` so request bodies /
 * params / query strings are validated against the per-route Zod schema BEFORE
 * the handler runs. Validation failures bubble up through the `defaultHook` set
 * on the parent `OpenAPIHono` (see hub-protocol-rest.ts).
 *
 * Mount order matters: `/knowledge/search` is registered BEFORE `/knowledge/:key`
 * so the static prefix wins over the dynamic param.
 */

import { z as zodCore } from "zod";
import { createRoute, z } from "@hono/zod-openapi";
import {
  knowledgeKeysRepository,
  insertKnowledgeKeySchema,
  traverseEntityGraph,
  db,
  entities,
  inArray,
} from "@synap/database";

import { ErrorSchema } from "./_codecs/_openapi.js";
import {
  CreateKnowledgeRequestSchema,
  KnowledgeEntrySchema,
  UpsertKnowledgeRequestSchema,
} from "./_codecs/knowledge.js";
import {
  getUserAccessibleWorkspaceIds,
  getCaller,
  hasScope,
  logger,
  type HubHono,
} from "./_shared.js";
import { ask } from "../../../services/knowledge/index.js";
import { type ProfileCatalogEntry } from "../../../services/retrieval/index.js";

const ArchiveKnowledgeResponseSchema = z
  .object({ success: z.boolean() })
  .openapi("ArchiveKnowledgeResponse");

const GraphTraverseResponseSchema = z
  .array(z.record(z.string(), z.unknown()))
  .openapi("GraphTraverseResponse");

export function registerKnowledgeRoutes(app: HubHono): void {
  // ── GET /knowledge — list ───────────────────────────────────────────────
  const listKnowledgeRoute = createRoute({
    method: "get",
    path: "/knowledge",
    tags: ["Knowledge"],
    summary: "List knowledge entries",
    description:
      "Pod-wide procedural docs addressed by string key. When workspaceId is " +
      "omitted, scopes to the authenticated user's namespace.",
    request: {
      query: z.object({
        namespace: z.string().optional(),
        status: z.string().optional(),
        workspaceId: z.string().optional(),
        limit: z.string().optional(),
        offset: z.string().optional(),
      }),
    },
    responses: {
      200: {
        description: "Entries",
        content: {
          "application/json": { schema: z.array(KnowledgeEntrySchema) },
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

  app.openapi(listKnowledgeRoute, async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }

    const authUserId = c.get("userId") as string;
    const query = c.req.valid("query");
    const namespace = query.namespace;
    const status = query.status;
    const limit = parseInt(query.limit ?? "50", 10);
    const offset = parseInt(query.offset ?? "0", 10);

    const workspaceId = query.workspaceId ?? authUserId;

    try {
      const items = await knowledgeKeysRepository.list({
        namespace,
        status,
        workspaceId,
        limit,
        offset,
      });
      return c.json(items, 200);
    } catch (err) {
      logger.error({ err }, "list knowledge keys failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── GET /knowledge/search ───────────────────────────────────────────────
  const searchKnowledgeRoute = createRoute({
    method: "get",
    path: "/knowledge/search",
    tags: ["Knowledge"],
    summary: "Full-text search knowledge entries",
    request: {
      query: z.object({
        q: z.string().optional(),
        query: z.string().optional(),
        workspaceId: z.string().optional(),
        limit: z.string().optional(),
      }),
    },
    responses: {
      200: {
        description: "Matches",
        content: {
          "application/json": { schema: z.array(KnowledgeEntrySchema) },
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

  app.openapi(searchKnowledgeRoute, async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }

    const authUserId = c.get("userId") as string;
    const queryParams = c.req.valid("query");
    const queryStr = queryParams.q ?? queryParams.query ?? "";
    const limit = parseInt(queryParams.limit ?? "10", 10);
    // Knowledge is pod-wide, addressed in the authenticated user's namespace
    // (see this route's description). A real workspace UUID is NOT a knowledge
    // namespace — honoring `?workspaceId=<uuid>` silently searched an empty
    // namespace and returned 0 hits. Always scope to the user namespace.
    const workspaceId = authUserId;

    if (!queryStr) {
      return c.json({ error: "query parameter 'q' is required" }, 400);
    }

    try {
      const results = await knowledgeKeysRepository.searchFullText(
        queryStr,
        workspaceId,
        limit
      );
      return c.json(results, 200);
    } catch (err) {
      logger.error({ err }, "search knowledge keys failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── GET /knowledge/:key ─────────────────────────────────────────────────
  const getKnowledgeRoute = createRoute({
    method: "get",
    path: "/knowledge/{key}",
    tags: ["Knowledge"],
    summary: "Get a knowledge entry by key",
    request: {
      params: z.object({ key: z.string() }),
      query: z.object({ workspaceId: z.string().optional() }),
    },
    responses: {
      200: {
        description: "Entry",
        content: { "application/json": { schema: KnowledgeEntrySchema } },
      },
      403: {
        description: "Forbidden",
        content: { "application/json": { schema: ErrorSchema } },
      },
      404: {
        description: "Not found",
        content: { "application/json": { schema: ErrorSchema } },
      },
      500: {
        description: "Internal error",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(getKnowledgeRoute, async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }

    const authUserId = c.get("userId") as string;
    const { key } = c.req.valid("param");
    const { workspaceId: wsParam } = c.req.valid("query");
    const decodedKey = decodeURIComponent(key);
    const workspaceId = wsParam ?? authUserId;

    try {
      const record = await knowledgeKeysRepository.getByKey(
        decodedKey,
        workspaceId
      );
      if (!record) {
        return c.json({ error: `Knowledge key not found: ${decodedKey}` }, 404);
      }
      return c.json(record, 200);
    } catch (err) {
      logger.error({ err }, "get knowledge key failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── POST /knowledge — create ────────────────────────────────────────────
  const createKnowledgeRoute = createRoute({
    method: "post",
    path: "/knowledge",
    tags: ["Knowledge"],
    summary: "Create a knowledge entry",
    description: "Supports `Idempotency-Key`.",
    request: {
      body: {
        content: {
          "application/json": { schema: CreateKnowledgeRequestSchema },
        },
      },
    },
    responses: {
      200: {
        description: "Created",
        content: { "application/json": { schema: KnowledgeEntrySchema } },
      },
      400: {
        description: "Validation failed",
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

  app.openapi(createKnowledgeRoute, async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }

    const authUserId = c.get("userId") as string;
    const body = c.req.valid("json");

    try {
      // Re-parse via the DB-side schema to defensively normalize before
      // hitting the repository (handles defaults the wire schema doesn't
      // model — e.g. workspaceId derivation, slug normalization).
      const parsed = insertKnowledgeKeySchema.parse({
        key: body.key,
        value: body.value,
        namespace: body.namespace,
        slug: body.slug,
        status: body.status ?? "active",
        author: body.author ?? authUserId,
      });

      const record = await knowledgeKeysRepository.create({
        key: parsed.key,
        value: parsed.value ?? "",
        status: parsed.status,
        workspaceId: parsed.workspaceId || undefined,
        author: parsed.author || undefined,
      });
      return c.json(record, 200);
    } catch (err) {
      if (err instanceof zodCore.ZodError) {
        return c.json(
          { error: err.issues.map((e) => e.message).join(", ") },
          400
        );
      }
      logger.error({ err }, "create knowledge key failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── PUT /knowledge/:key — upsert ────────────────────────────────────────
  const upsertKnowledgeRoute = createRoute({
    method: "put",
    path: "/knowledge/{key}",
    tags: ["Knowledge"],
    summary: "Upsert a knowledge entry",
    description: "Supports `Idempotency-Key`.",
    request: {
      params: z.object({ key: z.string() }),
      body: {
        content: {
          "application/json": { schema: UpsertKnowledgeRequestSchema },
        },
      },
    },
    responses: {
      200: {
        description: "Upserted",
        content: { "application/json": { schema: KnowledgeEntrySchema } },
      },
      400: {
        description: "Validation failed",
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

  app.openapi(upsertKnowledgeRoute, async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }

    const authUserId = c.get("userId") as string;
    const { key } = c.req.valid("param");
    const decodedKey = decodeURIComponent(key);
    const body = c.req.valid("json");

    try {
      const parsed = insertKnowledgeKeySchema.parse({
        key: decodedKey,
        value: body.value,
        status: body.status ?? "active",
        author: body.author ?? authUserId,
      });

      const record = await knowledgeKeysRepository.upsert(decodedKey, {
        key: decodedKey,
        value: parsed.value ?? "",
        status: parsed.status,
        workspaceId: parsed.workspaceId || undefined,
        author: parsed.author || undefined,
      });
      return c.json(record, 200);
    } catch (err) {
      if (err instanceof zodCore.ZodError) {
        return c.json(
          { error: err.issues.map((e) => e.message).join(", ") },
          400
        );
      }
      logger.error({ err }, "upsert knowledge key failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── DELETE /knowledge/:key — archive ────────────────────────────────────
  const archiveKnowledgeRoute = createRoute({
    method: "delete",
    path: "/knowledge/{key}",
    tags: ["Knowledge"],
    summary: "Archive (soft-delete) a knowledge entry",
    request: { params: z.object({ key: z.string() }) },
    responses: {
      200: {
        description: "Archived",
        content: {
          "application/json": { schema: ArchiveKnowledgeResponseSchema },
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

  app.openapi(archiveKnowledgeRoute, async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }

    const { key } = c.req.valid("param");
    const decodedKey = decodeURIComponent(key);

    try {
      const result = await knowledgeKeysRepository.archive(decodedKey);
      return c.json({ success: result }, 200);
    } catch (err) {
      logger.error({ err }, "archive knowledge key failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── GET /graph/traverse ─────────────────────────────────────────────────
  const graphTraverseRoute = createRoute({
    method: "get",
    path: "/graph/traverse",
    tags: ["Knowledge", "Graph"],
    summary: "BFS traversal of the entity graph",
    description: "maxDepth is clamped to 3.",
    request: {
      query: z.object({
        // Optional: the handler pins to the authenticated principal anyway.
        userId: z.string().optional(),
        startEntityId: z.string(),
        maxDepth: z.string().optional(),
        relationshipTypes: z.string().optional(),
      }),
    },
    responses: {
      200: {
        description: "Traversal results",
        content: {
          "application/json": { schema: GraphTraverseResponseSchema },
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

  app.openapi(graphTraverseRoute, async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const query = c.req.valid("query");
    const maxDepth = parseInt(query.maxDepth ?? "2", 10);
    const relationshipTypes = query.relationshipTypes
      ? query.relationshipTypes.split(",").filter(Boolean)
      : undefined;

    try {
      // Pin to the authenticated owner — never the query userId (it let an
      // agent key traverse another user's entity graph).
      const userId = c.get("userId") as string;
      const accessibleWsIds = await getUserAccessibleWorkspaceIds(userId);
      if (accessibleWsIds.length === 0) return c.json([], 200);
      const results = await traverseEntityGraph({
        userId,
        startEntityId: query.startEntityId,
        maxDepth: Math.min(maxDepth, 3),
        relationshipTypes,
        workspaceIds: accessibleWsIds,
      });

      // Hydrate each node with title + entityType so callers (AI agents) get
      // LABELED nodes, not bare ids. Previously every traversal forced an N+1
      // GET /entities/{id} per node just to learn what each node was.
      const nodes = results as unknown as Array<
        Record<string, unknown> & { entityId?: string }
      >;
      const nodeIds = [
        ...new Set(
          nodes.map((n) => n.entityId).filter((id): id is string => Boolean(id))
        ),
      ];
      const rows = nodeIds.length
        ? await db.query.entities.findMany({
            where: inArray(entities.id, nodeIds),
            columns: { id: true, title: true, type: true },
          })
        : [];
      const byId = new Map(rows.map((r) => [r.id, r]));
      const hydrated = nodes.map((n) => {
        const row = n.entityId ? byId.get(n.entityId) : undefined;
        return {
          ...n,
          title: row?.title ?? null,
          entityType: row?.type ?? null,
        };
      });
      return c.json(hydrated, 200);
    } catch (err) {
      logger.error({ err }, "traverseGraph failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
