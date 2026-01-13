/**
 * Tags Router - Tag Management API
 *
 * Handles tag CRUD and entity-tag relationships
 * Uses: tags, entity_tags tables
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { db, tags, entityTags, eq, and, desc } from "@synap/database";
import { insertTagSchema, insertEntityTagSchema } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "tags-router" });

export const tagsRouter = router({
  /**
   * List all tags for the user
   */
  list: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.userId;

    const results = await db.query.tags.findMany({
      where: eq(tags.userId, userId),
      orderBy: [desc(tags.createdAt)],
    });

    logger.debug({ userId, count: results.length }, "Listed tags");

    return { tags: results };
  }),

  /**
   * Create a new tag
   */
  create: protectedProcedure
    .input(
      insertTagSchema.pick({
        name: true,
        color: true,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.userId;

      // Check for duplicate name
      const existing = await db.query.tags.findFirst({
        where: and(
          eq(tags.userId, userId),
          eq(tags.name, input.name as string),
        ),
      });

      if (existing) {
        throw new Error(`Tag with name "${input.name}" already exists`);
      }

      const [tag] = await db
        .insert(tags)
        .values({
          userId,
          name: input.name as string,
          color: input.color || "#gray",
        } as any)
        .returning();

      logger.info({ userId, tagId: tag.id, name: tag.name }, "Created tag");

      return { tag };
    }),

  /**
   * Update tag
   */
  update: protectedProcedure
    .input(
      insertTagSchema
        .pick({
          id: true,
          name: true,
          color: true,
        })
        .partial({
          name: true,
          color: true,
        }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.userId;

      const [updated] = await db
        .update(tags)
        .set({
          name: input.name,
          color: input.color,
        } as any)
        .where(and(eq(tags.id, input.id as string), eq(tags.userId, userId)))
        .returning();

      if (!updated) {
        throw new Error("Tag not found");
      }

      logger.info({ userId, tagId: updated.id }, "Updated tag");

      return { tag: updated };
    }),

  /**
   * Delete tag (and remove all entity associations)
   */
  delete: protectedProcedure
    .input(
      insertTagSchema.pick({
        id: true,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.userId;

      // Delete tag (entity_tags will cascade via DB foreign key)
      const result = await db
        .delete(tags)
        .where(and(eq(tags.id, input.id as string), eq(tags.userId, userId)))
        .returning({ id: tags.id });

      if (result.length === 0) {
        throw new Error("Tag not found");
      }

      logger.info({ userId, tagId: input.id }, "Deleted tag");

      return { success: true };
    }),

  /**
   * Attach tag to entity
   */
  attach: protectedProcedure
    .input(
      insertEntityTagSchema.pick({
        tagId: true,
        entityId: true,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.userId;

      // Verify tag ownership
      const tag = await db.query.tags.findFirst({
        where: and(eq(tags.id, input.tagId as string), eq(tags.userId, userId)),
      });

      if (!tag) {
        throw new Error("Tag not found");
      }

      // Insert with ON CONFLICT DO NOTHING (idempotent)
      await db
        .insert(entityTags)
        .values({
          userId,
          tagId: input.tagId as string,
          entityId: input.entityId as string,
        } as any)
        .onConflictDoNothing();

      logger.debug(
        { userId, tagId: input.tagId, entityId: input.entityId },
        "Attached tag to entity",
      );

      return { success: true };
    }),

  /**
   * Detach tag from entity
   */
  detach: protectedProcedure
    .input(
      insertEntityTagSchema.pick({
        tagId: true,
        entityId: true,
      }),
    )
    .mutation(async ({ input }) => {
      await db
        .delete(entityTags)
        .where(
          and(
            eq(entityTags.tagId, input.tagId as string),
            eq(entityTags.entityId, input.entityId as string),
          ),
        );

      logger.debug(
        { tagId: input.tagId, entityId: input.entityId },
        "Detached tag from entity",
      );

      return { success: true };
    }),

  /**
   * Get all tags for an entity
   */
  getForEntity: protectedProcedure
    .input(
      insertEntityTagSchema.pick({
        entityId: true,
      }),
    )
    .query(async ({ input, ctx }) => {
      const userId = ctx.userId;

      // Query entity_tags join tags
      const results = await db.query.entityTags.findMany({
        where: eq(entityTags.entityId, input.entityId as string),
        with: {
          tag: true,
        },
      });

      // Filter to only user's tags
      const userTags = results
        .filter((et: any) => et.tag?.userId === userId)
        .map((et: any) => et.tag);

      return { tags: userTags };
    }),

  /**
   * Get all entities with a specific tag
   */
  getEntitiesWithTag: protectedProcedure
    .input(
      insertEntityTagSchema
        .pick({
          tagId: true,
        })
        .extend({
          limit: z.number().min(1).max(100).default(50),
        }),
    )
    .query(async ({ input, ctx }) => {
      const userId = ctx.userId;

      // Verify tag ownership
      const tag = await db.query.tags.findFirst({
        where: and(eq(tags.id, input.tagId as string), eq(tags.userId, userId)),
      });

      if (!tag) {
        throw new Error("Tag not found");
      }

      // Get entities via entity_tags join
      const results = await db.query.entityTags.findMany({
        where: eq(entityTags.tagId, input.tagId as string),
        with: {
          entity: true,
        },
        limit: input.limit as number,
      });

      const entities = results
        .map((et: any) => et.entity)
        .filter((e: any) => e?.userId === userId && !e?.deletedAt);

      return { entities };
    }),
});
