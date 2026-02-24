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
  sql,
} from "@synap/database";
import {
  relations,
  entities,
  RelationTypeSchema,
  type RelationType,
} from "@synap/database/schema";
import { TRPCError } from "@trpc/server";
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import { auditLog } from "../utils/audit-log.js";
import { emitSideEffects } from "@synap/jobs";
import { randomUUID } from "crypto";

/**
 * Relation Type Metadata
 *
 * Provides human-readable labels, descriptions, and categorization for all relation types.
 * Used by frontend for smart suggestions and UI display.
 */
const RELATION_TYPE_METADATA: Record<
  RelationType,
  {
    label: string;
    description: string;
    directionality: "unidirectional" | "bidirectional";
    category: "workflow" | "social" | "reference" | "hierarchy";
  }
> = {
  assigned_to: {
    label: "Assigned To",
    description: "Person assigned to task/project",
    directionality: "unidirectional",
    category: "workflow",
  },
  blocks: {
    label: "Blocks",
    description: "Prevents progress on another task",
    directionality: "unidirectional",
    category: "workflow",
  },
  depends_on: {
    label: "Depends On",
    description: "Requires completion of another task",
    directionality: "unidirectional",
    category: "workflow",
  },
  relates_to: {
    label: "Relates To",
    description: "General relationship between entities",
    directionality: "bidirectional",
    category: "reference",
  },
  mentions: {
    label: "Mentions",
    description: "Referenced in content",
    directionality: "unidirectional",
    category: "reference",
  },
  links_to: {
    label: "Links To",
    description: "Hyperlink or reference",
    directionality: "unidirectional",
    category: "reference",
  },
  parent_of: {
    label: "Parent Of",
    description: "Hierarchical parent relationship",
    directionality: "unidirectional",
    category: "hierarchy",
  },
  tagged_with: {
    label: "Tagged With",
    description: "Categorization tag",
    directionality: "unidirectional",
    category: "reference",
  },
  created_by: {
    label: "Created By",
    description: "Author or creator",
    directionality: "unidirectional",
    category: "social",
  },
  attended_by: {
    label: "Attended By",
    description: "Participant in event",
    directionality: "unidirectional",
    category: "social",
  },
  belongs_to_project: {
    label: "Belongs To Project",
    description: "Project membership",
    directionality: "unidirectional",
    category: "hierarchy",
  },
  embedded_in: {
    label: "Embedded In",
    description: "Embedded in view or document",
    directionality: "unidirectional",
    category: "reference",
  },
  visualized_in: {
    label: "Visualized In",
    description: "Displayed in view (for tracking)",
    directionality: "unidirectional",
    category: "reference",
  },
  references: {
    label: "References",
    description: "Cites or refers to",
    directionality: "unidirectional",
    category: "reference",
  },
};

/**
 * Direction schema for relation queries
 */
const DirectionSchema = z.enum(["source", "target", "both"]).default("both");

export const relationsRouter = router({
  /**
   * List all available relation types with metadata
   *
   * Returns built-in types plus workspace-defined custom relation definitions.
   * Custom types from relation_defs are categorized as "custom".
   */
  listTypes: protectedProcedure.query(async ({ ctx }) => {
    // Built-in types
    const builtInTypes = Object.entries(RELATION_TYPE_METADATA).map(
      ([type, meta]) => ({
        type,
        ...meta,
        source: "built_in" as const,
      })
    );

    // Workspace-defined custom types (if workspace context is available)
    let customTypes: Array<{
      type: string;
      label: string;
      description: string;
      directionality: "unidirectional" | "bidirectional";
      category: "custom";
      source: "workspace";
    }> = [];

    if (ctx.workspaceId) {
      const database = await getDb();
      const relDefRepo = new RelationDefRepository(database);
      const defs = await relDefRepo.list(ctx.workspaceId);
      customTypes = defs.map((def) => ({
        type: def.slug,
        label: def.displayName,
        description: def.description ?? "",
        directionality: def.isDirectional ? "unidirectional" : "bidirectional",
        category: "custom" as const,
        source: "workspace" as const,
      }));
    }

    return { types: [...builtInTypes, ...customTypes] };
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
        type: RelationTypeSchema.optional(),
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
        type: RelationTypeSchema.optional(),
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

      // Validate type: must be a built-in type OR a workspace-defined relation def
      const isBuiltIn = RelationTypeSchema.safeParse(input.type).success;
      if (!isBuiltIn) {
        const database = await getDb();
        const relDefRepo = new RelationDefRepository(database);
        const customDef = await relDefRepo.getBySlug(
          input.type,
          effectiveWorkspaceId
        );
        if (!customDef) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Unknown relation type: "${input.type}". Must be a built-in type or a workspace-defined relation definition.`,
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
          type: input.type as RelationType,
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
