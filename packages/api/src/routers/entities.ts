/**
 * Entities Router - Enhanced for infinite chat
 *
 * Handles entity management with agent extraction
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { db, eq, desc, and } from "@synap/database";
import { entities, insertEntitySchema } from "@synap/database/schema";

// TODO: Move to @synap-core/types or DB enum
const EntityTypeSchema = z.enum([
  "task",
  "contact",
  "meeting",
  "idea",
  "note",
  "project",
]);

export const entitiesRouter = router({
  /**
   * Create entity (manual or agent-extracted)
   */
  create: protectedProcedure
    .input(
      insertEntitySchema
        .pick({
          title: true,
          workspaceId: true,
          fileUrl: true,
          filePath: true,
          fileSize: true,
          fileType: true,
        })
        .extend({
          type: EntityTypeSchema,
          description: z.string().optional(), // Maps to 'preview'
        }),
    )
    .mutation(async ({ input, ctx }) => {
      // ✅ Publish .requested event - permission validator will handle permission checks
      const { inngest } = await import("@synap/jobs");

      await inngest.send({
        name: "entities.create.requested",
        data: {
          type: input.type,
          title: input.title,
          preview: input.description,
          workspaceId: input.workspaceId,
          fileUrl: input.fileUrl,
          filePath: input.filePath,
          fileSize: input.fileSize,
          fileType: input.fileType,
          userId: ctx.userId,
        },
        user: { id: ctx.userId },
      });

      return {
        status: "requested",
        message: "Entity creation requested",
      };
    }),

  /**
   * List entities
   */
  list: protectedProcedure
    .input(
      z.object({
        type: EntityTypeSchema.optional(),
        workspaceId: z.string().uuid().optional(),
        limit: z.number().min(1).max(100).default(50),
      }),
    )
    .query(async ({ input, ctx }) => {
      const results = await db.query.entities.findMany({
        where: and(
          eq(entities.userId, ctx.userId),
          input.type ? eq(entities.type, input.type) : undefined,
        ),
        orderBy: [desc(entities.createdAt)],
        limit: input.limit,
      });

      return { entities: results };
    }),

  /**
   * Search entities (vector + text)
   */
  search: protectedProcedure
    .input(
      z.object({
        query: z.string(),
        type: EntityTypeSchema.optional(),
        limit: z.number().min(1).max(50).default(10),
      }),
    )
    .query(async ({ input, ctx }) => {
      // Simple text search for now
      // TODO: Implement vector search with pgvector
      const results = await db.query.entities.findMany({
        where: and(
          eq(entities.userId, ctx.userId),
          input.type ? eq(entities.type, input.type) : undefined,
        ),
        orderBy: [desc(entities.createdAt)],
        limit: input.limit,
      });

      return { entities: results };
    }),

  /**
   * Get entity by ID
   */
  get: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const entity = await db.query.entities.findFirst({
        where: and(eq(entities.id, input.id), eq(entities.userId, ctx.userId)),
      });

      if (!entity) {
        throw new Error("Entity not found");
      }

      return { entity };
    }),

  /**
   * Update entity
   */
  update: protectedProcedure
    .input(
      insertEntitySchema
        .pick({
          type: true,
          preview: true,
          title: true,
          workspaceId: true,
          fileUrl: true,
          filePath: true,
          fileSize: true,
          fileType: true,
        })
        .extend({
          id: z.string().uuid(),
        }),
    )
    .mutation(async ({ input, ctx }) => {
      // ✅ Publish .requested event
      const { inngest } = await import("@synap/jobs");

      await inngest.send({
        name: "entities.update.requested",
        data: {
          entityId: input.id,
          title: input.title,
          preview: input.preview,
          userId: ctx.userId,
        },
        user: { id: ctx.userId },
      });

      return {
        status: "requested",
        message: "Entity update requested",
      };
    }),

  /**
   * Delete entity (soft delete)
   */
  delete: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // ✅ Publish .requested event
      const { inngest } = await import("@synap/jobs");

      await inngest.send({
        name: "entities.delete.requested",
        data: {
          entityId: input.id,
          userId: ctx.userId,
        },
        user: { id: ctx.userId },
      });

      return {
        status: "requested",
        message: "Entity deletion requested",
      };
    }),
});
