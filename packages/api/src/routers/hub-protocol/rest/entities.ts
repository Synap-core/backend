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
} from "@synap/database";
import { inArray } from "drizzle-orm";
import { userVisibleWhere } from "../../../utils/user-visible-where.js";

import { relationsRouter } from "../../relations.js";
import { resolveEntityByName } from "../../../services/entity-resolution.js";
import { createHubProtocolCallerContext } from "../utils.js";
import {
  retrieve,
  hybridRecall,
  type ProfileCatalogEntry,
} from "../../../services/retrieval/index.js";
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
  type HubHono,
} from "./_shared.js";

/** A single resolution suggestion / auto-connected facet (ids + names). */
interface ResolutionSuggestion {
  id: string;
  name: string;
  profileSlug: string;
}

/** The `resolution` block attached to a create response (additive). */
interface CreateResolutionBlock {
  /** SAME profile + SAME name → the agent should consider updating this instead. */
  existingSameProfile?: ResolutionSuggestion;
  /** DIFFERENT-profile facets we auto-connected the new entity to. */
  autoConnected: Array<ResolutionSuggestion & { relation: string }>;
  /** Everything worth a second look: the auto-connected facets (shallow). */
  suggestions: ResolutionSuggestion[];
}

/**
 * Run exact-name resolution around a just-created entity and (a) auto-connect
 * cross-profile facets via a `same_subject` relation (governed by the SAME
 * proposal/auto path as any relation write) and (b) return an advisory block.
 *
 * ADVISORY ONLY — every failure path returns `undefined`, never throws, so the
 * underlying entity write is never blocked by resolution.
 */
async function buildCreateResolution(params: {
  scopes: string[];
  title: string;
  profileSlug: string;
  userId: string;
  createdId?: string;
  effectiveWorkspaceId: string | null;
  resolvedAgentUserId?: string;
  reasoning?: string;
}): Promise<CreateResolutionBlock | undefined> {
  try {
    const { sameProfile, otherProfiles } = await resolveEntityByName({
      name: params.title,
      targetProfileSlug: params.profileSlug,
      userId: params.userId,
      excludeId: params.createdId,
    });

    if (!sameProfile && otherProfiles.length === 0) return undefined;

    const autoConnected: CreateResolutionBlock["autoConnected"] = [];

    // Auto-connect ONLY same-name + different-profile facets, and only when we
    // have a concrete created entity id to connect FROM (proposed entities have
    // no id yet — skip; the suggestion is still surfaced so the agent sees it).
    if (params.createdId && otherProfiles.length > 0) {
      const relCtx = await createHubProtocolCallerContext(
        params.userId,
        params.scopes,
        params.effectiveWorkspaceId ?? undefined
      );
      const relCaller = relationsRouter.createCaller(
        relCtx as Parameters<typeof relationsRouter.createCaller>[0]
      );
      for (const facet of otherProfiles) {
        try {
          await relCaller.create({
            sourceEntityId: params.createdId,
            targetEntityId: facet.id,
            type: "same_subject",
            ...(params.effectiveWorkspaceId
              ? { workspaceId: params.effectiveWorkspaceId }
              : {}),
          });
          autoConnected.push({
            id: facet.id,
            name: facet.name,
            profileSlug: facet.profileSlug,
            relation: "same_subject",
          });
        } catch (relErr) {
          // A single auto-connect failure (e.g. cross-workspace facet, missing
          // workspace) must not sink the whole resolution block.
          logger.warn(
            { relErr, facetId: facet.id, createdId: params.createdId },
            "auto-connect same_subject failed"
          );
        }
      }
    }

    // suggestions = the cross-profile facets worth a second look (shallow: the
    // same set we auto-connected, surfaced explicitly for the agent).
    const suggestions: ResolutionSuggestion[] = otherProfiles.map((e) => ({
      id: e.id,
      name: e.name,
      profileSlug: e.profileSlug,
    }));

    return {
      ...(sameProfile
        ? {
            existingSameProfile: {
              id: sameProfile.id,
              name: sameProfile.name,
              profileSlug: sameProfile.profileSlug,
            },
          }
        : {}),
      autoConnected,
      suggestions,
    };
  } catch (err) {
    logger.warn({ err }, "buildCreateResolution failed (resolution omitted)");
    return undefined;
  }
}

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
      100
    );
    const sortParam = (query.sort ?? "").trim();
    const scope = query.scope;
    // Default TRUE: a workspace lens should include pod-wide globals (the caller's
    // own pod-personal entities with workspaceId IS NULL) so a CRM or agent view
    // sees pod-wide profiles (person, company…) alongside workspace-specific data.
    // Callers that want ONLY the exact workspace's rows must explicitly pass "false".
    const includePodWide = query.includePodWide !== "false";

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

      const callerWorkspaceId = workspaceIdParam ?? effectiveWsIds[0];

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
        includePodWide,
        ...(projectIdParam ? { projectId: projectIdParam } : {}),
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
    const { userId, workspaceId } = acting;

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
      const result = await caller.getConnections({ entityId, limit });
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
      query: z.object({
        workspaceId: z.string().optional(),
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
          and(inArray(entities.id, rankedIds), isNull(entities.deletedAt), floor)
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
    const workspaceId = body.workspaceId ?? null;

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
        catalog = profileRows.flatMap((p) =>
          p.slug ? [{ slug: p.slug, displayName: p.displayName ?? p.slug }] : []
        );
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

    const profile = await db.query.profiles.findFirst({
      where: eq(profiles.slug, profileSlug),
      columns: { entityScope: true },
    });
    const isPodWide = !profile || profile.entityScope === "pod";

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
        ...(effectiveWorkspaceId
          ? { targetWorkspaceId: effectiveWorkspaceId }
          : {}),
        // Long-form body → linked document (versioned). Must be forwarded here
        // or it's silently dropped before the entity-create document flow.
        ...(body.content ? { content: body.content } : {}),
        ...(body.reasoning ? { reasoning: body.reasoning } : {}),
        ...(body.source ? { source: body.source } : {}),
      });

      // ── Impact-aware writes (SHALLOW, exact-name) ─────────────────────────
      // Turn the agent from a blind writer into a gardener: tell it what already
      // exists under the same name, and auto-connect cross-profile facets.
      // ADVISORY — any failure here must NOT break the write (the entity is
      // already created above). The `resolution` block is purely additive.
      const resolution = await buildCreateResolution({
        scopes: c.get("scopes") as string[],
        title: body.title,
        profileSlug,
        userId,
        createdId: result.id,
        effectiveWorkspaceId,
        resolvedAgentUserId,
        reasoning: body.reasoning,
      });

      // Echo back the resolved workspace context so external callers can
      // confirm where the entity landed (especially useful when the body
      // omitted workspaceId and we resolved it from the profile's entityScope).
      return c.json(
        {
          ...result,
          effectiveWorkspaceId,
          ...(resolution ? { resolution } : {}),
        },
        200
      );
    } catch (err) {
      logger.error({ err }, "createEntity failed");
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
      500: {
        description: "Internal error",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      const effectiveWorkspaceId =
        target.workspaceId ?? body.workspaceId ?? null;
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
      const result = await caller.entities.updateEntity({
        entityId,
        userId,
        ...(resolvedAgentUserId ? { agentUserId: resolvedAgentUserId } : {}),
        title: body.title,
        preview: body.preview,
        metadata: body.metadata,
        ...(body.workspaceId ? { targetWorkspaceId: body.workspaceId } : {}),
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
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
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
}
