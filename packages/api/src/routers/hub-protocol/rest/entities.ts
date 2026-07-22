/**
 * Hub Protocol REST — entities
 *
 * Mount order matters here: GET /entities must come before GET /entities/:id,
 * and GET /entities/:id/connections must come before GET /entities/:id, so the
 * Hono first-match router resolves correctly. The original file's order is
 * preserved exactly.
 *
 * Routes are wired via `app.openapi(routeDef, handler)` so request bodies /
 * params / query strings are validated against the per-route Zod schema BEFORE
 * the handler runs. Validation failures bubble up through the `defaultHook` set
 * on the parent `OpenAPIHono` (see hub-protocol-rest.ts).
 */

import { createRoute, z } from "@hono/zod-openapi";
import {
  db,
  entities,
  profiles,
  eq,
  and,
  or,
  isNull,
  isNotNull,
  getEffectiveFacets,
} from "@synap/database";
import { inArray } from "drizzle-orm";
import { storage } from "@synap/storage";
import { userVisibleWhere } from "../../../utils/user-visible-where.js";
import { resolveFacetVisibilityScope } from "../../../utils/workspace-membership.js";

import {
  uploadBufferAsFileEntity,
  MAX_FILE_SIZE,
  isAllowedMimeType,
} from "../../file-upload.js";
import { createGovernedFileEntityFromBuffer } from "../../create-governed-file-entity.js";
import { checkHubRateLimit } from "../../../utils/hub-protocol-rate-limit.js";
import { relationsRouter } from "../../relations.js";
import { resolveCaptureActorUserId } from "../../../services/capture-agent/resolve-capture-actor.js";
import { buildCreateEntityReceipt } from "../write-receipt.js";
import { createHubProtocolCallerContext } from "../utils.js";
import {
  retrieve,
  hybridRecall,
  type ProfileCatalogEntry,
  toProfileCatalogEntry,
} from "../../../services/retrieval/index.js";
import {
  storeEntitySourceBlob,
  SourceBlobTooLargeError,
  SourceBlobEmptyError,
  SOURCE_BLOB_MAX_BYTES,
} from "../../../utils/store-entity-source-blob.js";
import {
  CreateEntityRequestSchema,
  CreateEntityResponseSchema,
  RawEntityRecordSchema,
  UpdateEntityRequestSchema,
  UpdateEntityResponseSchema,
  WireEntitySchema,
  entityToWire,
} from "./_codecs/entity.js";
import { ErrorSchema } from "./_codecs/_openapi.js";
import {
  getCaller,
  getUserAccessibleWorkspaceIds,
  hasScope,
  logger,
  resolveActingContext,
  resolveActorId,
  verifyWorkspaceReadAccess,
  verifyWorkspaceAccess,
  type HubHono,
} from "./_shared.js";
import { getConfinedWorkspace } from "../confine-workspace.js";

/** The shallow `impact` block attached to an update response (additive). */
interface UpdateImpactBlock {
  /** Immediate relation neighbours of the updated entity (ids + names + relation). */
  neighbors: Array<{
    id: string;
    name: string | null;
    relation: string;
  }>;
  /** Total immediate neighbours (may exceed `neighbors.length` if capped). */
  total: number;
}

/**
 * Fetch the updated entity's IMMEDIATE relation neighbours (one hop) via the
 * existing getConnections read — no new traversal. Returns `undefined` on any
 * failure so the update is never blocked.
 */
async function buildUpdateImpact(params: {
  scopes: string[];
  userId: string;
  workspaceId: string | null;
  entityId: string;
}): Promise<UpdateImpactBlock | undefined> {
  try {
    const ctx = await createHubProtocolCallerContext(
      params.userId,
      params.scopes,
      params.workspaceId ?? undefined
    );
    const caller = relationsRouter.createCaller(
      ctx as Parameters<typeof relationsRouter.createCaller>[0]
    );
    const result = await caller.getConnections({
      entityId: params.entityId,
      limit: 50,
    });

    const neighbors = result.connections.map((conn) => ({
      id: conn.entityId,
      name: (conn.entity?.title as string | null | undefined) ?? null,
      relation: conn.relationType ?? conn.label,
    }));

    return { neighbors, total: result.counts.total };
  } catch (err) {
    logger.warn(
      { err, entityId: params.entityId },
      "buildUpdateImpact failed (impact omitted)"
    );
    return undefined;
  }
}

export function registerEntitiesRoutes(app: HubHono): void {
  // ── GET /users/:userId/entities ─────────────────────────────────────────
  const listUserEntitiesRoute = createRoute({
    method: "get",
    path: "/users/{userId}/entities",
    tags: ["Entities"],
    summary: "List entities for a user",
    description:
      "Returns entities owned by the given user, optionally filtered by " +
      "profileSlug and workspaceId. Pod-wide profiles are returned regardless " +
      "of workspaceId.",
    request: {
      params: z.object({ userId: z.string() }),
      query: z.object({
        profileSlug: z.string().optional(),
        type: z
          .string()
          .optional()
          .describe("Deprecated alias for profileSlug."),
        workspaceId: z.string().optional(),
        limit: z.string().optional(),
      }),
    },
    responses: {
      200: {
        description: "Array of entities",
        content: {
          "application/json": { schema: z.array(RawEntityRecordSchema) },
        },
      },
      403: {
        description: "Missing scope",
        content: { "application/json": { schema: ErrorSchema } },
      },
      500: {
        description: "Internal error",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(listUserEntitiesRoute, async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const { userId } = c.req.valid("param");
    const query = c.req.valid("query");
    const profileSlug = query.profileSlug || query.type || undefined;
    const limit = query.limit;
    const workspaceId = query.workspaceId || null;
    try {
      const effectiveWsIds = workspaceId
        ? [workspaceId]
        : await getUserAccessibleWorkspaceIds(userId);
      if (effectiveWsIds.length === 0) return c.json([], 200);

      const caller = await getCaller(c, {
        workspaceId: effectiveWsIds[0],
        userId,
      });
      const result = await caller.entities.getEntities({
        userId,
        workspaceId: workspaceId || undefined,
        profileSlug: profileSlug || undefined,
        limit: limit ? parseInt(limit, 10) : undefined,
        // This is the user-wide FLOOR read (the agent's door). `list` is
        // scoped-by-default, so without this a workspace lens drops pod-wide
        // profiles (person/company/contact live at workspace_id NULL) — which
        // is why "what people are in the CRM" returned 0 despite 122 people.
        // Honor this endpoint's documented contract: pod-wide returned regardless.
        includePodWide: true,
      });
      return c.json(result, 200);
    } catch (err) {
      logger.error({ err, userId }, "getEntities failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── GET /entities ───────────────────────────────────────────────────────
  // Canonical list/search endpoint. Must be registered before GET /entities/:id
  // so Hono's first-match router does not capture `/entities` as an id.
  const listEntitiesRoute = createRoute({
    method: "get",
    path: "/entities",
    tags: ["Entities"],
    summary: "Search/list entities",
    description:
      "Canonical list/search endpoint. When `q` is set, performs a Typesense " +
      "search; otherwise lists entities with normal scoping.",
    request: {
      query: z.object({
        q: z.string().optional().describe("Free-text search query."),
        profileSlug: z.string().optional(),
        workspaceId: z.string().optional(),
        projectId: z
          .string()
          .optional()
          .describe(
            "Project lens — narrows results to a single project's data " +
              "(the project entity + everything that belongs_to it). " +
              "Pure-narrowing; cannot widen access past the user floor."
          ),
        limit: z.string().optional(),
        offset: z
          .string()
          .optional()
          .describe(
            "Zero-based offset for cursor-free pagination (default 0)."
          ),
        sort: z.string().optional().describe("e.g. `updatedAt:desc`."),
        scope: z
          .enum(["pod", "workspace", "all"])
          .optional()
          .describe(
            "`pod` = pod-wide entities only (null workspaceId); " +
              "`workspace` = single workspace (requires workspaceId); " +
              "`all` = merge across all accessible workspaces."
          ),
        includePodWide: z
          .string()
          .optional()
          .describe(
            "When a workspaceId is supplied, include pod-wide (null " +
              "workspaceId) globals in the result. Defaults to `true` " +
              "so a workspace lens returns 'that workspace + pod-wide " +
              "globals' — the behavior agents and the CRM expect. " +
              "Set `false` to return only the exact workspace's rows."
          ),
        facetSlug: z
          .string()
          .optional()
          .describe(
            "Kind + Facets filter — only return entities carrying a live " +
              "facet of this role-profile slug (e.g. `investor`)."
          ),
        facetProfileId: z
          .string()
          .optional()
          .describe(
            "Same as facetSlug but by profile id. Wins if both are set."
          ),
      }),
    },
    responses: {
      200: {
        description: "Array of entities",
        content: { "application/json": { schema: z.array(WireEntitySchema) } },
      },
      401: {
        description: "Unauthorized",
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

  app.openapi(listEntitiesRoute, async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }

    const userId = c.get("userId") as string;
    if (!userId) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const query = c.req.valid("query");
    const q = (query.q ?? "").trim();
    const profileSlug = query.profileSlug || undefined;
    const workspaceIdParam = query.workspaceId || null;
    const projectIdParam = query.projectId || undefined;
    const limitRaw = query.limit;
    const limit = Math.min(
      Math.max(parseInt(limitRaw ?? "20", 10) || 20, 1),
      1000
    );
    const offset = Math.max(parseInt(query.offset ?? "0", 10) || 0, 0);
    const sortParam = (query.sort ?? "").trim();
    const scope = query.scope;
    // Default TRUE: a workspace lens should include pod-wide globals (the caller's
    // own pod-personal entities with workspaceId IS NULL) so a CRM or agent view
    // sees pod-wide profiles (person, company…) alongside workspace-specific data.
    // Callers that want ONLY the exact workspace's rows must explicitly pass "false".
    const includePodWide = query.includePodWide !== "false";
    const facetSlug = query.facetSlug || undefined;
    const facetProfileId = query.facetProfileId || undefined;

    try {
      const effectiveWsIds = workspaceIdParam
        ? [workspaceIdParam]
        : await getUserAccessibleWorkspaceIds(userId);
      if (effectiveWsIds.length === 0) {
        return c.json([], 200);
      }

      if (workspaceIdParam) {
        const ok = await verifyWorkspaceReadAccess(userId, workspaceIdParam);
        if (!ok) {
          return c.json({ error: "Access denied to workspace" }, 403);
        }
      }

      // When a workspace lens is PROVIDED, pin the caller to it (unchanged).
      // When OMITTED, leave the caller lens NULL so the default list branch below
      // resolves to the USER FLOOR (all accessible workspaces + pod-wide globals)
      // via the tRPC `list` "no lens" path — instead of silently pinning to the
      // first accessible workspace (`effectiveWsIds[0]`), which hid pod-wide reads.
      const callerWorkspaceId = workspaceIdParam ?? null;

      const caller = await getCaller(c, {
        workspaceId: callerWorkspaceId,
        userId,
      });

      if (q.length > 0) {
        const searchResp = await caller.search.search({
          userId,
          query: q,
          workspaceId: workspaceIdParam || undefined, // undefined = cross-workspace search
          collections: ["entities"],
          limit,
          page: 1,
        });

        let docs = searchResp.results
          .filter((r) => r.collection === "entities")
          .map((r) => r.document as Record<string, unknown>);

        if (profileSlug) {
          docs = docs.filter(
            (d) =>
              (d.entityType as string | undefined) === profileSlug ||
              (d.type as string | undefined) === profileSlug
          );
        }

        return c.json(
          docs.map((d) => entityToWire(d)),
          200
        );
      }

      if (scope === "all" && effectiveWsIds.length > 0) {
        const settled = await Promise.allSettled(
          effectiveWsIds.map((wsId) =>
            caller.entities.getEntities({
              userId,
              workspaceId: wsId,
              profileSlug: profileSlug || undefined,
              limit,
              includePodWide,
              ...(projectIdParam ? { projectId: projectIdParam } : {}),
              ...(facetSlug ? { facetSlug } : {}),
              ...(facetProfileId ? { facetProfileId } : {}),
            })
          )
        );
        const fulfilled = settled.flatMap((r) =>
          r.status === "fulfilled" ? (r.value as unknown[]) : []
        );
        let rows = (fulfilled as unknown[]).map((e) => entityToWire(e));
        const seen = new Set<string>();
        rows = rows.filter((r) => {
          const id = (r as { id?: string }).id;
          if (!id || seen.has(id)) return false;
          seen.add(id);
          return true;
        });
        if (
          sortParam.includes("updatedAt") &&
          sortParam.toLowerCase().includes("desc")
        ) {
          rows = [...rows].sort((a, b) => {
            const tb = new Date(
              String((b as { updatedAt?: unknown }).updatedAt ?? 0)
            ).getTime();
            const ta = new Date(
              String((a as { updatedAt?: unknown }).updatedAt ?? 0)
            ).getTime();
            return tb - ta;
          });
        }
        return c.json(rows.slice(0, limit), 200);
      }

      const listed = await caller.entities.getEntities({
        userId,
        workspaceId: workspaceIdParam || undefined,
        profileSlug: profileSlug || undefined,
        limit,
        offset,
        includePodWide,
        ...(projectIdParam ? { projectId: projectIdParam } : {}),
        ...(facetSlug ? { facetSlug } : {}),
        ...(facetProfileId ? { facetProfileId } : {}),
      });

      let rows = (listed as unknown[]).map((e) => entityToWire(e));

      if (
        sortParam.includes("updatedAt") &&
        sortParam.toLowerCase().includes("desc")
      ) {
        rows = [...rows].sort((a, b) => {
          const tb = new Date(String(b.updatedAt ?? 0)).getTime();
          const ta = new Date(String(a.updatedAt ?? 0)).getTime();
          return tb - ta;
        });
      }

      return c.json(rows, 200);
    } catch (err) {
      logger.error({ err, userId }, "GET /entities failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── GET /entities/:id/connections ───────────────────────────────────────
  // Declared BEFORE /entities/:id so Hono routes this static-prefix segment
  // first.
  const getConnectionsRoute = createRoute({
    method: "get",
    path: "/entities/{id}/connections",
    tags: ["Entities"],
    summary: "Get a single entity's relations",
    description:
      "Returns up to `limit` relations (default 50, max 200) connected to " +
      "the entity. Workspace-scoped on shared pods.",
    request: {
      params: z.object({ id: z.string() }),
      query: z.object({
        userId: z.string().optional(),
        workspaceId: z.string().optional(),
        limit: z.string().optional(),
      }),
    },
    responses: {
      200: {
        description: "Relations list with summary counts",
        content: {
          "application/json": {
            // Loose record — `getConnections` returns
            // `{ connections: [...], counts: { ... } }` plus extra fields.
            // Sidecars / clients normalize on their end.
            schema: z.record(z.string(), z.unknown()),
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

  app.openapi(getConnectionsRoute, async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const { id: entityId } = c.req.valid("param");
    const query = c.req.valid("query");
    const limitParam = query.limit;
    const limit = limitParam
      ? Math.min(200, Math.max(1, Number(limitParam)))
      : 50;

    // Bind the acting identity to the authenticated principal — a session caller
    // can't read another user's connections via ?userId=. Membership-checks the
    // (resolved-or-default) workspace for the bound user.
    const acting = await resolveActingContext(c, {
      userId: query.userId,
      workspaceId: query.workspaceId,
    });
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    const { userId } = acting;
    // Item 3 Part 3: confine a bound service key to its workspace (narrows this read).
    const workspaceId = getConfinedWorkspace(c, acting.workspaceId);

    try {
      const scopes = c.get("scopes") as string[];
      const ctx = await createHubProtocolCallerContext(
        userId,
        scopes,
        workspaceId ?? undefined
      );
      const caller = relationsRouter.createCaller(
        ctx as Parameters<typeof relationsRouter.createCaller>[0]
      );
      const result = await caller.getConnections({
        entityId,
        limit,
        workspaceId: workspaceId ?? undefined,
      });
      return c.json(result, 200);
    } catch (err) {
      logger.error({ err, entityId }, "getConnections failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── GET /entities/:id ───────────────────────────────────────────────────
  // Fetch a single entity by ID. Used by skill trigger executor to get entity
  // context. On shared pods, verifies the entity belongs to a workspace the
  // user can access.
  const getEntityRoute = createRoute({
    method: "get",
    path: "/entities/{id}",
    tags: ["Entities"],
    summary: "Fetch a single entity",
    description:
      "Returns the entity row by ID. Verifies workspace access on shared pods.",
    request: {
      params: z.object({ id: z.string() }),
      // No workspaceId: a single-entity fetch resolves visibility from the user
      // floor (verified below against the entity's OWN workspace), never the
      // caller's lens. The param was accepted and advertised in OpenAPI but the
      // handler never read it.
      query: z.object({
        userId: z.string().optional(),
      }),
    },
    responses: {
      200: {
        description: "Entity row",
        content: { "application/json": { schema: RawEntityRecordSchema } },
      },
      403: {
        description: "Forbidden",
        content: { "application/json": { schema: ErrorSchema } },
      },
      404: { description: "Not found" },
      500: {
        description: "Internal error",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(getEntityRoute, async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const { id: entityId } = c.req.valid("param");
    const query = c.req.valid("query");
    // Bind the identity used for the access check to the authenticated principal.
    // A session caller can't read an entity by claiming another user's ?userId=
    // (the access check below verifies THIS user against the entity's workspace).
    const authUserId = c.get("userId") as string | undefined;
    if (!authUserId) return c.json({ error: "Unauthenticated" }, 403);
    const isServiceKey = !!c.get("apiKeyId");
    if (!isServiceKey && query.userId && query.userId !== authUserId) {
      return c.json(
        { error: "userId does not match the authenticated session" },
        403
      );
    }
    const userId = isServiceKey ? (query.userId ?? authUserId) : authUserId;
    try {
      const result = await db.query.entities.findFirst({
        where: and(
          eq(entities.id, entityId),
          isNull(entities.deletedAt),
          or(
            and(isNull(entities.workspaceId), eq(entities.userId, userId)),
            isNotNull(entities.workspaceId)
          )
        ),
      });
      if (!result) return c.body(null, 404);
      if (result.workspaceId) {
        const hasAccess = await verifyWorkspaceReadAccess(
          userId,
          result.workspaceId
        );
        if (!hasAccess) {
          return c.json({ error: "Access denied to entity's workspace" }, 403);
        }
      }
      return c.json(result, 200);
    } catch (err) {
      logger.error({ err, entityId }, "entities.get failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Internal error" },
        500
      );
    }
  });

  // ── POST /entities/recall ───────────────────────────────────────────────
  // Hybrid semantic recall: Typesense keyword + pgvector cosine search, merged
  // via Reciprocal Rank Fusion (RRF). Must be registered BEFORE POST /entities
  // so Hono's first-match router does not confuse "recall" with an entity id.
  const recallEntitiesRoute = createRoute({
    method: "post",
    path: "/entities/recall",
    tags: ["Entities"],
    summary: "Hybrid semantic recall",
    description:
      "Combines Typesense keyword search and pgvector cosine similarity search, " +
      "merged via Reciprocal Rank Fusion (RRF k=60). Falls back to Typesense-only " +
      "when the embedding service is unavailable.",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              query: z.string().min(1),
              profileSlug: z.string().optional(),
              workspaceId: z.string().optional(),
              limit: z.number().int().min(1).max(100).optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Merged entity results",
        content: {
          "application/json": {
            schema: z.object({
              entities: z.array(z.record(z.string(), z.unknown())),
              source: z.enum(["hybrid", "typesense"]),
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

  app.openapi(recallEntitiesRoute, async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const userId = c.get("userId") as string;
    if (!userId) {
      return c.json({ error: "Unauthorized" }, 403);
    }

    const body = c.req.valid("json");
    const { query, profileSlug, workspaceId } = body;
    const limit = body.limit ?? 20;

    // Hybrid recall (pgvector + Typesense + RRF), optionally type-scoped — the
    // ONE canonical implementation, shared with the retrieval engine so the two
    // paths can't drift. (POST /entities/retrieve adds type inference on top.)
    const { ids: rankedIds, usedVector } = await hybridRecall({
      query,
      userId,
      workspaceId,
      profileSlug,
      limit,
    });
    const source: "hybrid" | "typesense" = usedVector ? "hybrid" : "typesense";

    if (rankedIds.length === 0) {
      return c.json({ entities: [] as Record<string, unknown>[], source }, 200);
    }

    // ── Fetch full entity rows for top ids ─────────────────────────────────
    // Security: AND the floor predicate so a ranked-but-inaccessible id
    // (e.g. another user's pod-personal entity that slipped through the
    // vector/keyword index) cannot leak. The floor mirrors entityVisibleWhere:
    //   pod-personal rows → gated by userId;
    //   workspace rows    → gated by workspace membership (userVisibleWhere).
    try {
      const floor = or(
        and(isNull(entities.workspaceId), eq(entities.userId, userId)),
        and(
          isNotNull(entities.workspaceId),
          userVisibleWhere(entities.workspaceId, userId)
        )
      )!;
      const rows = await db
        .select()
        .from(entities)
        .where(
          and(
            inArray(entities.id, rankedIds),
            isNull(entities.deletedAt),
            floor
          )
        );

      // Re-sort to match RRF rank order
      const byId = new Map(rows.map((r) => [r.id, r]));
      const ordered = rankedIds
        .map((id) => byId.get(id))
        .filter((r): r is NonNullable<typeof r> => r !== undefined);

      return c.json(
        { entities: ordered as Record<string, unknown>[], source },
        200
      );
    } catch (err) {
      logger.error({ err, userId }, "POST /entities/recall fetch failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Internal error" },
        500
      );
    }
  });

  // ── POST /entities/retrieve ─────────────────────────────────────────────
  // Synap Retrieval Engine (Phase 1). Unlike /entities/recall (raw hybrid
  // signal), this INFERS the target entity type(s) + property hints from the
  // natural-language query and fuses unscoped recall with type-scoped recall,
  // so "who is the VP of Product" surfaces the person (with role=VP Product) and
  // "what did we decide" surfaces the decision — the queries raw recall missed at
  // top-K. Returns the `understanding` for glass-box retrieval + eval.
  // See team/platform/retrieval-architecture.mdx.
  const retrieveEntitiesRoute = createRoute({
    method: "post",
    path: "/entities/retrieve",
    tags: ["Entities"],
    summary: "Type-aware hybrid retrieval (Synap Retrieval Engine)",
    deprecated: true,
    description:
      "DEPRECATED — prefer POST /knowledge/ask, whose semantic lane calls the exact same retrieve() SRE. Still functional for existing integrations. " +
      "Infers entity type(s) + property hints from the query, fuses unscoped + " +
      "type-scoped recall (RRF), and returns ranked entities plus the inferred " +
      "understanding. Phase 1 of the SRE.",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              query: z.string().min(1),
              workspaceId: z.string().optional(),
              limit: z.number().int().min(1).max(100).optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Ranked entities + retrieval understanding",
        content: {
          "application/json": {
            schema: z.object({
              entities: z.array(z.record(z.string(), z.unknown())),
              understanding: z.record(z.string(), z.unknown()),
              source: z.enum(["hybrid", "typesense"]),
              verdict: z.enum(["confident", "ambiguous", "empty"]),
            }),
          },
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

  app.openapi(retrieveEntitiesRoute, async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const userId = c.get("userId") as string | undefined;
    if (!userId) return c.json({ error: "Unauthenticated" }, 403);

    const body = c.req.valid("json");
    // Item 3 Part 3: confine a bound service key to its workspace (narrows this read).
    const workspaceId =
      getConfinedWorkspace(c, body.workspaceId ?? null) ?? null;

    try {
      // The CATALOG (for type inference) needs a concrete workspace — listProfiles
      // requires one — so resolve the user's first accessible workspace when no
      // lens is pinned. But RECALL keeps the caller's requested lens: a null
      // workspaceId means user-scoped / pod-wide results, NOT workspace-0 results.
      // (Catalog from one workspace + pod-wide recall is fine: profile slugs are
      // largely shared, and a missing slug just means no type-scoped boost.)
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

      const result = await retrieve({
        query: body.query,
        userId,
        workspaceId, // caller's lens (null = pod-wide), NOT the catalog workspace
        limit: body.limit,
        catalog,
      });
      return c.json(result, 200);
    } catch (err) {
      logger.error({ err, userId }, "POST /entities/retrieve failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Internal error" },
        500
      );
    }
  });

  // ── POST /entities ──────────────────────────────────────────────────────
  // Creates an entity on behalf of a user. Auth via API key or session token.
  //
  // Returns the underlying tRPC result plus the resolved `effectiveWorkspaceId`
  // so callers can echo back the workspace the entity actually landed in
  // (useful for pod-wide profiles where workspaceId is null).
  const createEntityRoute = createRoute({
    method: "post",
    path: "/entities",
    tags: ["Entities"],
    summary: "Create an entity",
    description:
      "Creates an entity on behalf of a user. Honors profile.entityScope: " +
      "pod-wide profiles ignore workspaceId. Supports `Idempotency-Key`.",
    request: {
      body: {
        content: {
          "application/json": { schema: CreateEntityRequestSchema },
        },
      },
    },
    responses: {
      200: {
        description: "Created entity (with effectiveWorkspaceId echo)",
        content: {
          "application/json": { schema: CreateEntityResponseSchema },
        },
      },
      400: {
        description: "Bad request",
        content: { "application/json": { schema: ErrorSchema } },
      },
      403: {
        description: "Missing scope",
        content: { "application/json": { schema: ErrorSchema } },
      },
      404: {
        description: "Referenced profile not found",
        content: { "application/json": { schema: ErrorSchema } },
      },
      500: {
        description: "Internal error",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(createEntityRoute, async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }

    const body = c.req.valid("json");

    // Resolve the profile. Precedence: explicit profileId (UUID) → profileSlug →
    // deprecated `type` alias → "note" as a sane default. Previously this
    // hardcoded "bookmark" and ignored profileId entirely, so an agent creating
    // a task (by profileId) had it silently stored as a bookmark and never
    // appeared in profile-scoped views (e.g. the Task Board kanban).
    let profileSlug = body.profileSlug ?? body.type;
    if (body.profileId) {
      const byId = await db.query.profiles.findFirst({
        where: eq(profiles.id, body.profileId),
        columns: { slug: true },
      });
      if (!byId) {
        return c.json(
          { error: `profileId not found on this pod: ${body.profileId}` },
          400
        );
      }
      profileSlug = byId.slug;
    }
    if (!profileSlug) profileSlug = "note";

    // ALL rows for the slug, not findFirst: twins can carry different
    // entityScopes and this feeds an AUTH branch (pod-wide skips the
    // workspace-membership check) — fail closed: only skip the check when the
    // slug is UNAMBIGUOUSLY pod-wide across every row.
    const profileRows = await db.query.profiles.findMany({
      where: eq(profiles.slug, profileSlug),
      columns: { entityScope: true },
    });
    const isPodWide =
      profileRows.length === 0 ||
      profileRows.every((p) => p.entityScope === "pod");

    // Bind the acting identity to the authenticated principal (closes the IDOR:
    // a session caller can't act as another user via body.userId). For
    // workspace-scoped profiles, resolveActingContext also membership-checks the
    // target workspace for the resolved user. Pod-wide profiles need no
    // workspace, so we bind identity without forcing workspace resolution
    // (preserving the previous "pod-wide profiles ignore workspaceId" behavior).
    let userId: string;
    let effectiveWorkspaceId: string | null;
    if (isPodWide && !body.workspaceId) {
      const authUserId = c.get("userId") as string | undefined;
      if (!authUserId) return c.json({ error: "Unauthenticated" }, 403);
      const isServiceKey = !!c.get("apiKeyId");
      if (!isServiceKey && body.userId && body.userId !== authUserId) {
        return c.json(
          { error: "userId does not match the authenticated session" },
          403
        );
      }
      userId = isServiceKey ? (body.userId ?? authUserId) : authUserId;
      effectiveWorkspaceId = null;
    } else {
      // Reached when an explicit body.workspaceId is present, or the profile is
      // workspace-scoped. resolveActingContext binds the identity and verifies
      // the resolved user's membership in the (explicit-or-default) workspace.
      // Mirror the original: an explicit workspaceId is honored even for pod-wide
      // profiles; a workspace-scoped profile with no body.workspaceId lands in
      // the user's default (membership-checked) workspace.
      const acting = await resolveActingContext(c, body);
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);
      userId = acting.userId;
      // This branch is only reached with an explicit body.workspaceId or a
      // workspace-scoped profile, so the membership-checked workspace applies.
      effectiveWorkspaceId = acting.workspaceId;
    }

    // Item 3 Part 3: confine a bound service key to its workspace — clamp the
    // resolved workspace, then feed it to the caller ctx and the re-supplied
    // createEntity input below (input would otherwise win over the ctx pin).
    effectiveWorkspaceId =
      getConfinedWorkspace(c, effectiveWorkspaceId) ?? null;

    try {
      // body.agentUserId wins; fall back to the auto-injected context value so
      // agents using their own API key get proposal attribution without passing it.
      const ctxAgentUserId = c.get("agentUserId") as string | undefined;
      const resolvedAgentUserId = body.agentUserId ?? ctxAgentUserId;

      const actorResolution = await resolveActorId(resolvedAgentUserId, userId);
      if ("error" in actorResolution)
        return c.json({ error: actorResolution.error }, 400);
      // resolveActorId is kept for its validation side-effect above; the entity
      // is attributed via resolvedAgentUserId below, so its return is unused.

      const sessionId = body.sessionId ?? c.req.header("x-session-id") ?? null;
      const caller = await getCaller(c, {
        workspaceId: effectiveWorkspaceId,
        userId,
        sourceMessageId: body.sourceMessageId,
        sessionId,
      });
      const result = await caller.entities.createEntity({
        userId,
        ...(resolvedAgentUserId ? { agentUserId: resolvedAgentUserId } : {}),
        profileSlug,
        title: body.title,
        description: body.description,
        properties: body.properties,
        ...(body.projectId ? { projectId: body.projectId } : {}),
        // EXPLICIT workspace pin only (rung-1). `effectiveWorkspaceId` already
        // flows as the ambient/governance lens via getCaller above, so a
        // workspace-scope profile lands in its default workspace and a pod-scope
        // profile lands pod-wide — WITHOUT a pin. Passing the resolved default as
        // a pin here would wrongly workspace-pin pod-scope kinds (the four-door
        // bug). Only a caller-supplied `body.workspaceId` overrides entityScope.
        ...(body.workspaceId
          ? { workspaceId: effectiveWorkspaceId ?? undefined }
          : {}),
        // Long-form body → linked document (versioned). Must be forwarded here
        // or it's silently dropped before the entity-create document flow.
        ...(body.content ? { content: body.content } : {}),
        ...(body.reasoning ? { reasoning: body.reasoning } : {}),
        ...(body.source ? { source: body.source } : {}),
        // Kind + Facets: attach roles in the same call (handled by the governed
        // createEntity door, which attaches each after the entity materializes).
        ...(body.facets?.length ? { facets: body.facets } : {}),
      });

      // ── Impact-aware writes (SHALLOW, exact-name) ─────────────────────────
      // Turn the agent from a blind writer into a gardener: tell it what already
      // exists under the same name, and auto-connect cross-profile facets.
      // ADVISORY — any failure here must NOT break the write (the entity is
      // already created above). The `resolution` block is purely additive.
      const { writeReceipt, resolution } = await buildCreateEntityReceipt({
        result: result as Record<string, unknown>,
        profileSlug,
        effectiveWorkspaceId,
        userId,
        scopes: c.get("scopes") as string[],
        title: body.title,
        ...(body.projectId ? { projectId: body.projectId } : {}),
        ...(body.source ? { source: body.source } : {}),
        ...(resolvedAgentUserId ? { resolvedAgentUserId } : {}),
      });

      // Echo back the resolved workspace context so external callers can
      // confirm where the entity landed (especially useful when the body
      // omitted workspaceId and we resolved it from the profile's entityScope).
      return c.json(
        {
          ...result,
          effectiveWorkspaceId,
          writeReceipt,
          ...(resolution ? { resolution } : {}),
        },
        200
      );
    } catch (err) {
      logger.error({ err }, "createEntity failed");
      // Classify instead of a blanket 500: a PropertyValidationError (unknown /
      // invalid property) is a fixable CLIENT mistake and must come back as 400
      // with its message, so the agent can correct itself. `facetErrorStatus`
      // (defined further down, same closure) already walks the cause chain and
      // duck-types the codes/names; genuinely-unknown errors still return 500.
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        facetErrorStatus(err)
      );
    }
  });

  // ── POST /entities/:entityId/attachments ────────────────────────────────
  // Upload an image (base64) and attach it to an existing entity — the SERVICE
  // (Hub-key) counterpart of the Kratos-authed multipart `POST /upload`. The
  // Discord bridge uses this to attach e.g. a selfie to a freshly-captured lead.
  //
  // Reuses `uploadBufferAsFileEntity` (the exact storage → document → file-entity
  // pipeline the /upload route runs), then LINKS the new file entity to the
  // target via the canonical entity↔entity `relations.create` procedure (which
  // inherits governance: an agent key either applies the edge or returns a
  // reviewable proposal). Relation TYPE is "references" — the established default
  // for generic entity associations (mirrors cell-instances' `relationType ??
  // "references"` and the seeded `references` relation def). "attachment" is NOT
  // used because it is not a seeded/built-in relation type and would be rejected
  // by relations.create's type validation.
  const attachEntityRoute = createRoute({
    method: "post",
    path: "/entities/{entityId}/attachments",
    tags: ["Entities"],
    summary: "Attach an image (uploaded or pre-stored) to an entity",
    description:
      "Service (Hub API-key) route. Two modes: (1) upload+link — base64-decode " +
      "an image, store it as a file entity (document + snapshot); (2) link-only " +
      "— pass `fileEntityId` to link a previously-stored orphan file. Either way " +
      "the file is linked to :entityId via a `references` relation. Upload mode: " +
      "max 10MB, image/* only. Requires scope hub-protocol.write.",
    request: {
      params: z.object({ entityId: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              userId: z.string().optional(),
              workspaceId: z.string().optional(),
              // Upload+link mode: provide the image bytes. A NEW file entity is
              // created and linked.
              filename: z.string().min(1).optional(),
              mimeType: z.string().min(1).optional(),
              contentBase64: z.string().min(1).optional(),
              // Link-only mode: reference a file entity that was already stored
              // (e.g. via POST /files when the photo arrived uncaptioned). The
              // upload is skipped — only the `references` edge is created.
              fileEntityId: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Created file entity + link result",
        content: { "application/json": { schema: z.object({}).passthrough() } },
      },
      400: {
        description: "Bad request",
        content: { "application/json": { schema: ErrorSchema } },
      },
      403: {
        description: "Forbidden",
        content: { "application/json": { schema: ErrorSchema } },
      },
      404: { description: "Target entity not found" },
      413: {
        description: "File too large",
        content: { "application/json": { schema: ErrorSchema } },
      },
      415: {
        description: "Unsupported media type",
        content: { "application/json": { schema: ErrorSchema } },
      },
      500: {
        description: "Internal error",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(attachEntityRoute, async (c): Promise<any> => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const { entityId } = c.req.valid("param");
    const body = c.req.valid("json");

    // Mode select: link-only when `fileEntityId` is present (skip the upload and
    // its byte guards), else upload+link (validate + decode the image bytes).
    const linkOnly = !!body.fileEntityId;
    let buffer: Buffer | undefined;
    if (!linkOnly) {
      if (!body.filename || !body.mimeType || !body.contentBase64) {
        return c.json(
          {
            error:
              "filename, mimeType and contentBase64 are required (or pass fileEntityId for link-only)",
          },
          400
        );
      }
      // image/* only + 10MB cap (same limits as the multipart /upload route).
      if (!body.mimeType.startsWith("image/")) {
        return c.json(
          { error: `Only image/* uploads are allowed (got ${body.mimeType})` },
          415
        );
      }
      try {
        buffer = Buffer.from(body.contentBase64, "base64");
      } catch {
        return c.json({ error: "contentBase64 is not valid base64" }, 400);
      }
      if (buffer.length === 0) {
        return c.json({ error: "Decoded file is empty" }, 400);
      }
      if (buffer.length > MAX_FILE_SIZE) {
        return c.json(
          {
            error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB`,
          },
          413
        );
      }
    }

    // Bind acting identity to the authenticated principal (service key may pass
    // body.userId for on-behalf-of; a session caller may not). Mirrors the PATCH
    // route below.
    const authUserId = c.get("userId") as string | undefined;
    if (!authUserId) return c.json({ error: "Unauthenticated" }, 403);
    const isServiceKey = !!c.get("apiKeyId");
    if (!isServiceKey && body.userId && body.userId !== authUserId) {
      return c.json(
        { error: "userId does not match the authenticated session" },
        403
      );
    }
    const userId = isServiceKey ? (body.userId ?? authUserId) : authUserId;

    try {
      // Resolve + verify the TARGET entity is visible to the acting user, and
      // derive the workspace the attachment lands in from the target itself
      // (mirror of the PATCH guard). This ensures a caller can only attach to an
      // entity it can actually see, and keeps the file entity in the same lens.
      const target = await db.query.entities.findFirst({
        where: and(
          eq(entities.id, entityId),
          isNull(entities.deletedAt),
          or(
            and(isNull(entities.workspaceId), eq(entities.userId, userId)),
            isNotNull(entities.workspaceId)
          )
        ),
        columns: { id: true, workspaceId: true },
      });
      if (!target) return c.body(null, 404);
      // Attaching a file is a WRITE — it creates a file entity + relation in the
      // target's scope. The file ALWAYS lands in the target's own scope (never a
      // caller-supplied workspaceId — that would let a caller inject into a
      // foreign workspace via a pod-personal target). A workspace-scoped target
      // requires MEMBERSHIP (verifyWorkspaceAccess), not mere pod-read-visibility
      // — reads must not authorize writes. A pod-personal target (null ws) is
      // already gated above to the caller's own entities.
      const effectiveWorkspaceId = target.workspaceId ?? null;
      if (
        effectiveWorkspaceId &&
        !(await verifyWorkspaceAccess(userId, effectiveWorkspaceId))
      ) {
        return c.json(
          { error: "Access denied: not a member of the entity's workspace" },
          403
        );
      }

      // A pod-scoped target (person / company / contact — entityScope 'pod', so
      // the row's workspaceId is null) has no workspace to host the
      // workspace-scoped `references` relation, and `relations.create` rejects a
      // null workspace. Fall back to the caller's workspace (validated) so the
      // file + link land in the caller's lens. SAFE: a null-workspace target is
      // already gated above to the caller's OWN entities, so this can never
      // inject into a foreign scope. This is what makes "attach a photo to a
      // contact" work (the primary capture case), since contacts are pod-scoped.
      let linkWorkspaceId: string | null = effectiveWorkspaceId;
      if (!linkWorkspaceId && body.workspaceId) {
        if (await verifyWorkspaceAccess(userId, body.workspaceId)) {
          linkWorkspaceId = body.workspaceId;
        }
      }
      // Item 3 Part 3: confine a bound service key to its workspace — clamp the
      // resolved link workspace before it flows to the upload, the caller ctx,
      // and the re-supplied relations input below.
      linkWorkspaceId = getConfinedWorkspace(c, linkWorkspaceId) ?? null;

      // 1. Obtain the file entity id — either freshly uploaded (upload+link) or
      //    the pre-stored orphan the caller referenced (link-only). Upload lands
      //    the `file` entity (document + v1 snapshot) in the target's workspace.
      let uploaded:
        Awaited<ReturnType<typeof uploadBufferAsFileEntity>> | undefined;
      let fileEntityId: string;
      if (linkOnly) {
        fileEntityId = body.fileEntityId as string;
      } else {
        uploaded = await uploadBufferAsFileEntity({
          userId,
          workspaceId: linkWorkspaceId,
          buffer: buffer as Buffer,
          mimeType: body.mimeType as string,
          filename: body.filename as string,
        });
        fileEntityId = uploaded.entity.id;
      }

      // 2. LINK target --references--> file via the canonical relations.create
      //    procedure. GOVERNANCE (capture path = no proposals): this `references`
      //    edge AUTO-APPLIES rather than filing a proposal because `relation.create`
      //    is in DEFAULT_AUTO_APPROVE (@synap/governance-policy) — so the agent
      //    policy ladder resolves to "execute" whether the edge is attributed to
      //    the caller's own agent or (on the X-Capture path, below) the seeded
      //    Capture agent, whose explicit autoApproveFor also covers relation.create.
      //    Workspace-write RBAC is still enforced by the membership check above.
      const scopes = c.get("scopes") as string[];
      // On the capture path (X-Capture: 1) attribute the `references` edge to the
      // seeded Capture agent so the link carries "captured by Capture" provenance;
      // a non-capture caller keeps its own agent identity.
      const relAgentUserId = await resolveCaptureActorUserId(
        c,
        c.get("agentUserId") as string | undefined
      );
      const relCtx = await createHubProtocolCallerContext(
        userId,
        scopes,
        linkWorkspaceId ?? undefined,
        undefined,
        undefined,
        relAgentUserId
      );
      const relCaller = relationsRouter.createCaller(
        relCtx as Parameters<typeof relationsRouter.createCaller>[0]
      );
      let link: unknown = null;
      try {
        link = await relCaller.create({
          sourceEntityId: entityId,
          targetEntityId: fileEntityId,
          type: "references",
          ...(linkWorkspaceId ? { workspaceId: linkWorkspaceId } : {}),
        });
      } catch (relErr) {
        // The file entity IS created; surface the link failure without losing it.
        logger.warn(
          { relErr, entityId, fileEntityId },
          "attachment: relation create failed"
        );
        link = {
          error:
            relErr instanceof Error ? relErr.message : "relation create failed",
        };
      }

      // Presigned url for the image if storage can mint one; else the stored url.
      // Only present in upload mode (link-only has no fresh upload to sign).
      let url = uploaded?.url;
      if (uploaded) {
        try {
          url = await storage.getSignedUrl(uploaded.storageKey, 3600);
        } catch {
          // Non-fatal — fall back to the canonical storage url.
        }
      }

      return c.json(
        {
          fileEntityId,
          ...(uploaded ? { documentId: uploaded.document.id, url } : {}),
          link,
        },
        200
      );
    } catch (err) {
      logger.error({ err, entityId }, "POST /entities/:id/attachments failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── POST /entities/:entityId/source-file ─────────────────────────────────
  // Attach a raw source blob (WAV, PDF, …) as PROVENANCE on an existing entity
  // without creating a second `file` entity. Shared with capture keepRaw via
  // storeEntitySourceBlob. Hub API-key door so CLI bulk import (Superwhisper)
  // does not need a Kratos cookie.
  //
  // Accepts multipart/form-data (preferred for audio) OR JSON base64 for small
  // blobs. Max SOURCE_BLOB_MAX_BYTES (32MB). audio/* | video/* | image/* |
  // application/pdf | application/octet-stream allowed.
  app.post("/entities/:entityId/source-file", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const entityId = c.req.param("entityId");
    if (!entityId) {
      return c.json({ error: "entityId is required" }, 400);
    }

    const acting = await resolveActingContext(c, {});
    if (!acting.ok) {
      return c.json({ error: acting.error }, acting.status);
    }
    const userId = acting.userId;

    // Confirm the entity exists and is owned by the acting user (pod-wide or workspace).
    const existing = await db.query.entities.findFirst({
      where: and(eq(entities.id, entityId), eq(entities.userId, userId)),
      columns: { id: true, workspaceId: true },
    });
    if (!existing) {
      return c.json({ error: "Entity not found" }, 404);
    }

    const contentType = c.req.header("content-type") ?? "";
    let buffer: Buffer;
    let mimeType: string;
    let filename: string | undefined;
    let workspaceId: string | null | undefined = existing?.workspaceId ?? null;

    try {
      if (contentType.includes("multipart/form-data")) {
        const body = await c.req.parseBody({ all: true });
        const file = body["file"];
        if (!file || !(file instanceof File)) {
          return c.json(
            { error: "file is required (multipart file field)" },
            400
          );
        }
        mimeType = file.type || "application/octet-stream";
        filename = file.name || undefined;
        if (typeof body["workspaceId"] === "string" && body["workspaceId"]) {
          workspaceId = body["workspaceId"];
        }
        if (file.size > SOURCE_BLOB_MAX_BYTES) {
          return c.json(
            {
              error: `File too large. Maximum size is ${SOURCE_BLOB_MAX_BYTES / 1024 / 1024}MB`,
            },
            413
          );
        }
        buffer = Buffer.from(await file.arrayBuffer());
      } else {
        // JSON: { contentBase64, mimeType, filename?, workspaceId? }
        const body = (await c.req.json()) as {
          contentBase64?: string;
          mimeType?: string;
          filename?: string;
          workspaceId?: string | null;
        };
        if (!body.contentBase64 || !body.mimeType) {
          return c.json(
            {
              error:
                "contentBase64 and mimeType are required (or use multipart/form-data with file)",
            },
            400
          );
        }
        mimeType = body.mimeType;
        filename = body.filename;
        if (body.workspaceId !== undefined) workspaceId = body.workspaceId;
        buffer = Buffer.from(body.contentBase64, "base64");
      }
    } catch (err) {
      logger.warn({ err, entityId }, "source-file body parse failed");
      return c.json({ error: "Invalid request body" }, 400);
    }

    // Allow media + common document binaries. Not a free-for-all of every MIME.
    const allowed =
      mimeType.startsWith("audio/") ||
      mimeType.startsWith("video/") ||
      mimeType.startsWith("image/") ||
      mimeType === "application/pdf" ||
      mimeType === "application/octet-stream" ||
      mimeType === "application/json" ||
      mimeType.startsWith("text/");
    if (!allowed) {
      return c.json(
        { error: `MIME type not allowed for source-file: ${mimeType}` },
        415
      );
    }

    // Item 3 Part 3: confine a bound service key to its workspace before the
    // DIRECT storeEntitySourceBlob write.
    workspaceId = getConfinedWorkspace(c, workspaceId) ?? null;

    try {
      const result = await storeEntitySourceBlob({
        database: db,
        userId,
        entityId,
        buffer,
        mimeType,
        filename,
        workspaceId: workspaceId ?? null,
      });
      return c.json({
        ok: true as const,
        entityId,
        documentId: result.documentId,
        storageKey: result.storageKey,
        storageUrl: result.storageUrl,
        size: result.size,
        mimeType: result.mimeType,
      });
    } catch (err) {
      if (err instanceof SourceBlobTooLargeError) {
        return c.json({ error: err.message }, 413);
      }
      if (err instanceof SourceBlobEmptyError) {
        return c.json({ error: err.message }, 400);
      }
      logger.error(
        { err, entityId, userId },
        "POST /entities/:id/source-file failed"
      );
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── POST /files ─────────────────────────────────────────────────────────
  // Standalone (orphan) upload — store a blob as a human-owned `document`
  // entity with NO target to link to yet. Returns the entity id so it can be
  // linked later via POST /entities/{id}/attachments (link-only mode).
  //
  // Two request shapes (plain Hono route so multipart is accepted — an
  // OpenAPIHono route validates a single JSON body only, per the source-file
  // precedent above):
  //   • multipart/form-data { file, workspaceId?, userId? } — ARBITRARY mime,
  //     up to MAX_FILE_SIZE (the general agent upload door).
  //   • application/json { workspaceId, filename, mimeType, contentBase64,
  //     userId? } — ANY allowed mime (same `isAllowedMimeType` allowlist as the
  //     multipart branch). Originally the Discord image carry-through contract
  //     (Wave 1); the mime gate is now the shared allowlist, not image/* only.
  // Either way the blob flows through uploadBufferAsFileEntity (provenance =
  // human), which now mints a `document` entity by default. Response shape stays
  // `{ fileEntityId, documentId }` — the `fileEntityId` field NAME is kept for
  // backward compatibility even though the kind is now `document`.
  app.post("/files", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }

    // Bound the unreviewed-upload vector per key (30/min). This is a plain Hono
    // route, so map the tRPC-shaped rate-limit throw to a 429 response.
    try {
      checkHubRateLimit(c.get("apiKeyId") as string | undefined, "files");
    } catch {
      return c.json({ error: "Rate limit exceeded for /files" }, 429);
    }

    const contentType = c.req.header("content-type") ?? "";
    // Multipart = the general agent upload door → GOVERNED create path below.
    // JSON/base64 = the original Discord image contract → unchanged direct path.
    const isMultipart = contentType.includes("multipart/form-data");
    let buffer: Buffer;
    let mimeType: string;
    let filename: string;
    let bodyUserId: string | undefined;
    let bodyWorkspaceId: string | undefined;
    let bodyTitle: string | undefined;

    try {
      if (isMultipart) {
        // Multipart: arbitrary mime, up to MAX_FILE_SIZE.
        const body = await c.req.parseBody({ all: true });
        const file = body["file"];
        if (!file || !(file instanceof File)) {
          return c.json(
            { error: "file is required (multipart file field)" },
            400
          );
        }
        mimeType = file.type || "application/octet-stream";
        filename = file.name || "file";
        if (typeof body["userId"] === "string" && body["userId"]) {
          bodyUserId = body["userId"];
        }
        if (typeof body["workspaceId"] === "string" && body["workspaceId"]) {
          bodyWorkspaceId = body["workspaceId"];
        }
        if (typeof body["title"] === "string" && body["title"]) {
          bodyTitle = body["title"];
        }
        if (file.size > MAX_FILE_SIZE) {
          return c.json(
            {
              error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB`,
            },
            413
          );
        }
        buffer = Buffer.from(await file.arrayBuffer());
      } else {
        // JSON base64: any allowed mime (gated by isAllowedMimeType below).
        const body = (await c.req.json()) as {
          userId?: string;
          workspaceId?: string;
          filename?: string;
          mimeType?: string;
          contentBase64?: string;
          title?: string;
        };
        if (
          !body.workspaceId ||
          !body.filename ||
          !body.mimeType ||
          !body.contentBase64
        ) {
          return c.json(
            {
              error:
                "workspaceId, filename, mimeType and contentBase64 are required (or use multipart/form-data with a file field)",
            },
            400
          );
        }
        // Mime is NOT gated to image/* here anymore: the shared
        // `isAllowedMimeType(mimeType)` check below (same allowlist the multipart
        // branch uses) governs BOTH branches → base64 now accepts any allowed
        // type (image/audio/video + the docs allowlist), 415 otherwise.
        mimeType = body.mimeType;
        filename = body.filename;
        bodyUserId = body.userId;
        bodyWorkspaceId = body.workspaceId;
        if (typeof body.title === "string" && body.title)
          bodyTitle = body.title;
        buffer = Buffer.from(body.contentBase64, "base64");
      }
    } catch (err) {
      logger.warn({ err }, "POST /files body parse failed");
      return c.json({ error: "Invalid request body" }, 400);
    }

    if (buffer.length === 0) {
      return c.json({ error: "Decoded file is empty" }, 400);
    }
    if (buffer.length > MAX_FILE_SIZE) {
      return c.json(
        {
          error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB`,
        },
        413
      );
    }
    // Same MIME allowlist as the Kratos `/upload` route — generalizing this door
    // to arbitrary mime must NOT open a stored-XSS vector (SVG/HTML served back
    // with the uploaded Content-Type). image/audio/video + a docs allowlist only.
    if (!isAllowedMimeType(mimeType)) {
      return c.json({ error: `MIME type not allowed: ${mimeType}` }, 415);
    }

    // Bind acting identity to the authenticated principal (service key may pass
    // body.userId for on-behalf-of; a session caller may not). Mirrors the
    // attachments route.
    const authUserId = c.get("userId") as string | undefined;
    if (!authUserId) return c.json({ error: "Unauthenticated" }, 403);
    const isServiceKey = !!c.get("apiKeyId");
    if (!isServiceKey && bodyUserId && bodyUserId !== authUserId) {
      return c.json(
        { error: "userId does not match the authenticated session" },
        403
      );
    }
    const userId = isServiceKey ? (bodyUserId ?? authUserId) : authUserId;

    if (!bodyWorkspaceId) {
      return c.json({ error: "workspaceId is required" }, 400);
    }
    // Item 3 Part 3: confine a bound service key to its workspace before the
    // membership check and the DIRECT uploadBufferAsFileEntity write.
    const workspaceId =
      getConfinedWorkspace(c, bodyWorkspaceId) ?? bodyWorkspaceId;

    // Writing into a workspace requires MEMBERSHIP — reads must not authorize
    // writes (same rule as the attachments route). The entity itself lands
    // pod-wide via the placement resolver (document is a pod-scope kind); the
    // workspace is a storage-path + auth context signal.
    if (!(await verifyWorkspaceAccess(userId, workspaceId))) {
      return c.json(
        { error: "Access denied: not a member of the target workspace" },
        403
      );
    }

    const agentUserId = c.get("agentUserId") as string | undefined;

    // ── JSON/base64 mode: UNCHANGED direct path ────────────────────────────
    // The original Discord attachment carry-through (on-behalf-of-a-human),
    // now accepting any allowed mime (not just image/*).
    // Kept on the direct `uploadBufferAsFileEntity` path to avoid any behavior
    // change to the Discord bridge; provenance is attributed to the agent when
    // an agent key uploads.
    if (!isMultipart) {
      try {
        const uploaded = await uploadBufferAsFileEntity({
          userId,
          workspaceId,
          buffer,
          mimeType,
          filename,
          title: bodyTitle,
          actorAgentUserId: agentUserId,
        });
        return c.json(
          {
            fileEntityId: uploaded.entity.id,
            documentId: uploaded.document.id,
          },
          200
        );
      } catch (err) {
        logger.error({ err }, "POST /files failed");
        return c.json(
          { error: err instanceof Error ? err.message : "Unknown error" },
          500
        );
      }
    }

    // ── Multipart (general agent) mode: GOVERNED path ──────────────────────
    // Store the blob → documents row + immutable v1 version (NO entity), then
    // mint the `file` entity through the GOVERNED `entities.create` procedure so
    // this write passes the SAME permission membrane as every other create:
    // auto-applied when `entity.create ∈ DEFAULT_AUTO_APPROVE` (the common
    // `synap upload` case, so the file still lands immediately), or returned as a
    // `proposed` handle under a stricter workspace policy. The store→govern core
    // now lives in `createGovernedFileEntityFromBuffer` so the MCP tool can reuse
    // the SAME governed entry point without HTTP.
    try {
      const result = await createGovernedFileEntityFromBuffer({
        buffer,
        mimeType,
        filename,
        title: bodyTitle,
        userId,
        workspaceId,
        // Honest provenance: general agent upload door — attributed to the agent,
        // never falsified as human.
        agentUserId,
        scopes: c.get("scopes") as string[],
        sessionId: c.req.header("x-session-id") ?? null,
        keyType: c.get("keyType") as string | undefined,
        keyWorkspaceId: c.get("keyWorkspaceId") as string | null | undefined,
      });

      // Proposed (stricter policy): return the reviewable handle.
      if (result.status === "proposed") {
        return c.json(
          {
            documentId: result.documentId,
            proposalId: result.proposalId,
            status: "proposed" as const,
            reviewUrl: result.reviewUrl,
          },
          200
        );
      }

      // Auto-approved: same `{ fileEntityId, documentId }` shape as before.
      return c.json(
        { fileEntityId: result.fileEntityId, documentId: result.documentId },
        200
      );
    } catch (err) {
      logger.error({ err }, "POST /files failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── PATCH /entities/:entityId ───────────────────────────────────────────
  // Requires workspaceId in body for workspace-scoped update (same event chain).
  const updateEntityRoute = createRoute({
    method: "patch",
    path: "/entities/{entityId}",
    tags: ["Entities"],
    summary: "Update an entity",
    description:
      "Patch entity title / preview / metadata. Supports `Idempotency-Key`.",
    request: {
      params: z.object({ entityId: z.string() }),
      body: {
        content: {
          "application/json": { schema: UpdateEntityRequestSchema },
        },
      },
    },
    responses: {
      200: {
        description: "Updated entity",
        content: {
          "application/json": { schema: UpdateEntityResponseSchema },
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
      404: {
        description: "Entity not found",
        content: { "application/json": { schema: ErrorSchema } },
      },
      500: {
        description: "Internal error",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(updateEntityRoute, async (c): Promise<any> => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const { entityId } = c.req.valid("param");
    const body = c.req.valid("json");

    const authUserId = c.get("userId") as string | undefined;
    if (!authUserId) return c.json({ error: "Unauthenticated" }, 403);
    const isServiceKey = !!c.get("apiKeyId");
    if (!isServiceKey && body.userId && body.userId !== authUserId) {
      return c.json(
        { error: "userId does not match the authenticated session" },
        403
      );
    }
    const userId = isServiceKey ? (body.userId ?? authUserId) : authUserId;

    try {
      const target = await db.query.entities.findFirst({
        where: and(
          eq(entities.id, entityId),
          isNull(entities.deletedAt),
          or(
            and(isNull(entities.workspaceId), eq(entities.userId, userId)),
            isNotNull(entities.workspaceId)
          )
        ),
        columns: { id: true, workspaceId: true },
      });
      if (!target) return c.body(null, 404);
      if (body.workspaceId) {
        if (!(await verifyWorkspaceReadAccess(userId, body.workspaceId))) {
          return c.json({ error: "Access denied to requested workspace" }, 403);
        }
      }
      // Item 3 Part 3: confine a bound service key to its workspace — clamp the
      // resolved workspace before it flows to the caller ctx and the re-supplied
      // targetWorkspaceId input below.
      const effectiveWorkspaceId =
        getConfinedWorkspace(
          c,
          target.workspaceId ?? body.workspaceId ?? null
        ) ?? null;
      if (
        body.workspaceId &&
        target.workspaceId &&
        body.workspaceId !== target.workspaceId
      ) {
        return c.json(
          { error: "workspaceId does not match the entity's workspace" },
          400
        );
      }
      if (
        effectiveWorkspaceId &&
        !(await verifyWorkspaceReadAccess(userId, effectiveWorkspaceId))
      ) {
        return c.json({ error: "Access denied to entity's workspace" }, 403);
      }

      // body.agentUserId wins; else on the capture path (X-Capture: 1) attribute
      // the update to the seeded Capture agent so entity.update auto-approves (its
      // explicit autoApproveFor covers it); otherwise fall back to the auto-injected
      // context value so agents using their own API key get proposal attribution.
      const ctxAgentUserId = c.get("agentUserId") as string | undefined;
      const resolvedAgentUserId =
        body.agentUserId ??
        (await resolveCaptureActorUserId(c, ctxAgentUserId, {
          workspaceId: effectiveWorkspaceId,
        }));

      const actorResolution = await resolveActorId(resolvedAgentUserId, userId);
      if ("error" in actorResolution)
        return c.json({ error: actorResolution.error }, 400);
      // resolveActorId is kept for its validation side-effect above; the entity
      // is attributed via resolvedAgentUserId below, so its return is unused.
      const sessionId = body.sessionId ?? c.req.header("x-session-id") ?? null;
      const caller = await getCaller(c, {
        workspaceId: effectiveWorkspaceId,
        userId,
        sourceMessageId: body.sourceMessageId,
        sessionId,
      });
      const result = await caller.entities.updateEntity({
        entityId,
        userId,
        ...(resolvedAgentUserId ? { agentUserId: resolvedAgentUserId } : {}),
        title: body.title,
        preview: body.preview,
        metadata: body.metadata,
        ...(body.workspaceId
          ? { targetWorkspaceId: effectiveWorkspaceId ?? undefined }
          : {}),
        ...(body.deleteProperties
          ? { deleteProperties: body.deleteProperties }
          : {}),
        ...(body.reasoning ? { reasoning: body.reasoning } : {}),
      });

      // ── Impact-aware writes (SHALLOW) ─────────────────────────────────────
      // Surface the entity's immediate relation neighbours so the AI sees what
      // depends on what it just changed. Reuses the existing getConnections read
      // (no new heavy traversal). ADVISORY — never blocks the update.
      const impact = await buildUpdateImpact({
        scopes: c.get("scopes") as string[],
        userId,
        workspaceId: effectiveWorkspaceId,
        entityId,
      });

      return c.json({ ...result, ...(impact ? { impact } : {}) }, 200);
    } catch (err) {
      logger.error({ err, entityId }, "updateEntity failed");
      // Same classification as POST /entities — property-validation failures are
      // 400s the caller can fix, not 500s.
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        facetErrorStatus(err)
      );
    }
  });

  // ── DELETE /entities/:entityId ──────────────────────────────────────────
  // Closes a real gap: the hub could create (POST), read (GET) and update
  // (PATCH) entities but had no delete — an agent could write but never clean
  // up. This is a THIN transport wrapper over the canonical `entities.delete`
  // procedure, so governance (proposal-gated for agents → { status: "proposed",
  // proposalId }) and the event chain are inherited, not re-implemented.
  const deleteEntityRoute = createRoute({
    method: "delete",
    path: "/entities/{entityId}",
    tags: ["Entities"],
    summary: "Delete an entity",
    description:
      "Deletes an entity by id via the canonical entities.delete procedure. For " +
      "agent keys this is proposal-gated (returns { status: 'proposed', proposalId }); " +
      "auto-approved contexts complete inline. Acting identity is bound to the principal.",
    request: {
      params: z.object({ entityId: z.string() }),
      query: z.object({
        workspaceId: z.string().optional(),
        userId: z.string().optional(),
        reasoning: z.string().optional(),
        agentUserId: z.string().optional(),
      }),
    },
    responses: {
      200: {
        description: "Deletion result (completed or proposed)",
        content: { "application/json": { schema: z.object({}).passthrough() } },
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

  app.openapi(deleteEntityRoute, async (c): Promise<any> => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const { entityId } = c.req.valid("param");
    const q = c.req.valid("query");

    const authUserId = c.get("userId") as string | undefined;
    if (!authUserId) return c.json({ error: "Unauthenticated" }, 403);
    const isServiceKey = !!c.get("apiKeyId");
    if (!isServiceKey && q.userId && q.userId !== authUserId) {
      return c.json(
        { error: "userId does not match the authenticated session" },
        403
      );
    }
    const userId = isServiceKey ? (q.userId ?? authUserId) : authUserId;

    try {
      const target = await db.query.entities.findFirst({
        where: and(
          eq(entities.id, entityId),
          isNull(entities.deletedAt),
          or(
            and(isNull(entities.workspaceId), eq(entities.userId, userId)),
            isNotNull(entities.workspaceId)
          )
        ),
        columns: { id: true, workspaceId: true },
      });
      if (!target) return c.body(null, 404);
      const effectiveWorkspaceId = target.workspaceId ?? null;
      if (q.workspaceId && q.workspaceId !== effectiveWorkspaceId) {
        return c.json(
          { error: "workspaceId does not match the entity's workspace" },
          400
        );
      }
      if (
        effectiveWorkspaceId &&
        !(await verifyWorkspaceReadAccess(userId, effectiveWorkspaceId))
      ) {
        return c.json({ error: "Access denied to entity's workspace" }, 403);
      }

      // agentUserId drives proposal attribution; fall back to the auto-injected
      // context value so agents using their own API key get attribution for free.
      const ctxAgentUserId = c.get("agentUserId") as string | undefined;
      const resolvedAgentUserId = q.agentUserId ?? ctxAgentUserId;
      const actorResolution = await resolveActorId(resolvedAgentUserId, userId);
      if ("error" in actorResolution)
        return c.json({ error: actorResolution.error }, 400);

      const caller = await getCaller(c, {
        workspaceId: effectiveWorkspaceId,
        userId,
      });
      const result = await caller.entities.deleteEntity({
        entityId,
        userId,
        ...(resolvedAgentUserId ? { agentUserId: resolvedAgentUserId } : {}),
        ...(q.reasoning ? { reasoning: q.reasoning } : {}),
      });
      return c.json(result, 200);
    } catch (err) {
      logger.error({ err, entityId }, "deleteEntity failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Kind + Facets (Wave 1C) — role-profiles attached to an entity.
  // 3-segment (`/entities/{entityId}/facets`) and top-level (`/facets/{facetId}`)
  // paths — distinct from the 2-segment `/entities/{id}` routes, so no first-match
  // collision (mirrors the existing `/entities/{id}/connections` sub-route).
  // ══════════════════════════════════════════════════════════════════════════

  // Map tRPC door errors to real HTTP statuses instead of a blanket 500 —
  // an invalid attach (kind-as-facet, wrong applicable kind) is a client
  // mistake (400), a missing facet/entity is a 404.
  // Duck-typed on `.code` rather than `instanceof TRPCError`: the bundled
  // build carries its own TRPCError class identity, so instanceof fails
  // across the boundary (verified live — 9fb3e7d4 shipped and still 500'd).
  const facetErrorStatus = (err: unknown): 400 | 403 | 404 | 500 => {
    // Walk the cause chain: createCaller wraps a thrown domain error in
    // TRPCError{code:'INTERNAL_SERVER_ERROR', cause: <domain error>}, so the
    // meaningful `.code`/`.name` may sit one or two levels down (verified
    // live: kind-as-facet attach still 500'd with only a top-level check).
    let cursor: unknown = err;
    for (
      let depth = 0;
      cursor && typeof cursor === "object" && depth < 4;
      depth++
    ) {
      const code = (cursor as { code?: unknown }).code;
      if (code === "BAD_REQUEST") return 400;
      if (code === "FORBIDDEN" || code === "UNAUTHORIZED") return 403;
      if (code === "NOT_FOUND") return 404;
      // Raw @synap/database domain errors carry no `.code` — duck-type on
      // `.name` (bundle-safe, same rationale as `.code`; mirrors mapDbError).
      const name = (cursor as { name?: unknown }).name;
      if (
        name === "FacetProfileKindError" ||
        name === "FacetKindMismatchError" ||
        name === "PropertyValidationError"
      )
        return 400;
      if (name === "ProfileNotFoundError") return 404;
      cursor = (cursor as { cause?: unknown }).cause;
    }
    return 500;
  };

  // ── GET /entities/:entityId/facets ──────────────────────────────────────
  // Read the entity's live facets through its own workspace lens. The REST
  // parity of the tRPC `entities.get` `facets` envelope — kept as a dedicated
  // sub-route rather than bloating the strict raw-entity GET schema.
  const listFacetsRoute = createRoute({
    method: "get",
    path: "/entities/{entityId}/facets",
    tags: ["Entities"],
    summary: "List an entity's facets (role-profiles)",
    description:
      "Returns the entity's live facets joined with their role-profile + that " +
      "profile's effective properties (workspace-lensed). Requires hub-protocol.read.",
    request: {
      params: z.object({ entityId: z.string() }),
    },
    responses: {
      200: {
        description: "Effective facets",
        content: {
          "application/json": {
            schema: z.object({
              facets: z.array(z.record(z.string(), z.unknown())),
            }),
          },
        },
      },
      403: {
        description: "Forbidden",
        content: { "application/json": { schema: ErrorSchema } },
      },
      404: { description: "Not found" },
      500: {
        description: "Internal error",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(listFacetsRoute, async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const { entityId } = c.req.valid("param");
    const authUserId = c.get("userId") as string | undefined;
    if (!authUserId) return c.json({ error: "Unauthenticated" }, 403);
    try {
      const entity = await db.query.entities.findFirst({
        where: and(
          eq(entities.id, entityId),
          isNull(entities.deletedAt),
          or(
            and(isNull(entities.workspaceId), eq(entities.userId, authUserId)),
            isNotNull(entities.workspaceId)
          )
        ),
        columns: { id: true, workspaceId: true },
      });
      if (!entity) return c.body(null, 404);
      if (
        entity.workspaceId &&
        !(await verifyWorkspaceReadAccess(authUserId, entity.workspaceId))
      ) {
        return c.json({ error: "Access denied to entity's workspace" }, 403);
      }
      const facets = await getEffectiveFacets(
        db,
        entityId,
        await resolveFacetVisibilityScope(authUserId)
      );
      return c.json(
        { facets: facets as unknown as Array<Record<string, unknown>> },
        200
      );
    } catch (err) {
      logger.error({ err, entityId }, "listFacets failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Internal error" },
        facetErrorStatus(err)
      );
    }
  });

  // ── POST /entities/:entityId/facets ─────────────────────────────────────
  const attachFacetRoute = createRoute({
    method: "post",
    path: "/entities/{entityId}/facets",
    tags: ["Entities"],
    summary: "Attach a facet (role-profile) to an entity",
    description:
      "Attach a role-profile as an additive facet. Thin wrapper over the " +
      "governed entities.attachFacet door (proposal-gated for agents). " +
      "Requires hub-protocol.write.",
    request: {
      params: z.object({ entityId: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              userId: z.string().optional(),
              profileSlug: z.string().optional(),
              profileId: z.string().uuid().optional(),
              workspaceId: z.string().uuid().nullable().optional(),
              contextEntityId: z.string().uuid().nullable().optional(),
              status: z.string().optional(),
              properties: z.record(z.string(), z.unknown()).optional(),
              agentUserId: z.string().uuid().optional(),
              reasoning: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Attach result (or proposal envelope)",
        content: { "application/json": { schema: z.object({}).passthrough() } },
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

  app.openapi(attachFacetRoute, async (c): Promise<any> => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const { entityId } = c.req.valid("param");
    const body = c.req.valid("json");
    const authUserId = c.get("userId") as string | undefined;
    if (!authUserId) return c.json({ error: "Unauthenticated" }, 403);
    const isServiceKey = !!c.get("apiKeyId");
    if (!isServiceKey && body.userId && body.userId !== authUserId) {
      return c.json(
        { error: "userId does not match the authenticated session" },
        403
      );
    }
    const userId = isServiceKey ? (body.userId ?? authUserId) : authUserId;
    try {
      const ctxAgentUserId = c.get("agentUserId") as string | undefined;
      const resolvedAgentUserId = body.agentUserId ?? ctxAgentUserId;
      // Item 3 Part 3: attachFacet reads its workspace entirely from input, so
      // clamp body.workspaceId for a bound service key before it flows in.
      const confinedWorkspaceId = getConfinedWorkspace(c, body.workspaceId);
      const caller = await getCaller(c, { userId });
      const result = await caller.entities.attachFacet({
        userId,
        entityId,
        profileSlug: body.profileSlug,
        profileId: body.profileId,
        ...(confinedWorkspaceId !== undefined
          ? { workspaceId: confinedWorkspaceId }
          : {}),
        ...(body.contextEntityId !== undefined
          ? { contextEntityId: body.contextEntityId }
          : {}),
        status: body.status,
        properties: body.properties,
        ...(resolvedAgentUserId ? { agentUserId: resolvedAgentUserId } : {}),
        ...(body.reasoning ? { reasoning: body.reasoning } : {}),
      });
      return c.json(result, 200);
    } catch (err) {
      logger.error({ err, entityId }, "attachFacet failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        facetErrorStatus(err)
      );
    }
  });

  // ── PATCH /facets/:facetId ──────────────────────────────────────────────
  const updateFacetRoute = createRoute({
    method: "patch",
    path: "/facets/{facetId}",
    tags: ["Entities"],
    summary: "Update a facet's status / properties",
    description:
      "Thin wrapper over the governed entities.updateFacet door. Requires " +
      "hub-protocol.write.",
    request: {
      params: z.object({ facetId: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              userId: z.string().optional(),
              status: z.string().optional(),
              properties: z.record(z.string(), z.unknown()).optional(),
              workspaceId: z.string().uuid().nullable().optional(),
              agentUserId: z.string().uuid().optional(),
              reasoning: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Update result (or proposal envelope)",
        content: { "application/json": { schema: z.object({}).passthrough() } },
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

  app.openapi(updateFacetRoute, async (c): Promise<any> => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const { facetId } = c.req.valid("param");
    const body = c.req.valid("json");
    const authUserId = c.get("userId") as string | undefined;
    if (!authUserId) return c.json({ error: "Unauthenticated" }, 403);
    const isServiceKey = !!c.get("apiKeyId");
    if (!isServiceKey && body.userId && body.userId !== authUserId) {
      return c.json(
        { error: "userId does not match the authenticated session" },
        403
      );
    }
    const userId = isServiceKey ? (body.userId ?? authUserId) : authUserId;
    try {
      const ctxAgentUserId = c.get("agentUserId") as string | undefined;
      const resolvedAgentUserId = body.agentUserId ?? ctxAgentUserId;
      // Item 3 Part 3: updateFacet reads its workspace entirely from input, so
      // clamp body.workspaceId for a bound service key before it flows in.
      const confinedWorkspaceId = getConfinedWorkspace(c, body.workspaceId);
      const caller = await getCaller(c, { userId });
      const result = await caller.entities.updateFacet({
        userId,
        facetId,
        status: body.status,
        properties: body.properties,
        ...(confinedWorkspaceId !== undefined
          ? { workspaceId: confinedWorkspaceId }
          : {}),
        ...(resolvedAgentUserId ? { agentUserId: resolvedAgentUserId } : {}),
        ...(body.reasoning ? { reasoning: body.reasoning } : {}),
      });
      return c.json(result, 200);
    } catch (err) {
      logger.error({ err, facetId }, "updateFacet failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        facetErrorStatus(err)
      );
    }
  });

  // ── DELETE /facets/:facetId ─────────────────────────────────────────────
  const detachFacetRoute = createRoute({
    method: "delete",
    path: "/facets/{facetId}",
    tags: ["Entities"],
    summary: "Detach a facet (soft-delete)",
    description:
      "Thin wrapper over the governed entities.detachFacet door. Requires " +
      "hub-protocol.write.",
    request: {
      params: z.object({ facetId: z.string() }),
      query: z.object({
        userId: z.string().optional(),
        agentUserId: z.string().optional(),
        reasoning: z.string().optional(),
      }),
    },
    responses: {
      200: {
        description: "Detach result (or proposal envelope)",
        content: { "application/json": { schema: z.object({}).passthrough() } },
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

  app.openapi(detachFacetRoute, async (c): Promise<any> => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const { facetId } = c.req.valid("param");
    const q = c.req.valid("query");
    const authUserId = c.get("userId") as string | undefined;
    if (!authUserId) return c.json({ error: "Unauthenticated" }, 403);
    const isServiceKey = !!c.get("apiKeyId");
    if (!isServiceKey && q.userId && q.userId !== authUserId) {
      return c.json(
        { error: "userId does not match the authenticated session" },
        403
      );
    }
    const userId = isServiceKey ? (q.userId ?? authUserId) : authUserId;
    try {
      const ctxAgentUserId = c.get("agentUserId") as string | undefined;
      const resolvedAgentUserId = q.agentUserId ?? ctxAgentUserId;
      const caller = await getCaller(c, { userId });
      const result = await caller.entities.detachFacet({
        userId,
        facetId,
        ...(resolvedAgentUserId ? { agentUserId: resolvedAgentUserId } : {}),
        ...(q.reasoning ? { reasoning: q.reasoning } : {}),
      });
      return c.json(result, 200);
    } catch (err) {
      logger.error({ err, facetId }, "detachFacet failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        facetErrorStatus(err)
      );
    }
  });
}
