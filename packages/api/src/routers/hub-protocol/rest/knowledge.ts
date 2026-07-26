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
import { getConfinedWorkspace } from "../confine-workspace.js";
import {
  knowledgeKeysRepository,
  insertKnowledgeKeySchema,
  traverseEntityGraph,
  db,
  entities,
  inArray,
  and,
} from "@synap/database";
import { accessScopeWhere } from "../../../utils/project-scope.js";

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
  type HubProtocolCaller,
} from "./_shared.js";
import { ask } from "../../../services/knowledge/index.js";
import { synthesizeAnswer } from "../../../services/knowledge/synthesize.js";
import {
  type ProfileCatalogEntry,
  toProfileCatalogEntry,
} from "../../../services/retrieval/index.js";

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

    // A caller-supplied workspaceId MUST be one this agent's user can access,
    // else an agent key scoped to one workspace could read another workspace's
    // keys (the capability scope only proves "may call knowledge reads", not
    // "may see THIS workspace"). No param → the user's personal namespace.
    let workspaceId = authUserId;
    if (query.workspaceId) {
      const accessible = await getUserAccessibleWorkspaceIds(authUserId);
      if (!accessible.includes(query.workspaceId)) {
        return c.json({ error: "Forbidden: not a member of workspace" }, 403);
      }
      workspaceId = query.workspaceId;
    }

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
    deprecated: true,
    description:
      "DEPRECATED — prefer POST /knowledge/ask, whose procedural lane calls the exact same searchFullText. Still functional for existing integrations.",
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
    // Membership-gate a caller-supplied workspaceId (see list route above).
    // No param → the user's personal namespace.
    let workspaceId = authUserId;
    if (wsParam) {
      const accessible = await getUserAccessibleWorkspaceIds(authUserId);
      if (!accessible.includes(wsParam)) {
        return c.json({ error: "Forbidden: not a member of workspace" }, 403);
      }
      workspaceId = wsParam;
    }

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
    // Item 3 Part 3: confine a bound service key to its workspace before the write.
    const workspaceId = getConfinedWorkspace(c, body.workspaceId);

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
        workspaceId: workspaceId ?? undefined,
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
            // SECURITY — floor the hydration by the caller's visibility. The
            // traversal is seeded from accessible workspaces, but a graph walk
            // can cross workspace boundaries via relation edges, so a node id
            // may belong to an entity the caller can't see. An invisible node
            // simply degrades to a bare id (no title/type) rather than leaking.
            where: and(
              inArray(entities.id, nodeIds),
              // `entities` is ownerPrivate — floor on the entity READ scope so a
              // graph walk can't hydrate (leak the NAME of) a NULL-workspace
              // entity owned by another user. Mirrors entities.list.
              accessScopeWhere({
                workspaceIdColumn: entities.workspaceId,
                entityIdColumn: entities.id,
                ownerColumn: entities.userId,
                userId,
                facetLens: true,
              })
            ),
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

  // ── POST /knowledge/search — retrieval door ──────────────────────────────
  // The canonical retrieval door. Classifies substrate intent and routes a
  // natural-language query to the right store(s) — semantic (entity graph, via
  // the Synap Retrieval Engine), procedural (knowledge_keys how-to docs),
  // episodic (knowledge_facts raw captures) — returning provenance-tagged raw
  // matches. Glass-box: the result says which substrates answered, which is
  // primary, plus the SRE's understanding + verdict.
  // See team/platform/unified-knowledge-access.mdx.
  //
  // POST /knowledge/ask is kept as a deprecated alias (see below).
  const retrievalBodySchema = z.object({
    query: z.string().min(1),
    workspaceId: z.string().optional(),
    projectId: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    /**
     * A/B diagnostic — run BOTH rankers on the same pool and attach the
     * `comparison` block. READ-ONLY: does not change the normal answer.
     */
    compare: z.boolean().optional(),
    /**
     * PARSE-ONLY fast path: return just the query understanding + glass-box
     * routing, no retrieval. Mirrors the tRPC `knowledge.search` flag so REST
     * callers (Raycast/CLI/hub clients) can route a query without paying full
     * retrieval per keystroke.
     */
    parseOnly: z.boolean().optional(),
  });

  const rankedItemSchema = z.object({
    id: z.string(),
    title: z.string(),
    score: z.number(),
    rank: z.number(),
  });

  const retrievalResponseSchema = z.object({
    query: z.string(),
    routedTo: z.array(z.string()),
    intent: z.string(),
    primary: z.string(),
    answers: z.array(
      z.object({
        substrate: z.string(),
        items: z.array(z.record(z.string(), z.unknown())),
        status: z.enum(["ok", "error"]),
      })
    ),
    degraded: z.array(z.string()),
    understanding: z.record(z.string(), z.unknown()),
    verdict: z.enum(["confident", "ambiguous", "empty"]),
    // A/B ranker comparison — present ONLY when `compare` was requested.
    comparison: z
      .object({
        baseline: z.array(rankedItemSchema),
        horizon: z.array(rankedItemSchema),
        diff: z.object({
          overlapAtN: z.number(),
          moved: z.array(
            z.object({
              id: z.string(),
              title: z.string(),
              baselineRank: z.number(),
              horizonRank: z.number(),
            })
          ),
        }),
      })
      .optional(),
  });

  /**
   * Shared retrieval handler — runs for both POST /knowledge/search and the
   * deprecated POST /knowledge/ask alias so logic lives in exactly one place.
   */
  async function handleRetrieval(
    userId: string,
    body: {
      query: string;
      workspaceId?: string;
      projectId?: string;
      limit?: number;
      compare?: boolean;
      parseOnly?: boolean;
    },
    getCatalog: (wsId: string) => Promise<HubProtocolCaller>
  ) {
    // Membership-gate the caller-supplied lens (see the list/get routes above):
    // a hub key scoped to one workspace must not recall another workspace's
    // knowledge by passing an arbitrary id — and knowledge_keys has NO user
    // floor, so an unchecked lens would read foreign procedural docs. A
    // non-member id degrades to pod-wide (null), matching the tRPC knowledge
    // router's validateWorkspaceAccess semantics; the read is never 403'd.
    let workspaceId = body.workspaceId ?? null;
    if (workspaceId) {
      const accessible = await getUserAccessibleWorkspaceIds(userId);
      if (!accessible.includes(workspaceId)) workspaceId = null;
    }

    // The semantic engine's CATALOG (type inference) needs a concrete workspace;
    // resolve the user's first accessible one when no lens is pinned.
    // Routing/recall keep the caller's lens (null = pod-wide).
    let catalogWs = workspaceId;
    if (!catalogWs) {
      const wsIds = await getUserAccessibleWorkspaceIds(userId);
      catalogWs = wsIds[0] ?? null;
    }

    let catalog: ProfileCatalogEntry[] = [];
    if (catalogWs) {
      const caller = await getCatalog(catalogWs);
      const { profiles: profileRows } = await caller.profiles.listProfiles({
        userId,
        workspaceId: catalogWs,
      });
      catalog = profileRows.flatMap((p) => {
        const entry = toProfileCatalogEntry(p);
        return entry ? [entry] : [];
      });
    }

    return ask({
      query: body.query,
      userId,
      workspaceId,
      projectId: body.projectId ?? null,
      limit: body.limit,
      catalog,
      // Additive A/B diagnostic — attaches `comparison` only when set.
      compare: body.compare || undefined,
      // Parse-only fast path — understanding + routing, no retrieval.
      parseOnly: body.parseOnly || undefined,
    });
  }

  const searchRoute = createRoute({
    method: "post",
    path: "/knowledge/search",
    tags: ["Knowledge"],
    summary: "Retrieval — route a query across knowledge substrates",
    description:
      "Routes a natural-language query to the right knowledge substrate(s) — " +
      "semantic (typed entities), procedural (how-to docs), episodic (captures) " +
      "— and returns raw matches tagged with which substrate(s) answered. " +
      "For a synthesized human-readable answer use POST /knowledge/answer instead.",
    request: {
      body: {
        content: {
          "application/json": { schema: retrievalBodySchema },
        },
      },
    },
    responses: {
      200: {
        description: "Routed retrieval result",
        content: {
          "application/json": { schema: retrievalResponseSchema },
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

  app.openapi(searchRoute, async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const userId = c.get("userId") as string | undefined;
    if (!userId) return c.json({ error: "Unauthenticated" }, 403);

    try {
      const result = await handleRetrieval(
        userId,
        c.req.valid("json"),
        (wsId) => getCaller(c, { workspaceId: wsId })
      );
      return c.json(result, 200);
    } catch (err) {
      logger.error({ err, userId }, "POST /knowledge/search failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Internal error" },
        500
      );
    }
  });

  // ── POST /knowledge/ask — DEPRECATED alias of /knowledge/search ───────────
  // Kept for back-compat. All new callers should use POST /knowledge/search
  // (retrieval) or POST /knowledge/answer (retrieve + synthesize).
  const askRoute = createRoute({
    method: "post",
    path: "/knowledge/ask",
    tags: ["Knowledge"],
    summary: "DEPRECATED alias of /knowledge/search — raw retrieval door",
    deprecated: true,
    description:
      "DEPRECATED alias of POST /knowledge/search; retained for back-compat. " +
      "Runs the exact same retrieval handler. " +
      "Prefer POST /knowledge/search (retrieval) or POST /knowledge/answer (synthesized).",
    request: {
      body: {
        content: {
          "application/json": { schema: retrievalBodySchema },
        },
      },
    },
    responses: {
      200: {
        description: "Routed retrieval result (identical to /knowledge/search)",
        content: {
          "application/json": { schema: retrievalResponseSchema },
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

  app.openapi(askRoute, async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const userId = c.get("userId") as string | undefined;
    if (!userId) return c.json({ error: "Unauthenticated" }, 403);

    try {
      const result = await handleRetrieval(
        userId,
        c.req.valid("json"),
        (wsId) => getCaller(c, { workspaceId: wsId })
      );
      return c.json(result, 200);
    } catch (err) {
      logger.error({ err, userId }, "POST /knowledge/ask failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Internal error" },
        500
      );
    }
  });

  // ── POST /knowledge/answer ────────────────────────────────────────────────
  // The "answer" door (tier-2 = retrieve + synthesize). Same retrieval as
  // /knowledge/ask (the ONE read door), then ONE focused LLM call in the IS to
  // synthesize a direct answer over the matched context. Explicit doors:
  // `ask` = search (raw matches), `answer` = synthesized. If synthesis is
  // unavailable the answer is null but sources are still returned so callers
  // can fall back to showing matches.
  const SourceSchema = z
    .object({
      substrate: z.string(),
      id: z.string(),
      title: z.string(),
    })
    .openapi("KnowledgeAnswerSource");

  const answerRoute = createRoute({
    method: "post",
    path: "/knowledge/answer",
    tags: ["Knowledge"],
    summary: "Synthesized knowledge answer — retrieve + synthesize",
    description:
      "Retrieves matches via the unified knowledge router, then synthesizes a " +
      "single concise answer over that context with one focused LLM call. " +
      "Returns the answer plus the sources it drew from; answer is null when " +
      "synthesis is unavailable (callers fall back to the sources list).",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              query: z.string().min(1).optional(),
              question: z.string().min(1).optional(),
              workspaceId: z.string().optional(),
              projectId: z.string().optional(),
              limit: z.number().int().min(1).max(100).optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Synthesized answer with sources",
        content: {
          "application/json": {
            schema: z.object({
              answer: z.string().nullable(),
              sources: z.array(SourceSchema),
              routedTo: z.array(z.string()),
              error: z.string().optional(),
            }),
          },
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

  app.openapi(answerRoute, async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const userId = c.get("userId") as string | undefined;
    if (!userId) return c.json({ error: "Unauthenticated" }, 403);

    const body = c.req.valid("json");
    const question = body.question ?? body.query;
    if (!question) {
      return c.json({ error: "Missing query or question" }, 400);
    }
    // Membership-gate the caller-supplied lens, exactly as handleRetrieval does
    // (knowledge_keys has no user floor): a non-member id degrades to pod-wide
    // (null) rather than leaking a foreign workspace's knowledge.
    let workspaceId = body.workspaceId ?? null;
    if (workspaceId) {
      const accessible = await getUserAccessibleWorkspaceIds(userId);
      if (!accessible.includes(workspaceId)) workspaceId = null;
    }

    try {
      // Same catalog resolution + retrieval as /knowledge/ask (the ONE read door).
      let catalogWs = workspaceId;
      if (!catalogWs) {
        const wsIds = await getUserAccessibleWorkspaceIds(userId);
        catalogWs = wsIds[0] ?? null;
      }

      let catalog: ProfileCatalogEntry[] = [];
      if (catalogWs) {
        const caller = await getCaller(c, { workspaceId: catalogWs });
        const { profiles: profileRows } = await caller.profiles.listProfiles({
          userId,
          workspaceId: catalogWs,
        });
        catalog = profileRows.flatMap((p) => {
          const entry = toProfileCatalogEntry(p);
          return entry ? [entry] : [];
        });
      }

      const result = await ask({
        query: question,
        userId,
        workspaceId,
        projectId: body.projectId ?? null,
        limit: body.limit,
        catalog,
      });

      // Build context + sources, then synthesize via IS. Pass the pending count
      // so the composed NL answer can acknowledge matching pending proposals
      // instead of a flat "no information found" contradicting them.
      const synthesis = await synthesizeAnswer(
        result.answers,
        question,
        result.routedTo,
        workspaceId,
        result.pending?.matches?.length ?? 0
      );
      if (synthesis.error) {
        logger.error({ userId }, "knowledge/answer IS call failed");
      }
      return c.json(
        {
          answer: synthesis.answer,
          sources: synthesis.sources,
          routedTo: synthesis.routedTo,
          ...(synthesis.error ? { error: synthesis.error } : {}),
        },
        200
      );
    } catch (err) {
      logger.error({ err, userId }, "POST /knowledge/answer failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Internal error" },
        500
      );
    }
  });
}
