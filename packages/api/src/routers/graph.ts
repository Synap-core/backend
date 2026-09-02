/**
 * Graph Router - Optimized Graph Queries
 *
 * Provides bulk endpoints for efficient graph rendering:
 * - getNode: Entity + all relations + related entity previews
 * - getSubgraph: Multiple entities with their relationships
 * - getPath: Shortest path between two entities
 *
 * These endpoints reduce N+1 queries and improve graph view performance.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, podProcedure } from "../trpc.js";
import {
  db,
  eq,
  and,
  or,
  inArray,
  isNull,
  isNotNull,
  desc,
  drizzleSql,
  exists,
  facetRoleExists,
  facetVisibilityConditions,
  not,
  profileSlugScopeConditionFromRows,
  loadFacetSlugsBatch,
} from "@synap/database";
import {
  entities,
  entityFacets,
  entityPropertyIndex,
  propertyDefs,
  relations,
} from "@synap/database/schema";
import { accessScopeWhere, projectLensWhere } from "../utils/project-scope.js";
import { workspaceLensWhere } from "../utils/user-visible-where.js";
import { AccessContext, scopedDb } from "../access/index.js";
import {
  getObjectGraph,
  connectionsToNeighbors,
  GRAPH_KINDS,
  ENTITY_BACKED,
  type GraphNeighbor,
  type GraphEnvelope,
} from "../services/object-graph/graph-service.js";
import {
  buildSystemMapEntityGraph,
  buildSystemMapOverview,
  type SystemMapEntityGraph,
  type SystemMapSemanticRelation,
  type SystemMapStructuralLink,
  type SystemMapOverview,
} from "../services/object-graph/system-map.js";
import { relationsRouter } from "./relations.js";
import type { LinkEndpointType } from "@synap/playbooks";
import { resolveFacetVisibilityScope } from "../utils/workspace-membership.js";
import { assertKnownProfileSlug } from "../utils/assert-known-profile-slug.js";

// Entity read floor for the graph's legacy bulk fetches (getNode/getSubgraph) —
// the ONE door with role-as-lens (facetLens), so they agree with getFull and
// entities.list. A bare `eq(entities.userId)` here was owner-only and hid
// role-shared entities from co-members (NOT_FOUND on getNode, absent in getSubgraph).
function graphEntityFloor(userId: string) {
  return accessScopeWhere({
    workspaceIdColumn: entities.workspaceId,
    entityIdColumn: entities.id,
    ownerColumn: entities.userId,
    userId,
    facetLens: true,
  });
}

// Relations floor mirroring the `relations` VisibilityRule (access/registry.ts):
// workspace rows follow membership, NULL-workspace rows stay owner-floored — so a
// role-shared entity's edges aren't dropped when authored by a teammate.
function graphRelationsFloor(userId: string) {
  return or(
    and(
      isNotNull(relations.workspaceId),
      workspaceLensWhere(relations.workspaceId, userId)
    ),
    and(isNull(relations.workspaceId), eq(relations.userId, userId))
  )!;
}

/**
 * The System Map follows Library's active-lens policy: a specific workspace
 * shows its rows only unless the caller explicitly asks to include pod-wide
 * entities. This is the same data-table resolver used by entity lists, with
 * the role-as-lens branch needed for Kind + Facets clusters.
 */
function systemMapEntityScope(
  userId: string,
  workspaceLens: string | null | undefined,
  includePodWide: boolean
) {
  return accessScopeWhere({
    workspaceIdColumn: entities.workspaceId,
    entityIdColumn: entities.id,
    ownerColumn: entities.userId,
    userId,
    workspaceLens,
    facetLens: true,
    includeGlobalsInLens: includePodWide,
  });
}

function systemMapWorkspaceLens(
  inputWorkspaceId: string | null | undefined,
  contextWorkspaceId: string | null | undefined,
  allData: boolean
) {
  // `null` is a deliberate globals-only lens in Synap. Library's All data
  // mode therefore needs an explicit user-wide request, not a null lens.
  if (allData) return undefined;
  return inputWorkspaceId !== undefined
    ? inputWorkspaceId
    : (contextWorkspaceId ?? undefined);
}

/**
 * Structural links are meaningful only through the active effective-property
 * lens. In All data there is no single workspace overlay, so only base defs
 * participate; a focused workspace can add only its own overlay defs.
 */
function systemMapPropertyDefScope(workspaceLens: string | null | undefined) {
  return workspaceLens
    ? or(
        isNull(propertyDefs.workspaceId),
        eq(propertyDefs.workspaceId, workspaceLens)
      )
    : isNull(propertyDefs.workspaceId);
}

/**
 * PROJECT rung of the System Map lens. Projects are a cross-cutting DATA scope
 * (instances), not a lens-config axis: membership rides the `belongs_to_project`
 * relation over `entities`, so the narrow is the existing `projectLensWhere`
 * preset — never a new predicate. PURE narrow, ANDed with the workspace/pod
 * floor `systemMapEntityScope` already imposes; it can only remove rows.
 * `undefined` = no narrow, so an absent `projectId` is byte-for-byte today's
 * behaviour.
 */
function systemMapProjectScope(projectId: string | undefined) {
  return projectId ? projectLensWhere(entities.id, projectId) : undefined;
}

/**
 * `resolveFacetVisibilityScope` confirms an explicit workspace lens by
 * returning it as `workspaceId`; `allowedWorkspaceIds` is reserved for
 * identity-wide (no-lens) reads. Keep this assertion at the System Map door
 * so an arbitrary input workspace can never select another workspace's rows
 * or property-definition overlays.
 */
function assertSystemMapWorkspaceLensAccess(
  workspaceLens: string | null | undefined,
  facetVisibilityScope: Awaited<ReturnType<typeof resolveFacetVisibilityScope>>
) {
  if (
    typeof workspaceLens === "string" &&
    facetVisibilityScope.workspaceId !== workspaceLens
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Workspace is not available in this map lens",
    });
  }
}

/**
 * System Map kinds are primary-kind cluster ids emitted by the overview, not
 * polymorphic profile-slug filters. Roles are deliberately a separate facet
 * predicate (`systemMapRoleScope`) so a role never masquerades as a kind.
 */
function systemMapKindScope(kind: string) {
  return drizzleSql`${entities.type} = ${kind}`;
}

/**
 * Role filtering uses the same facet read door as role annotation. `null` is
 * intentionally "no visible roles", not "no facet rows at all": an invisible
 * role is not evidence for filtering an entity out of the caller's map.
 */
async function systemMapRoleScope(
  role: string | null | undefined,
  facetVisibilityScope: Awaited<ReturnType<typeof resolveFacetVisibilityScope>>
) {
  if (role === undefined) return undefined;

  if (role !== null) {
    const roleProfiles = await assertKnownProfileSlug(db, role);
    const roleProfileIds = roleProfiles
      .filter((profile) => profile.profileKind === "role")
      .map((profile) => profile.id);
    if (roleProfileIds.length === 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Profile "${role}" is a kind, not an attachable role`,
      });
    }
    return facetRoleExists(db, roleProfileIds, facetVisibilityScope);
  }

  return not(
    exists(
      db
        .select({ one: drizzleSql`1` })
        .from(entityFacets)
        .where(
          and(
            eq(entityFacets.entityId, entities.id),
            isNull(entityFacets.deletedAt),
            ...facetVisibilityConditions(facetVisibilityScope)
          )
        )
    )
  );
}

/**
 * Get a single node with full graph context
 *
 * Returns entity + all relations + related entity previews in one call.
 * Essential for graph view performance.
 */
export const graphRouter = router({
  /**
   * A compact, truthful overview of the visible entity graph for Library's
   * System Map. This reads and aggregates the complete server-side lens — it
   * never derives counts or bundles from a paginated entities.list response.
   *
   * Semantic relations come from `relations`; structural links come from the
   * indexed entity_id-property projection. The two sources remain distinct so
   * clients never mistake schema wiring for an emergent graph relationship.
   */
  getSystemMapOverview: podProcedure
    .input(
      z.object({
        /** Explicit lens; omitted uses the caller's active workspace. */
        workspaceId: z.string().uuid().nullable().optional(),
        /** Deliberately bypass the active workspace lens for Library All data. */
        allData: z.boolean().default(false),
        /** Opt into the active workspace + pod-wide entity union. */
        includePodWide: z.boolean().default(false),
        /** Optional project narrow — the cross-cutting data lens (pure narrow). */
        projectId: z.string().uuid().optional(),
      })
    )
    .query(async ({ input, ctx }): Promise<SystemMapOverview> => {
      const workspaceLens = systemMapWorkspaceLens(
        input.workspaceId,
        ctx.workspaceId,
        input.allData
      );
      const facetVisibilityScope = await resolveFacetVisibilityScope(
        ctx.userId,
        workspaceLens
      );
      assertSystemMapWorkspaceLensAccess(workspaceLens, facetVisibilityScope);
      const entityRows = await db.query.entities.findMany({
        where: and(
          isNull(entities.deletedAt),
          systemMapEntityScope(ctx.userId, workspaceLens, input.includePodWide),
          systemMapProjectScope(input.projectId)
        ),
        columns: { id: true, type: true },
      });

      if (entityRows.length === 0) {
        return buildSystemMapOverview({
          entities: [],
          facetSlugsByEntity: new Map(),
          semanticRelations: [],
          structuralLinks: [],
        });
      }

      const entityIds = entityRows.map((entity) => entity.id);
      const [facetSlugsByEntity, semanticRelations, structuralLinks] =
        await Promise.all([
          loadFacetSlugsBatch(db, entityIds, facetVisibilityScope),
          // Reuse the relations registry's canonical visibility rule. It has
          // the important asymmetry: workspace edges follow membership, while
          // pod-wide edges remain author-private.
          scopedDb(AccessContext.from(ctx).withLens(workspaceLens)).findMany<
            typeof relations.$inferSelect
          >(relations, {
            where: and(
              inArray(relations.sourceEntityId, entityIds),
              inArray(relations.targetEntityId, entityIds)
            ),
            columns: {
              sourceEntityId: true,
              targetEntityId: true,
              type: true,
            },
          }),
          // entity_property_index is a projection of schema-defined entity_id
          // links. Both ids must already be visible nodes, matching the graph
          // relation anti-dangling rule above.
          db
            .select({
              sourceEntityId: entityPropertyIndex.entityId,
              targetEntityId: entityPropertyIndex.valueEntityId,
              propertySlug: propertyDefs.slug,
            })
            .from(entityPropertyIndex)
            .innerJoin(
              propertyDefs,
              eq(entityPropertyIndex.propertyDefId, propertyDefs.id)
            )
            .where(
              and(
                isNotNull(entityPropertyIndex.valueEntityId),
                inArray(entityPropertyIndex.entityId, entityIds),
                inArray(entityPropertyIndex.valueEntityId, entityIds),
                systemMapPropertyDefScope(workspaceLens)
              )
            ),
        ]);

      return buildSystemMapOverview({
        entities: entityRows,
        facetSlugsByEntity,
        semanticRelations,
        structuralLinks,
      });
    }),

  /**
   * Lazy, paginated detail for one System Map kind cluster. Unlike the overview
   * aggregate, this intentionally pages entity previews for an expanded cluster.
   */
  getSystemMapKindDrilldown: podProcedure
    .input(
      z.object({
        kind: z.string().min(1),
        /** undefined = every entity, string = visible role, null = no visible roles. */
        role: z.string().min(1).nullable().optional(),
        workspaceId: z.string().uuid().nullable().optional(),
        allData: z.boolean().default(false),
        includePodWide: z.boolean().default(false),
        /** Optional project narrow — the cross-cutting data lens (pure narrow). */
        projectId: z.string().uuid().optional(),
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().min(0).default(0),
      })
    )
    .query(async ({ input, ctx }) => {
      const workspaceLens = systemMapWorkspaceLens(
        input.workspaceId,
        ctx.workspaceId,
        input.allData
      );
      const facetVisibilityScope = await resolveFacetVisibilityScope(
        ctx.userId,
        workspaceLens
      );
      assertSystemMapWorkspaceLensAccess(workspaceLens, facetVisibilityScope);
      const roleScope = await systemMapRoleScope(
        input.role,
        facetVisibilityScope
      );
      const where = and(
        isNull(entities.deletedAt),
        systemMapKindScope(input.kind),
        roleScope,
        systemMapEntityScope(ctx.userId, workspaceLens, input.includePodWide),
        systemMapProjectScope(input.projectId)
      );
      const [items, totalRows] = await Promise.all([
        db.query.entities.findMany({
          where,
          columns: {
            id: true,
            type: true,
            title: true,
            preview: true,
            workspaceId: true,
          },
          orderBy: [desc(entities.updatedAt)],
          limit: input.limit,
          offset: input.offset,
        }),
        db
          .select({ count: drizzleSql<number>`count(*)::int` })
          .from(entities)
          .where(where),
      ]);
      const facetSlugsByEntity = await loadFacetSlugsBatch(
        db,
        items.map((item) => item.id),
        facetVisibilityScope
      );
      const total = totalRows[0]?.count ?? 0;
      const hasMore = input.offset + items.length < total;
      const truncationReason = hasMore
        ? "node_limit"
        : input.offset > 0
          ? "offset"
          : null;

      return {
        items: items.map((item) => ({
          ...item,
          facetSlugs: facetSlugsByEntity.get(item.id) ?? [],
        })),
        total,
        pagination: {
          limit: input.limit,
          offset: input.offset,
          hasMore,
        },
        complete: truncationReason === null,
        truncationReason,
      };
    }),

  /**
   * A bounded raw entity graph for force-directed renderers. This is separate
   * from the aggregate overview: its edges are individual rows/projection
   * links, and every endpoint is one of the returned, visibility-scoped nodes.
   */
  getSystemMapEntityGraph: podProcedure
    .input(
      z.object({
        /** Optional kind narrow; omit for the full visible System Map lens. */
        kind: z.string().min(1).optional(),
        /** undefined = every entity, string = visible role, null = no visible roles. */
        role: z.string().min(1).nullable().optional(),
        workspaceId: z.string().uuid().nullable().optional(),
        allData: z.boolean().default(false),
        includePodWide: z.boolean().default(false),
        /** Optional project narrow — the cross-cutting data lens (pure narrow). */
        projectId: z.string().uuid().optional(),
        /** Hard cap keeps force-graph payloads bounded even for large pods. */
        limit: z.number().int().min(1).max(250).default(150),
        offset: z.number().int().min(0).default(0),
        /**
         * Cap applied independently to semantic and structural edge sources so
         * neither provenance class can starve the other.
         */
        edgeLimit: z.number().int().min(1).max(2_000).default(1_000),
      })
    )
    .query(async ({ input, ctx }): Promise<SystemMapEntityGraph> => {
      const workspaceLens = systemMapWorkspaceLens(
        input.workspaceId,
        ctx.workspaceId,
        input.allData
      );
      const facetVisibilityScope = await resolveFacetVisibilityScope(
        ctx.userId,
        workspaceLens
      );
      assertSystemMapWorkspaceLensAccess(workspaceLens, facetVisibilityScope);

      const roleScope = await systemMapRoleScope(
        input.role,
        facetVisibilityScope
      );
      const where = and(
        isNull(entities.deletedAt),
        input.kind ? systemMapKindScope(input.kind) : undefined,
        roleScope,
        systemMapEntityScope(ctx.userId, workspaceLens, input.includePodWide),
        systemMapProjectScope(input.projectId)
      );
      const [entityRows, totalRows] = await Promise.all([
        db.query.entities.findMany({
          where,
          columns: {
            id: true,
            type: true,
            title: true,
            preview: true,
            workspaceId: true,
          },
          orderBy: [desc(entities.updatedAt)],
          limit: input.limit,
          offset: input.offset,
        }),
        db
          .select({ count: drizzleSql<number>`count(*)::int` })
          .from(entities)
          .where(where),
      ]);
      const entityIds = entityRows.map((entity) => entity.id);
      const relationAccess = scopedDb(
        AccessContext.from(ctx).withLens(workspaceLens)
      );
      const semanticWhere = and(
        inArray(relations.sourceEntityId, entityIds),
        inArray(relations.targetEntityId, entityIds)
      );
      const structuralWhere = and(
        isNotNull(entityPropertyIndex.valueEntityId),
        inArray(entityPropertyIndex.entityId, entityIds),
        inArray(entityPropertyIndex.valueEntityId, entityIds),
        systemMapPropertyDefScope(workspaceLens)
      );
      const [
        facetSlugsByEntity,
        semanticRelations,
        structuralLinks,
        semanticRelationTotalRows,
        structuralLinkTotalRows,
      ] = await Promise.all([
        loadFacetSlugsBatch(db, entityIds, facetVisibilityScope),
        entityIds.length === 0
          ? Promise.resolve([] as SystemMapSemanticRelation[])
          : relationAccess.findMany<typeof relations.$inferSelect>(relations, {
              where: semanticWhere,
              columns: {
                sourceEntityId: true,
                targetEntityId: true,
                type: true,
              },
              orderBy: [desc(relations.createdAt)],
              limit: input.edgeLimit,
            }),
        entityIds.length === 0
          ? Promise.resolve([] as SystemMapStructuralLink[])
          : db
              .select({
                sourceEntityId: entityPropertyIndex.entityId,
                targetEntityId: entityPropertyIndex.valueEntityId,
                propertySlug: propertyDefs.slug,
              })
              .from(entityPropertyIndex)
              .innerJoin(
                propertyDefs,
                eq(entityPropertyIndex.propertyDefId, propertyDefs.id)
              )
              .where(structuralWhere)
              .orderBy(
                entityPropertyIndex.entityId,
                entityPropertyIndex.propertyDefId
              )
              .limit(input.edgeLimit),
        entityIds.length === 0
          ? Promise.resolve([{ count: 0 }])
          : db
              .select({ count: drizzleSql<number>`count(*)::int` })
              .from(relations)
              .where(and(semanticWhere, relationAccess.predicate(relations))),
        entityIds.length === 0
          ? Promise.resolve([{ count: 0 }])
          : db
              .select({ count: drizzleSql<number>`count(*)::int` })
              .from(entityPropertyIndex)
              .innerJoin(
                propertyDefs,
                eq(entityPropertyIndex.propertyDefId, propertyDefs.id)
              )
              .where(structuralWhere),
      ]);

      return buildSystemMapEntityGraph({
        entities: entityRows,
        facetSlugsByEntity,
        semanticRelations,
        structuralLinks,
        total: totalRows[0]?.count ?? 0,
        limit: input.limit,
        offset: input.offset,
        semanticRelationsTotal: semanticRelationTotalRows[0]?.count ?? 0,
        structuralLinksTotal: structuralLinkTotalRows[0]?.count ?? 0,
      });
    }),

  /**
   * THE unified graph envelope — fetch ANY object kind + its typed neighbourhood
   * (links graph for every kind, + relations/property/channel data graph for
   * entity-backed kinds). The tRPC twin of `GET /graph/:type/:id` and the MCP
   * `synap_get_graph` tool: all three share `getObjectGraph` so the browser, the
   * agent, and external REST see the SAME graph. This is the UI's door to the
   * "graph by default" envelope (the legacy getNode/getSubgraph below stay for
   * the force-graph view's bulk fetches).
   */
  getObjectGraph: podProcedure
    .input(
      z.object({
        /** Object kind to focus on (entity, session, playbook, tool, …). */
        type: z.enum(GRAPH_KINDS).default("entity"),
        /** The object's id (uuid or kind short-id). */
        id: z.string(),
        /**
         * Rendering/property lens for the entity-data fold. Object access is by
         * id; workspaceId only narrows the relations/property/channel half.
         */
        workspaceId: z.string().uuid().nullable().optional(),
      })
    )
    .query(async ({ input, ctx }): Promise<GraphEnvelope> => {
      // Entity-data half (relations + property + channel) — only for
      // entity-backed kinds, folded via the SAME getConnections the entity
      // detail page uses. We hold the real tRPC ctx, so call the relations
      // router directly (no hub-scope translation needed).
      let extra: GraphNeighbor[] = [];
      if (ENTITY_BACKED.has(input.type)) {
        const relCaller = relationsRouter.createCaller(ctx);
        const conns = await relCaller.getConnections({
          entityId: input.id,
          limit: 100,
          workspaceId: input.workspaceId,
        });
        extra = connectionsToNeighbors(conns.connections);
      }
      const envelope = await getObjectGraph(
        ctx.userId,
        input.type as LinkEndpointType,
        input.id,
        extra,
        input.workspaceId
      );
      // A table-backed id that hydrated to nothing with no visible edges is
      // genuinely unknown / invisible — surface not-found instead of a phantom
      // node named by its own UUID.
      if (!envelope.found) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `No ${input.type} with id '${input.id}'`,
        });
      }
      return envelope;
    }),

  /**
   * Get entity with all its relationships and related entity previews
   *
   * @example
   * const node = await synap.graph.getNode.query({
   *   entityId: '123',
   *   includeRelatedPreviews: true
   * });
   */
  getNode: protectedProcedure
    .input(
      z.object({
        entityId: z.string().uuid(),
        includeRelations: z.boolean().default(true),
        includeRelatedPreviews: z.boolean().default(true),
        relationTypes: z.array(z.string()).optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      // 1. Get the entity
      const entity = await db.query.entities.findFirst({
        where: and(
          eq(entities.id, input.entityId),
          graphEntityFloor(ctx.userId)
        ),
      });

      if (!entity) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Entity not found" });
      }

      if (!input.includeRelations) {
        return { entity, relations: [], relatedEntities: [], stats: null };
      }

      // 2. Get all relations for this entity (both directions)
      const whereClause = and(
        graphRelationsFloor(ctx.userId),
        or(
          eq(relations.sourceEntityId, input.entityId),
          eq(relations.targetEntityId, input.entityId)
        ),
        input.relationTypes
          ? inArray(relations.type, input.relationTypes)
          : undefined
      );

      const allRelations = await db.query.relations.findMany({
        where: whereClause,
        orderBy: [desc(relations.createdAt)],
      });

      // 3. Get related entity IDs
      const relatedEntityIds = new Set<string>();
      allRelations.forEach((rel) => {
        // Polymorphic endpoints: a cell endpoint has a NULL entity id — skip it
        // (this graph view traverses entity↔entity edges).
        const otherId =
          rel.sourceEntityId === input.entityId
            ? rel.targetEntityId
            : rel.sourceEntityId;
        if (otherId !== null) relatedEntityIds.add(otherId);
      });

      // 4. Fetch related entity previews if requested
      let relatedEntities: any[] = [];
      if (input.includeRelatedPreviews && relatedEntityIds.size > 0) {
        relatedEntities = await db.query.entities.findMany({
          where: and(
            graphEntityFloor(ctx.userId),
            inArray(entities.id, Array.from(relatedEntityIds))
          ),
          columns: {
            id: true,
            type: true,
            title: true,
            preview: true,
            createdAt: true,
            updatedAt: true,
          },
        });
      }

      // 5. Calculate statistics
      const outgoing = allRelations.filter(
        (r) => r.sourceEntityId === input.entityId
      );
      const incoming = allRelations.filter(
        (r) => r.targetEntityId === input.entityId
      );

      const byType: Record<string, number> = {};
      allRelations.forEach((rel) => {
        byType[rel.type] = (byType[rel.type] || 0) + 1;
      });

      const stats = {
        total: allRelations.length,
        outgoing: outgoing.length,
        incoming: incoming.length,
        byType,
      };

      return {
        entity,
        relations: allRelations,
        relatedEntities,
        stats,
      };
    }),

  /**
   * Get multiple entities with their relationships
   * Useful for rendering a filtered subgraph
   *
   * @example
   * const subgraph = await synap.graph.getSubgraph.query({
   *   entityIds: ['123', '456', '789'],
   * });
   */
  getSubgraph: protectedProcedure
    .input(
      z.object({
        entityIds: z.array(z.string().uuid()).min(1).max(100),
        includeInternalRelations: z.boolean().default(true),
        includeExternalRelations: z.boolean().default(false),
      })
    )
    .query(async ({ input, ctx }) => {
      // 1. Fetch all requested entities
      const fetchedEntities = await db.query.entities.findMany({
        where: and(
          graphEntityFloor(ctx.userId),
          inArray(entities.id, input.entityIds)
        ),
      });

      if (!input.includeInternalRelations && !input.includeExternalRelations) {
        return { entities: fetchedEntities, relations: [] };
      }

      // 2. Fetch relations
      let relationWhere;

      if (input.includeInternalRelations && !input.includeExternalRelations) {
        // Only relations where BOTH entities are in the set
        relationWhere = and(
          graphRelationsFloor(ctx.userId),
          inArray(relations.sourceEntityId, input.entityIds),
          inArray(relations.targetEntityId, input.entityIds)
        );
      } else {
        // Relations where at least ONE entity is in the set
        relationWhere = and(
          graphRelationsFloor(ctx.userId),
          or(
            inArray(relations.sourceEntityId, input.entityIds),
            inArray(relations.targetEntityId, input.entityIds)
          )
        );
      }

      const fetchedRelations = await db.query.relations.findMany({
        where: relationWhere,
        orderBy: [desc(relations.createdAt)],
      });

      return {
        entities: fetchedEntities,
        relations: fetchedRelations,
      };
    }),

  /**
   * Fetch all entities + relations in one query — no ID list required.
   * Replaces the entities.list → getSubgraph two-step for full-graph views.
   */
  getFull: podProcedure
    .input(
      z.object({
        profileSlug: z.string().optional(),
        limit: z.number().int().min(1).max(2000).default(500),
      })
    )
    .query(async ({ input, ctx }) => {
      const facetVisibilityScope = await resolveFacetVisibilityScope(
        ctx.userId
      );
      // Fail closed on a slug that names no profile in this pod — otherwise the
      // predicate's row-blind kind branch yields an empty graph that looks
      // identical to a genuinely empty one (see assertKnownProfileSlug).
      const slugRows = input.profileSlug
        ? await assertKnownProfileSlug(db, input.profileSlug)
        : undefined;
      const entityRows = await db.query.entities.findMany({
        where: and(
          // The one-door floor (not bare userVisibleWhere, which admitted ANY
          // workspace_id IS NULL row regardless of owner — a cross-user leak of
          // other users' pod-wide entities). accessScopeWhere owner-gates the NULL
          // branch AND adds role-as-lens (facetLens) so a member sees pod-wide
          // entities role-attached to their workspaces.
          accessScopeWhere({
            workspaceIdColumn: entities.workspaceId,
            entityIdColumn: entities.id,
            ownerColumn: entities.userId,
            userId: ctx.userId,
            facetLens: true,
          }),
          isNull(entities.deletedAt),
          // Polymorphic (Kind + Facets): role slugs match via facet EXISTS
          // across all the user's workspaces (undefined lens + owner floor).
          // Built from the rows the assert above already resolved — one lookup.
          input.profileSlug && slugRows
            ? profileSlugScopeConditionFromRows(
                db,
                input.profileSlug,
                slugRows,
                {
                  ...facetVisibilityScope,
                }
              )
            : undefined
        ),
        columns: {
          id: true,
          type: true,
          title: true,
          preview: true,
          workspaceId: true,
        },
        limit: input.limit,
        orderBy: [desc(entities.updatedAt)],
      });

      if (entityRows.length === 0) {
        return { entities: [], relations: [] };
      }

      const ids = entityRows.map((e) => e.id);
      const relationRows = await db.query.relations.findMany({
        where: and(
          // Same floor as the `relations` VisibilityRule (access/registry.ts):
          // workspace-scoped relations follow membership (collaboration data),
          // pod-wide (NULL-workspace) relations stay owner-floored (no
          // collaborative boundary). A bare `eq(userId, ctx.userId)` here was
          // owner-only and rendered role-shared entities as DISCONNECTED nodes
          // whenever the connecting relation was authored by a teammate.
          or(
            and(
              isNotNull(relations.workspaceId),
              workspaceLensWhere(relations.workspaceId, ctx.userId)
            ),
            and(isNull(relations.workspaceId), eq(relations.userId, ctx.userId))
          ),
          // BOTH endpoints must be in the visible node set — a link is NOT a
          // permission. With `or(...)` an edge whose OTHER endpoint failed the
          // floor was still returned, leaking that hidden entity's id + the
          // relation type as a dangling edge to a node the payload never
          // includes. Harmless for a broad-floor teammate (the other end is
          // usually visible too), a real leak for an exposure-only guest.
          // `and(...)` renders only edges between two entities the viewer can
          // already see — "showcase only the entities that belong".
          and(
            inArray(relations.sourceEntityId, ids),
            inArray(relations.targetEntityId, ids)
          )
        ),
      });

      const facetSlugsByEntity = await loadFacetSlugsBatch(
        db,
        ids,
        facetVisibilityScope
      );
      return {
        entities: entityRows.map((entity) => ({
          ...entity,
          facetSlugs: facetSlugsByEntity.get(entity.id) ?? [],
        })),
        relations: relationRows,
      };
    }),

  /**
   * Get graph statistics for an entity or entire graph
   *
   * NOTE: unlike `getFull` above, the entity/relation counts here stay
   * owner-scoped (`eq(userId, ctx.userId)`) rather than membership-floored.
   * That's a deferred product decision (should workspace-shared stats count
   * teammates' rows too?), not part of the getFull disconnected-node fix —
   * left unchanged intentionally.
   */
  getStats: protectedProcedure
    .input(
      z.object({
        entityId: z.string().uuid().optional(),
        entityType: z.string().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      if (input.entityId) {
        // Stats for specific entity
        const relCount = await db
          .select()
          .from(relations)
          .where(
            and(
              eq(relations.userId, ctx.userId),
              or(
                eq(relations.sourceEntityId, input.entityId),
                eq(relations.targetEntityId, input.entityId)
              )
            )
          );

        return {
          entityId: input.entityId,
          relationCount: relCount.length,
          outgoing: relCount.filter((r) => r.sourceEntityId === input.entityId)
            .length,
          incoming: relCount.filter((r) => r.targetEntityId === input.entityId)
            .length,
        };
      }

      // Global stats
      const facetVisibilityScope = await resolveFacetVisibilityScope(
        ctx.userId
      );
      // Same fail-closed rule as getFull above.
      const typeRows = input.entityType
        ? await assertKnownProfileSlug(db, input.entityType)
        : undefined;
      const allEntities = await db.query.entities.findMany({
        where: and(
          eq(entities.userId, ctx.userId),
          // Polymorphic (Kind + Facets) — same routing as getFull above, built
          // from the rows the assert already resolved.
          input.entityType && typeRows
            ? profileSlugScopeConditionFromRows(
                db,
                input.entityType,
                typeRows,
                {
                  ...facetVisibilityScope,
                }
              )
            : undefined
        ),
      });

      const allRelations = await db.query.relations.findMany({
        where: eq(relations.userId, ctx.userId),
      });

      const typeDistribution: Record<string, number> = {};
      allEntities.forEach((e) => {
        typeDistribution[e.type] = (typeDistribution[e.type] || 0) + 1;
      });

      const relationTypeDistribution: Record<string, number> = {};
      allRelations.forEach((r) => {
        relationTypeDistribution[r.type] =
          (relationTypeDistribution[r.type] || 0) + 1;
      });

      return {
        totalEntities: allEntities.length,
        totalRelations: allRelations.length,
        entityTypeDistribution: typeDistribution,
        relationTypeDistribution,
        averageRelationsPerEntity:
          allEntities.length > 0 ? allRelations.length / allEntities.length : 0,
      };
    }),
});
