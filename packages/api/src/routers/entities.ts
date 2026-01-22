/**
 * Entities Router - Enhanced for infinite chat
 *
 * Handles entity management with agent extraction
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { db, eq, desc, and } from "@synap/database";
import { entities } from "@synap/database/schema";
import { emitRequestEvent } from "../utils/emit-event.js";
import {
  validateEntityMetadata,
  type EntityType,
  type Entity,
  EntitySchema,
} from "@synap-core/types";

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
      z.object({
        type: EntityTypeSchema,
        title: z.string().optional(),
        description: z.string().optional(),
        workspaceId: z.string().uuid().optional(),
        documentId: z.string().uuid().optional(),
      })
    )
    .output(
      z.object({
        status: z.string(),
        message: z.string(),
        id: z.string().uuid(),
        entity: EntitySchema,
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { randomUUID } = await import("crypto");
      const entityId = randomUUID();

      // Get default metadata for the type
      const defaultMetadata = validateEntityMetadata(input.type, {});

      const optimisticEntity = {
        id: entityId,
        type: input.type,
        title: input.title ?? null,
        preview: input.description ?? null,
        userId: ctx.userId,
        workspaceId: input.workspaceId ?? null,
        documentId: input.documentId ?? null,
        metadata: defaultMetadata,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        // Missing fields defaults
        fileUrl: null,
        filePath: null,
        fileSize: null,
        fileType: null,
        checksum: null,
        version: 1,
        projectIds: [],
      } as Entity;

      // Emit request event (stores in event log + publishes to Inngest)
      await emitRequestEvent({
        type: "entities.create.requested",
        subjectId: entityId,
        subjectType: "entity",
        data: {
          id: entityId,
          type: input.type,
          title: input.title,
          preview: input.description,
          workspaceId: input.workspaceId,
          documentId: input.documentId,
          userId: ctx.userId,
        },
        userId: ctx.userId,
      });

      return {
        status: "requested",
        message: "Entity creation requested",
        id: entityId,
        entity: optimisticEntity,
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
      })
    )
    .query(async ({ input, ctx }) => {
      const results = await db.query.entities.findMany({
        where: and(
          eq(entities.userId, ctx.userId),
          input.type ? eq(entities.type, input.type) : undefined
        ),
        orderBy: [desc(entities.createdAt)],
        limit: input.limit,
      });

      const typedEntities = results.map((entity) => {
        try {
          const typedMetadata = validateEntityMetadata(
            entity.type as EntityType,
            entity.metadata
          );

          return {
            ...entity,
            metadata: typedMetadata,
            fileUrl: null,
            filePath: null,
            fileSize: null,
            fileType: null,
            checksum: null,
          } as Entity;
        } catch (e) {
          console.warn(
            `Entity ${entity.id} has invalid metadata for type ${entity.type}`,
            e
          );
          return {
            ...entity,
            metadata: {},
            fileUrl: null,
            filePath: null,
            fileSize: null,
            fileType: null,
            checksum: null,
          } as unknown as Entity;
        }
      });

      return { entities: typedEntities };
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
      })
    )
    .query(async ({ input, ctx }) => {
      // Simple text search for now
      // TODO: Implement vector search with pgvector
      const results = await db.query.entities.findMany({
        where: and(
          eq(entities.userId, ctx.userId),
          input.type ? eq(entities.type, input.type) : undefined
        ),
        orderBy: [desc(entities.createdAt)],
        limit: input.limit,
      });

      const typedEntities = results.map((entity) => {
        try {
          const typedMetadata = validateEntityMetadata(
            entity.type as EntityType,
            entity.metadata
          );
          return {
            ...entity,
            metadata: typedMetadata,
            fileUrl: null,
            filePath: null,
            fileSize: null,
            fileType: null,
            checksum: null,
          } as Entity;
        } catch (e) {
          console.warn(`Entity ${entity.id} has invalid metadata`, e);
          return {
            ...entity,
            metadata: {},
            fileUrl: null,
            filePath: null,
            fileSize: null,
            fileType: null,
            checksum: null,
          } as unknown as Entity;
        }
      });

      return { entities: typedEntities };
    }),

  /**
   * Get entity by ID
   */
  get: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
      })
    )
    .output(
      z.object({
        entity: EntitySchema,
      })
    )
    .query(async ({ input, ctx }) => {
      const entity = await db.query.entities.findFirst({
        where: and(eq(entities.id, input.id), eq(entities.userId, ctx.userId)),
      });

      if (!entity) {
        throw new Error("Entity not found");
      }

      let typedEntity: Entity;
      try {
        const typedMetadata = validateEntityMetadata(
          entity.type as EntityType,
          entity.metadata
        );
        typedEntity = {
          ...entity,
          metadata: typedMetadata,
          fileUrl: null,
          filePath: null,
          fileSize: null,
          fileType: null,
          checksum: null,
        } as Entity;
      } catch (e) {
        console.warn(`Entity ${entity.id} has invalid metadata`, e);
        typedEntity = {
          ...entity,
          metadata: {},
          fileUrl: null,
          filePath: null,
          fileSize: null,
          fileType: null,
          checksum: null,
        } as unknown as Entity;
      }

      return { entity: typedEntity };
    }),

  /**
   * Update entity
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        type: z
          .enum(["note", "task", "project", "contact", "meeting", "idea"])
          .optional(),
        title: z.string().optional(),
        preview: z.string().optional(),
        workspaceId: z.string().uuid().optional(),
        documentId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      await emitRequestEvent({
        type: "entities.update.requested",
        subjectId: input.id,
        subjectType: "entity",
        data: {
          entityId: input.id,
          title: input.title,
          preview: input.preview,
          userId: ctx.userId,
          workspaceId: input.workspaceId,
        },
        userId: ctx.userId,
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
      })
    )
    .mutation(async ({ input, ctx }) => {
      await emitRequestEvent({
        type: "entities.delete.requested",
        subjectId: input.id,
        subjectType: "entity",
        data: {
          entityId: input.id,
          userId: ctx.userId,
        },
        userId: ctx.userId,
      });

      return {
        status: "requested",
        message: "Entity deletion requested",
      };
    }),
});
