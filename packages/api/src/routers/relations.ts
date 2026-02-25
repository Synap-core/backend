/**
 * Relations Router - Relationship Querying
 *
 * Synchronous CRUD operations for entity relationships.
 * Direct DB operations with inline permission checks.
 *
 * This router provides:
 * - get() - Get relations for an entity
 * - getRelated() - Get related entities
 * - getStats() - Get relation statistics
 * - create() - Create a new relation
 * - delete() - Delete a relation
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
import { relations, entities } from "@synap/database/schema";
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
