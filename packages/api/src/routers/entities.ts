/**
 * Entities Router - Profile-Based Entity Management
 *
 * Handles entity CRUD with dynamic profiles (types).
 * No longer uses hardcoded EntityType enums.
 */

import { z } from "zod";
import { router, workspaceProcedure } from "../trpc.js";
import {
  db,
  eq,
  desc,
  and,
  getDb,
  ProfileResolutionService,
} from "@synap/database";
import { entities } from "@synap/database/schema";
import { emitRequestEvent } from "../utils/emit-event.js";
import { type Entity, EntitySchema } from "@synap-core/types";
import { TRPCError } from "@trpc/server";

export const entitiesRouter = router({
  /**
   * Create entity with profile-based type system
   */
  create: workspaceProcedure
    .input(
      z.object({
        profileSlug: z.string().optional(), // Preferred: use profile slug
        profileId: z.string().uuid().optional(), // Alternative: use profile ID
        title: z.string().optional(),
        description: z.string().optional(),
        properties: z.record(z.string(), z.unknown()).optional(), // Properties validated against profile
        documentId: z.string().uuid().optional(),
      })
    )
    .output(
      z.object({
        status: z.string(),
        message: z.string(),
        id: z.string().uuid(),
        entity: z.any(), // Use z.any() since we're using dynamic profile slugs (BaseEntity)
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { randomUUID } = await import("crypto");
      const entityId = randomUUID();

      // Resolve profile if provided
      let profileSlug: string | undefined;
      if (input.profileSlug) {
        profileSlug = input.profileSlug;
      } else if (input.profileId) {
        const db = await getDb();
        const resolutionService = new ProfileResolutionService(db);
        const profile = await resolutionService.resolveProfile(
          input.profileId,
          ctx.userId,
          ctx.workspaceId
        );
        if (!profile) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Profile not found: ${input.profileId}`,
          });
        }
        profileSlug = profile.slug;
      } else {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Either profileSlug or profileId must be provided",
        });
      }

      // Use BaseEntity type since we're using dynamic profile slugs
      // EntitySchema is a discriminated union that requires specific type literals
      const optimisticEntity = {
        id: entityId,
        type: profileSlug, // Use profile slug as type (dynamic, not in EntitySchema union)
        title: input.title ?? null,
        preview: input.description ?? null,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        documentId: input.documentId ?? null,
        properties: input.properties || {},
        metadata: {}, // Legacy field, kept for compatibility
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        version: 1,
        projectIds: [],
        fileUrl: null,
        filePath: null,
        fileSize: null,
        fileType: null,
        checksum: null,
      };

      // Emit request event (stores in event log + publishes to Inngest)
      await emitRequestEvent({
        subjectType: "entity",
        action: "create",
        subjectId: entityId,
        data: {
          id: entityId,
          profileSlug: input.profileSlug,
          profileId: input.profileId,
          title: input.title,
          preview: input.description,
          properties: input.properties,
          workspaceId: ctx.workspaceId,
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
   * List entities (workspace-scoped)
   */
  list: workspaceProcedure
    .input(
      z.object({
        profileSlug: z.string().optional(), // Filter by profile slug
        limit: z.number().min(1).max(100).default(50),
      })
    )
    .output(
      z.object({
        entities: z.array(EntitySchema),
      })
    )
    .query(async ({ input, ctx }) => {
      const conditions: any[] = [
        eq(entities.workspaceId, ctx.workspaceId),
        eq(entities.userId, ctx.userId),
      ];

      if (input.profileSlug) {
        conditions.push(eq(entities.type, input.profileSlug));
      }

      const results = await db.query.entities.findMany({
        where: and(...conditions),
        orderBy: [desc(entities.createdAt)],
        limit: input.limit,
      });

      // Map to Entity type (properties field is already in entities table)
      const typedEntities = results.map((entity) => ({
        ...entity,
        properties: entity.properties || {},
        fileUrl: null,
        filePath: null,
        fileSize: null,
        fileType: null,
        checksum: null,
      })) as Entity[];

      return { entities: typedEntities };
    }),

  /**
   * Search entities (vector + text)
   */
  search: workspaceProcedure
    .input(
      z.object({
        query: z.string(),
        profileSlug: z.string().optional(),
        limit: z.number().min(1).max(50).default(10),
      })
    )
    .output(
      z.object({
        entities: z.array(EntitySchema),
      })
    )
    .query(async ({ input, ctx }) => {
      const conditions: any[] = [
        eq(entities.workspaceId, ctx.workspaceId),
        eq(entities.userId, ctx.userId),
      ];

      if (input.profileSlug) {
        conditions.push(eq(entities.type, input.profileSlug));
      }

      const results = await db.query.entities.findMany({
        where: and(...conditions),
        orderBy: [desc(entities.createdAt)],
        limit: input.limit,
      });

      const typedEntities = results.map((entity) => ({
        ...entity,
        properties: entity.properties || {},
        fileUrl: null,
        filePath: null,
        fileSize: null,
        fileType: null,
        checksum: null,
      })) as Entity[];

      return { entities: typedEntities };
    }),

  /**
   * Get entity by ID
   */
  get: workspaceProcedure
    .input(
      z.object({
        id: z.string().uuid(),
      })
    )
    .output(
      z.object({
        entity: z.any(), // Use z.any() since entity can have dynamic profile slug
      })
    )
    .query(async ({ input, ctx }) => {
      const entity = await db.query.entities.findFirst({
        where: and(
          eq(entities.id, input.id),
          eq(entities.workspaceId, ctx.workspaceId),
          eq(entities.userId, ctx.userId)
        ),
      });

      if (!entity) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Entity not found",
        });
      }

      const typedEntity = {
        ...entity,
        properties: entity.properties || {},
        fileUrl: null,
        filePath: null,
        fileSize: null,
        fileType: null,
        checksum: null,
      } as Entity;

      return { entity: typedEntity };
    }),

  /**
   * Update entity
   */
  update: workspaceProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        title: z.string().optional(),
        description: z.string().optional(),
        properties: z.record(z.string(), z.unknown()).optional(), // Properties validated against profile
      })
    )
    .mutation(async ({ input, ctx }) => {
      await emitRequestEvent({
        subjectType: "entity",
        action: "update",
        subjectId: input.id,
        data: {
          id: input.id,
          title: input.title,
          preview: input.description,
          properties: input.properties,
          workspaceId: ctx.workspaceId,
          userId: ctx.userId,
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
  delete: workspaceProcedure
    .input(
      z.object({
        id: z.string().uuid(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      await emitRequestEvent({
        subjectType: "entity",
        action: "delete",
        subjectId: input.id,
        data: {
          id: input.id,
          workspaceId: ctx.workspaceId,
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
