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
import { emitRequestEvent } from "../utils/emit-event.js";

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
  /**
   * Create a new tag
   */
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

      // Check for duplicate name (optional but good for UX)
      const existing = await db.query.tags.findFirst({
        where: and(
          eq(tags.userId, userId),
          eq(tags.name, input.name as string),
        ),
      });

      if (existing) {
        throw new Error(`Tag with name "${input.name}" already exists`);
      }

      const id = crypto.randomUUID();
      const optimisticTag = {
        id,
        userId,
        name: input.name as string,
        color: input.color || "#gray",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await emitRequestEvent({
        type: "tags.create.requested",
        subjectId: id,
        subjectType: "tag",
        data: {
          id,
          name: input.name,
          color: input.color || "#gray",
          userId,
        },
        userId,
      });

      logger.info({ userId, tagId: id, name: optimisticTag.name }, "Requested tag creation");

      return { tag: optimisticTag };
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

      const existing = await db.query.tags.findFirst({
        where: and(eq(tags.id, input.id as string), eq(tags.userId, userId)),
      });

      if (!existing) {
        throw new Error("Tag not found");
      }

      const optimisticTag = {
        ...existing,
        name: input.name ?? existing.name,
        color: input.color ?? existing.color,
        updatedAt: new Date(),
      };

      await emitRequestEvent({
        type: "tags.update.requested",
        subjectId: input.id as string,
        subjectType: "tag",
        data: {
          id: input.id,
          name: input.name,
          color: input.color,
          userId,
        },
        userId,
      });

      logger.info({ userId, tagId: input.id }, "Requested tag update");

      return { tag: optimisticTag };
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

      const existing = await db.query.tags.findFirst({
        where: and(eq(tags.id, input.id as string), eq(tags.userId, userId)),
      });

      if (!existing) {
        throw new Error("Tag not found");
      }

      await emitRequestEvent({
        type: "tags.delete.requested",
        subjectId: input.id as string,
        subjectType: "tag",
        data: {
          id: input.id,
          userId,
        },
        userId,
      });

      logger.info({ userId, tagId: input.id }, "Requested tag deletion");

      return { success: true };
    }),

  /**
   * Attach tag to entity
   * Event-driven: emits tags.attach.requested
   */
  attach: protectedProcedure
    .input(
      insertEntityTagSchema.pick({
        tagId: true,
        entityId: true,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await emitRequestEvent({
        eventRepo: ctx.eventRepo,
        inngest: ctx.inngest,
        type: "tags.attach.requested",
        subjectId: input.tagId as string,
        subjectType: "tag",
        data: {
          tagId: input.tagId,
          entityId: input.entityId,
          userId: ctx.userId,
        },
        userId: ctx.userId,
      });
      
      logger.debug(
        { userId: ctx.userId, tagId: input.tagId, entityId: input.entityId },
        "Requested tag attach",
      );

      return { status: "requested" };
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
    .mutation(async ({ ctx, input }) => {
    await emitRequestEvent({
      eventRepo: ctx.eventRepo,
      inngest: ctx.inngest,
      type: "tags.detach.requested",
      subjectId: input.tagId as string,
      subjectType: "tag",
      data: {
        tagId: input.tagId,
        entityId: input.entityId,
        userId: ctx.userId,
      },
      userId: ctx.userId,
    });
    logger.debug(
      { tagId: input.tagId, entityId: input.entityId },
      "Requested tag detach",
    );
    return { status: "requested" };
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
