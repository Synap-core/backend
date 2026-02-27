/**
 * Relations Router — Semantic Graph Relations
 *
 * Manages TYPED GRAPH EDGES between entities (the `relations` table).
 * These are SEMANTIC / EMERGENT relationships — not predefined by profile schemas.
 *
 * ── Two connection systems in Synap ──────────────────────────────────────────
 *
 * 1. STRUCTURAL LINKS (entity_id properties)
 *    - Defined in profile schemas as properties with `valueType: "entity_id"`
 *    - Part of the entity's core data model (e.g. Task.assignee, Deal.contact)
 *    - Schema-first, form-based, one-directional
 *    - How templates wire things together
 *
 * 2. SEMANTIC RELATIONS (this router — `relations` table)
 *    - Created on the fly: by users, AI, or automations
 *    - Not tied to any profile schema
 *    - Bi-directional, traversable, support metadata
 *    - Power the knowledge graph view
 *    - Types come from `relation_defs` (workspace-scoped, DB-driven)
 *
 * Use `getConnections()` to fetch BOTH systems unified in one response.
 *
 * @see /docs/docs/concepts/entity-connections.md — full architecture guide
 *
 * Procedures:
 * - listTypes()       - All relation types available in this workspace
 * - get()             - Semantic relations for an entity
 * - getRelated()      - Resolved entity objects that are related
 * - getStats()        - Relation count statistics
 * - getConnections()  - UNIFIED: graph + property links + thread references
 * - create()          - Create a new semantic relation
 * - delete()          - Delete a semantic relation
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import {
  db,
  eq,
  and,
  or,
  desc,
  getDb,
  EventRepository,
  RelationRepository,
  RelationDefRepository,
  SYSTEM_RELATION_TYPES,
  sql,
} from "@synap/database";
import {
  relations,
  entities,
  entityPropertyIndex,
  propertyDefs,
  channelContextItems,
  ChannelContextObjectType,
} from "@synap/database/schema";
import { TRPCError } from "@trpc/server";
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import { auditLog } from "../utils/audit-log.js";
import { emitSideEffects } from "@synap/jobs";
import { randomUUID } from "crypto";

/**
 * Direction schema for relation queries
 */
const DirectionSchema = z.enum(["source", "target", "both"]).default("both");

export const relationsRouter = router({
  /**
   * List all available relation types with metadata
   *
   * Returns all relation definitions from the workspace's relation_defs table.
   * Default types (assigned_to, depends_on, etc.) are seeded during workspace creation.
   */
  listTypes: protectedProcedure.query(async ({ ctx }) => {
    if (!ctx.workspaceId) {
      return { types: [] };
    }

    const database = await getDb();
    const relDefRepo = new RelationDefRepository(database);
    const defs = await relDefRepo.list(ctx.workspaceId);

    const types = defs.map((def) => ({
      type: def.slug,
      label: def.displayName,
      description: def.description ?? "",
      directionality: def.isDirectional
        ? ("unidirectional" as const)
        : ("bidirectional" as const),
      category:
        ((def.uiHints as any)?.category as string) ?? ("custom" as const),
      source: "workspace" as const,
    }));

    return { types };
  }),

  /**
   * Get relations for an entity
   *
   * Returns relationship records (not the related entities themselves).
   * Use getRelated() to get the actual entities.
   */
  get: protectedProcedure
    .input(
      z.object({
        entityId: z.string().uuid(),
        type: z.string().optional(),
        direction: DirectionSchema,
        limit: z.number().min(1).max(100).default(50),
      })
    )
    .query(async ({ input, ctx }) => {
      // Build where clause based on direction
      let whereClause;

      if (input.direction === "both") {
        whereClause = and(
          eq(relations.userId, ctx.userId),
          or(
            eq(relations.sourceEntityId, input.entityId),
            eq(relations.targetEntityId, input.entityId)
          ),
          input.type ? eq(relations.type, input.type) : undefined
        );
      } else if (input.direction === "source") {
        whereClause = and(
          eq(relations.userId, ctx.userId),
          eq(relations.sourceEntityId, input.entityId),
          input.type ? eq(relations.type, input.type) : undefined
        );
      } else {
        whereClause = and(
          eq(relations.userId, ctx.userId),
          eq(relations.targetEntityId, input.entityId),
          input.type ? eq(relations.type, input.type) : undefined
        );
      }

      const results = await db.query.relations.findMany({
        where: whereClause,
        orderBy: [desc(relations.createdAt)],
        limit: input.limit,
      });

      return { relations: results };
    }),

  /**
   * Get related entities
   *
   * Returns the actual entity objects that are related,
   * not just the relationship records.
   */
  getRelated: protectedProcedure
    .input(
      z.object({
        entityId: z.string().uuid(),
        type: z.string().optional(),
        direction: DirectionSchema,
        limit: z.number().min(1).max(100).default(50),
      })
    )
    .query(async ({ input, ctx }) => {
      // Get relations first
      let relationRecords;

      if (input.direction === "both") {
        relationRecords = await db.query.relations.findMany({
          where: and(
            eq(relations.userId, ctx.userId),
            or(
              eq(relations.sourceEntityId, input.entityId),
              eq(relations.targetEntityId, input.entityId)
            ),
            input.type ? eq(relations.type, input.type) : undefined
          ),
          orderBy: [desc(relations.createdAt)],
          limit: input.limit,
        });
      } else if (input.direction === "source") {
        relationRecords = await db.query.relations.findMany({
          where: and(
            eq(relations.userId, ctx.userId),
            eq(relations.sourceEntityId, input.entityId),
            input.type ? eq(relations.type, input.type) : undefined
          ),
          orderBy: [desc(relations.createdAt)],
          limit: input.limit,
        });
      } else {
        relationRecords = await db.query.relations.findMany({
          where: and(
            eq(relations.userId, ctx.userId),
            eq(relations.targetEntityId, input.entityId),
            input.type ? eq(relations.type, input.type) : undefined
          ),
          orderBy: [desc(relations.createdAt)],
          limit: input.limit,
        });
      }

      // Extract entity IDs (the "other" entity in each relation)
      const relatedEntityIds = relationRecords.map((rel) => {
        return rel.sourceEntityId === input.entityId
          ? rel.targetEntityId
          : rel.sourceEntityId;
      });

      if (relatedEntityIds.length === 0) {
        return { entities: [] };
      }

      // Fetch the actual entities
      const relatedEntities = await db.query.entities.findMany({
        where: and(
          eq(entities.userId, ctx.userId),
          or(...relatedEntityIds.map((id) => eq(entities.id, id)))
        ),
      });

      return { entities: relatedEntities };
    }),

  /**
   * Get relation statistics for an entity
   */
  getStats: protectedProcedure
    .input(
      z.object({
        entityId: z.string().uuid(),
      })
    )
    .query(async ({ input, ctx }) => {
      const allRelations = await db.query.relations.findMany({
        where: and(
          eq(relations.userId, ctx.userId),
          or(
            eq(relations.sourceEntityId, input.entityId),
            eq(relations.targetEntityId, input.entityId)
          )
        ),
      });

      // Count by type
      const byType: Record<string, number> = {};
      allRelations.forEach((rel) => {
        byType[rel.type] = (byType[rel.type] || 0) + 1;
      });

      return {
        total: allRelations.length,
        outgoing: allRelations.filter(
          (r) => r.sourceEntityId === input.entityId
        ).length,
        incoming: allRelations.filter(
          (r) => r.targetEntityId === input.entityId
        ).length,
        byType,
      };
    }),

  /**
   * Create a new relation between entities
   */
  create: protectedProcedure
    .input(
      z.object({
        sourceEntityId: z.string().uuid(),
        targetEntityId: z.string().uuid(),
        // Accept both built-in relation types and workspace-defined custom types
        type: z.string().min(1),
        metadata: z.record(z.string(), z.any()).optional(),
        workspaceId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const id = randomUUID();
      // Resolve workspace ID: prefer explicit input, fall back to context header
      const effectiveWorkspaceId = input.workspaceId || ctx.workspaceId;
      if (!effectiveWorkspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "workspaceId is required (pass in input or set X-Workspace-Id header)",
        });
      }

      // Validate type: must be a system type OR a workspace-defined relation def
      const isSystemType = (
        SYSTEM_RELATION_TYPES as readonly string[]
      ).includes(input.type);
      if (!isSystemType) {
        const database = await getDb();
        const relDefRepo = new RelationDefRepository(database);
        const def = await relDefRepo.getBySlug(
          input.type,
          effectiveWorkspaceId
        );
        if (!def) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Unknown relation type: "${input.type}". Must be a workspace relation definition.`,
          });
        }
      }

      // 1. Permission check
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: effectiveWorkspaceId,
        subjectType: "relation",
        action: "create",
        data: {
          id,
          sourceEntityId: input.sourceEntityId,
          targetEntityId: input.targetEntityId,
          type: input.type,
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return { status: "proposed" as const, proposalId: perm.proposalId };
      }

      // 2. Direct DB operation
      const database = await getDb();
      const eventRepo = new EventRepository(sql);
      const relationRepo = new RelationRepository(database, eventRepo);

      const relation = await relationRepo.create(
        {
          id,
          sourceEntityId: input.sourceEntityId,
          targetEntityId: input.targetEntityId,
          type: input.type,
          workspaceId: effectiveWorkspaceId,
          userId: ctx.userId,
          metadata: input.metadata,
        },
        ctx.userId
      );

      // 3. Audit log
      auditLog({
        subjectType: "relation",
        action: "create",
        phase: "completed",
        subjectId: relation.id,
        userId: ctx.userId,
        workspaceId: effectiveWorkspaceId,
        data: {
          sourceEntityId: input.sourceEntityId,
          targetEntityId: input.targetEntityId,
          type: input.type,
        },
      });

      // 4. Side-effects
      emitSideEffects({
        subjectType: "relation",
        action: "create",
        subjectId: relation.id,
        userId: ctx.userId,
        workspaceId: effectiveWorkspaceId,
      });

      return {
        id: relation.id,
        status: "created" as const,
      };
    }),

  /**
   * Get all connections for an entity — unified across three sources:
   *
   * 1. **Semantic graph relations** (`relations` table) — typed graph edges
   *    created manually, by AI, or via the whiteboard.
   *
   * 2. **Structural property links** (`entity_property_index`) — entities whose
   *    `entity_id` properties point to this entity. These come from the profile
   *    schema and represent structural "belongs to / assigned to" style links.
   *
   * 3. **Channel connections** (`channel_context_items`) — channels that
   *    created, updated, or referenced this entity.
   *
   * Use this endpoint to build a unified "Connections" panel on an entity card
   * or to traverse the full knowledge graph around any entity.
   */
  getConnections: protectedProcedure
    .input(
      z.object({
        entityId: z.string().uuid(),
        /** Maximum items per source (default 50) */
        limit: z.number().min(1).max(200).default(50),
      })
    )
    .query(async ({ input, ctx }) => {
      const [graphRelations, propertyLinks, channelLinks] = await Promise.all([
        // ── 1. Semantic graph relations ─────────────────────────────────────
        db.query.relations.findMany({
          where: and(
            eq(relations.userId, ctx.userId),
            or(
              eq(relations.sourceEntityId, input.entityId),
              eq(relations.targetEntityId, input.entityId)
            )
          ),
          orderBy: [desc(relations.createdAt)],
          limit: input.limit,
        }),

        // ── 2. Structural property links (reverse lookup via index) ──────────
        // Find all entities whose entity_id properties point TO this entity.
        // Uses the entity_property_index.value_entity_id column (indexed).
        db
          .select({
            sourceEntityId: entityPropertyIndex.entityId,
            propertyDefId: entityPropertyIndex.propertyDefId,
            propertySlug: propertyDefs.slug,
            propertyUiHints: propertyDefs.uiHints,
          })
          .from(entityPropertyIndex)
          .innerJoin(
            propertyDefs,
            eq(entityPropertyIndex.propertyDefId, propertyDefs.id)
          )
          .where(eq(entityPropertyIndex.valueEntityId, input.entityId))
          .limit(input.limit),

        // ── 3. Channel connections ───────────────────────────────────────────
        db.query.channelContextItems.findMany({
          where: and(
            eq(channelContextItems.objectId, input.entityId),
            eq(channelContextItems.objectType, ChannelContextObjectType.ENTITY),
            eq(channelContextItems.userId, ctx.userId)
          ),
          orderBy: (ci, { desc }) => [desc(ci.createdAt)],
          limit: input.limit,
        }),
      ]);

      // Collect all entity IDs we need to resolve
      const entityIdsToFetch = new Set<string>();

      for (const rel of graphRelations) {
        const otherId =
          rel.sourceEntityId === input.entityId
            ? rel.targetEntityId
            : rel.sourceEntityId;
        entityIdsToFetch.add(otherId);
      }
      for (const link of propertyLinks) {
        entityIdsToFetch.add(link.sourceEntityId);
      }

      // Fetch all referenced entities in one query
      const entityMap = new Map<string, typeof entities.$inferSelect>();
      if (entityIdsToFetch.size > 0) {
        const fetched = await db.query.entities.findMany({
          where: and(
            eq(entities.userId, ctx.userId),
            or(...[...entityIdsToFetch].map((id) => eq(entities.id, id)))
          ),
        });
        for (const e of fetched) {
          entityMap.set(e.id, e);
        }
      }

      // ── Shape the result ──────────────────────────────────────────────────

      type Connection = {
        entityId: string;
        entity: typeof entities.$inferSelect | null;
        label: string;
        direction: "outgoing" | "incoming" | "structural";
        source: "graph" | "property" | "thread";
        relationType?: string;
        /** Slug of the property that holds the link (e.g. "assignee", "project") */
        propertySlug?: string;
        /** Human-readable label of that property */
        propertyLabel?: string;
        channelId?: string;
        channelRelationshipType?: string;
        createdAt?: Date | null;
      };

      const connections: Connection[] = [];

      for (const rel of graphRelations) {
        const isOutgoing = rel.sourceEntityId === input.entityId;
        const otherId = isOutgoing ? rel.targetEntityId : rel.sourceEntityId;
        connections.push({
          entityId: otherId,
          entity: entityMap.get(otherId) ?? null,
          label: rel.type,
          direction: isOutgoing ? "outgoing" : "incoming",
          source: "graph",
          relationType: rel.type,
          createdAt: rel.createdAt,
        });
      }

      for (const link of propertyLinks) {
        const uiHints = (link.propertyUiHints ?? {}) as Record<string, unknown>;
        const propertyLabel =
          (uiHints.label as string | undefined) ?? link.propertySlug ?? "link";
        connections.push({
          entityId: link.sourceEntityId,
          entity: entityMap.get(link.sourceEntityId) ?? null,
          label: propertyLabel,
          direction: "structural",
          source: "property",
          propertySlug: link.propertySlug ?? undefined,
          propertyLabel,
          createdAt: null,
        });
      }

      for (const ci of channelLinks) {
        connections.push({
          entityId: ci.objectId,
          entity: null,
          label: ci.relationshipType,
          direction: "incoming",
          source: "thread",
          channelId: ci.channelId,
          channelRelationshipType: ci.relationshipType,
          createdAt: ci.createdAt,
        });
      }

      return {
        connections,
        counts: {
          total: connections.length,
          graph: graphRelations.length,
          structural: propertyLinks.length,
          threads: channelLinks.length,
        },
      };
    }),

  /**
   * Delete a relation
   */
  delete: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        workspaceId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Resolve workspace ID: prefer explicit input, fall back to context header
      const effectiveWorkspaceId =
        input.workspaceId || ctx.workspaceId || undefined;

      // 1. Permission check
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: effectiveWorkspaceId,
        subjectType: "relation",
        action: "delete",
        data: { id: input.id },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return { status: "proposed" as const, proposalId: perm.proposalId };
      }

      // 2. Direct DB operation
      const database = await getDb();
      const eventRepo = new EventRepository(sql);
      const relationRepo = new RelationRepository(database, eventRepo);

      await relationRepo.delete(input.id, ctx.userId);

      // 3. Audit log
      auditLog({
        subjectType: "relation",
        action: "delete",
        phase: "completed",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: effectiveWorkspaceId,
        data: { id: input.id },
      });

      // 4. Side-effects
      emitSideEffects({
        subjectType: "relation",
        action: "delete",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: effectiveWorkspaceId,
      });

      return {
        status: "deleted" as const,
      };
    }),
});
