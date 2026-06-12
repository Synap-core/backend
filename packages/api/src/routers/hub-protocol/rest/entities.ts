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
import { db, entities, profiles, eq, and, isNull } from "@synap/database";
import { entityVectors } from "@synap/database/schema";
import { sql as drizzleSql, inArray } from "drizzle-orm";
import { searchService } from "@synap/search";
import { getDefaultActiveService } from "../../../utils/intelligence-routing.js";

import { relationsRouter } from "../../relations.js";
import { createHubProtocolCallerContext } from "../utils.js";
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
            "Scoped-by-default: with a workspaceId, only that workspace's " +
              "entities are returned. Set `true` to also include pod-wide " +
              "(null workspaceId) globals — the legacy behavior."
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
    const limitRaw = query.limit;
    const limit = Math.min(
      Math.max(parseInt(limitRaw ?? "20", 10) || 20, 1),
      100
    );
    const sortParam = (query.sort ?? "").trim();
    const scope = query.scope;
    const includePodWide = query.includePodWide === "true";

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
        where: and(eq(entities.id, entityId), isNull(entities.deletedAt)),
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

    // ── Step 1: attempt vector search via IS embedding endpoint ────────────
    let vectorEntityIds: string[] = [];
    let usedVector = false;

    try {
      const { endpoint, apiKey } = await getDefaultActiveService();
      const embRes = await fetch(`${endpoint}/api/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey,
        },
        body: JSON.stringify({ text: query }),
        signal: AbortSignal.timeout(5_000),
      });

      if (embRes.ok) {
        const { embedding } = (await embRes.json()) as {
          embedding?: number[];
        };

        if (Array.isArray(embedding) && embedding.length > 0) {
          const vecLiteral = `[${embedding.join(",")}]`;
          const vectorWhere = profileSlug
            ? and(
                drizzleSql`${entityVectors.userId} = ${userId}`,
                eq(entityVectors.entityType, profileSlug)
              )
            : drizzleSql`${entityVectors.userId} = ${userId}`;
          const rows = await db
            .select({ entityId: entityVectors.entityId })
            .from(entityVectors)
            .where(vectorWhere)
            .orderBy(
              drizzleSql`${entityVectors.embedding} <=> ${vecLiteral}::vector`
            )
            .limit(limit * 2);

          vectorEntityIds = rows.map((r) => r.entityId);
          usedVector = true;
        }
      }
    } catch {
      // Non-fatal — fall through to Typesense-only
    }

    // ── Step 2: Typesense keyword search ───────────────────────────────────
    let typesenseEntityIds: string[] = [];

    try {
      const searchResp = await searchService.search({
        query,
        userId,
        workspaceId: workspaceId || undefined,
        collections: ["entities"],
        limit: limit * 2,
        page: 1,
      });

      let hits = searchResp.results.filter((r) => r.collection === "entities");

      if (profileSlug) {
        hits = hits.filter(
          (r) =>
            (r.document as Record<string, unknown>).entityType ===
              profileSlug ||
            (r.document as Record<string, unknown>).type === profileSlug
        );
      }

      typesenseEntityIds = hits
        .map((r) => (r.document as Record<string, unknown>).id as string)
        .filter(Boolean);
    } catch {
      // Non-fatal
    }

    // ── Step 3: RRF merge (k=60) ───────────────────────────────────────────
    const scores = new Map<string, number>();

    vectorEntityIds.forEach((entityId, rank) => {
      scores.set(entityId, (scores.get(entityId) ?? 0) + 1 / (60 + rank + 1));
    });
    typesenseEntityIds.forEach((entityId, rank) => {
      scores.set(entityId, (scores.get(entityId) ?? 0) + 1 / (60 + rank + 1));
    });

    const rankedIds = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id]) => id);

    const source = (usedVector ? "hybrid" : "typesense") as
      | "hybrid"
      | "typesense";

    if (rankedIds.length === 0) {
      return c.json({ entities: [] as Record<string, unknown>[], source }, 200);
    }

    // ── Step 4: fetch full entity rows for top ids ─────────────────────────
    try {
      const rows = await db
        .select()
        .from(entities)
        .where(
          and(inArray(entities.id, rankedIds), isNull(entities.deletedAt))
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
        // Long-form body → linked document (versioned). Must be forwarded here
        // or it's silently dropped before the entity-create document flow.
        ...(body.content ? { content: body.content } : {}),
        ...(body.reasoning ? { reasoning: body.reasoning } : {}),
        ...(body.source ? { source: body.source } : {}),
      });
      // Echo back the resolved workspace context so external callers can
      // confirm where the entity landed (especially useful when the body
      // omitted workspaceId and we resolved it from the profile's entityScope).
      return c.json({ ...result, effectiveWorkspaceId }, 200);
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

  app.openapi(updateEntityRoute, async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const { entityId } = c.req.valid("param");
    const body = c.req.valid("json");

    // Bind the acting identity to the authenticated principal (closes the IDOR).
    // When body.workspaceId is given, resolveActingContext also membership-checks
    // it for the resolved user; when omitted, the update targets a pod-wide
    // entity (workspace = null) — keep that behavior without forcing resolution.
    let userId: string;
    let effectiveWorkspaceId: string | null;
    if (!body.workspaceId) {
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
      const acting = await resolveActingContext(c, {
        userId: body.userId,
        workspaceId: body.workspaceId ?? undefined,
      });
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);
      userId = acting.userId;
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
      const result = await caller.entities.updateEntity({
        entityId,
        userId,
        ...(resolvedAgentUserId ? { agentUserId: resolvedAgentUserId } : {}),
        title: body.title,
        preview: body.preview,
        metadata: body.metadata,
        ...(body.deleteProperties
          ? { deleteProperties: body.deleteProperties }
          : {}),
        ...(body.reasoning ? { reasoning: body.reasoning } : {}),
      });
      return c.json(result, 200);
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

  app.openapi(deleteEntityRoute, async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const { entityId } = c.req.valid("param");
    const q = c.req.valid("query");

    // Bind acting identity to the principal (closes the IDOR), mirroring PATCH:
    // a missing workspace targets a pod-wide entity (workspace = null).
    let userId: string;
    let effectiveWorkspaceId: string | null;
    if (!q.workspaceId) {
      const authUserId = c.get("userId") as string | undefined;
      if (!authUserId) return c.json({ error: "Unauthenticated" }, 403);
      const isServiceKey = !!c.get("apiKeyId");
      if (!isServiceKey && q.userId && q.userId !== authUserId) {
        return c.json(
          { error: "userId does not match the authenticated session" },
          403
        );
      }
      userId = isServiceKey ? (q.userId ?? authUserId) : authUserId;
      effectiveWorkspaceId = null;
    } else {
      const acting = await resolveActingContext(c, {
        userId: q.userId,
        workspaceId: q.workspaceId,
      });
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);
      userId = acting.userId;
      effectiveWorkspaceId = acting.workspaceId;
    }

    try {
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
