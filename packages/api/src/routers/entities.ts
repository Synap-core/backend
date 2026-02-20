/**
 * Entities Router - Profile-Based Entity Management
 *
 * Synchronous CRUD with inline permission checks.
 * No longer uses event pipeline — direct DB operations.
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
  EventRepository,
  EntityRepository,
  DocumentRepository,
  sql,
} from "@synap/database";
import { entities, documents } from "@synap/database/schema";
import { type Entity, EntitySchema } from "@synap-core/types";
import { TRPCError } from "@trpc/server";
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import { auditLog } from "../utils/audit-log.js";
import { emitSideEffects } from "@synap/jobs";

export const entitiesRouter = router({
  /**
   * Create entity with profile-based type system
   */
  create: workspaceProcedure
    .input(
      z.object({
        profileSlug: z.string().optional(),
        profileId: z.string().uuid().optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        properties: z.record(z.string(), z.unknown()).optional(),
        documentId: z.string().uuid().optional(),
        content: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { randomUUID } = await import("crypto");
      const entityId = randomUUID();

      // Resolve profile
      let profileSlug: string | undefined;
      if (input.profileSlug) {
        profileSlug = input.profileSlug;
      } else if (input.profileId) {
        const database = await getDb();
        const resolutionService = new ProfileResolutionService(database);
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

      // Permission check
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        subjectType: "entity",
        action: "create",
        data: { id: entityId, profileSlug, title: input.title },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          status: "proposed",
          message: "Entity creation proposed for review",
          id: entityId,
          entity: null as any,
          proposalId: perm.proposalId,
        };
      }

      // Direct DB operation
      const database = await getDb();
      const eventRepo = new EventRepository(sql);
      const entityRepo = new EntityRepository(database, eventRepo);
      const docRepo = new DocumentRepository(database, eventRepo);

      let createdEntity: any;

      if (input.content) {
        // Atomic entity + document creation
        const { storage } = await import("@synap/storage");

        const content = input.content || "";
        const key = storage.buildPath(ctx.userId, "entity", entityId, "md");
        const metadata = await storage.upload(key, content, {
          contentType: "text/markdown",
        });

        const createdDocument = await docRepo.create(
          {
            title: input.title || "Untitled",
            type: "markdown",
            storageUrl: metadata.url,
            storageKey: metadata.path,
            size: metadata.size,
            mimeType: "text/markdown",
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
          },
          ctx.userId
        );

        createdEntity = await entityRepo.create(
          {
            workspaceId: ctx.workspaceId,
            userId: ctx.userId,
            title: input.title || undefined,
            preview: input.description || undefined,
            documentId: createdDocument.id,
            properties: input.properties || undefined,
            profileSlug,
          },
          ctx.userId
        );

        await docRepo.update(
          createdDocument.id,
          { entityId: createdEntity.id },
          ctx.userId
        );
      } else {
        // Simple entity creation
        createdEntity = await entityRepo.create(
          {
            workspaceId: ctx.workspaceId,
            userId: ctx.userId,
            title: input.title || undefined,
            preview: input.description || undefined,
            documentId: input.documentId || undefined,
            properties: input.properties || undefined,
            profileSlug,
          },
          ctx.userId
        );
      }

      // Audit + side-effects (fire-and-forget)
      auditLog({
        subjectType: "entity",
        action: "create",
        phase: "completed",
        subjectId: createdEntity.id,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        data: { profileSlug, title: input.title },
      });

      emitSideEffects({
        subjectType: "entity",
        action: "create",
        subjectId: createdEntity.id,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        data: { profileSlug, title: input.title },
      });

      return {
        status: "created",
        message: "Entity created",
        id: createdEntity.id,
        entity: {
          ...createdEntity,
          properties: createdEntity.properties || {},
          fileUrl: null,
          filePath: null,
          fileSize: null,
          fileType: null,
          checksum: null,
        },
      };
    }),

  /**
   * List entities (workspace-scoped)
   */
  list: workspaceProcedure
    .input(
      z.object({
        profileSlug: z.string().optional(),
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
   * Get entity by document ID (reverse lookup)
   */
  getByDocumentId: workspaceProcedure
    .input(z.object({ documentId: z.string().uuid() }))
    .output(z.object({ entity: z.any().nullable() }))
    .query(async ({ input, ctx }) => {
      const entity = await db.query.entities.findFirst({
        where: and(
          eq(entities.documentId, input.documentId),
          eq(entities.workspaceId, ctx.workspaceId),
          eq(entities.userId, ctx.userId)
        ),
      });

      if (!entity) return { entity: null };

      return {
        entity: {
          ...entity,
          properties: entity.properties || {},
          fileUrl: null,
          filePath: null,
          fileSize: null,
          fileType: null,
          checksum: null,
        } as Entity,
      };
    }),

  /**
   * Get entity by ID
   */
  get: workspaceProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        includeProfile: z.boolean().optional().default(false),
      })
    )
    .output(
      z.object({
        entity: z.any(),
        profile: z.any().optional(),
        effectiveProperties: z.array(z.any()).optional(),
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
        throw new TRPCError({ code: "NOT_FOUND", message: "Entity not found" });
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

      if (!input.includeProfile) {
        return { entity: typedEntity };
      }

      const database = await getDb();
      const resolutionService = new ProfileResolutionService(database);
      const profile = await resolutionService.resolveProfile(
        entity.type,
        ctx.userId,
        ctx.workspaceId
      );

      if (!profile) return { entity: typedEntity };

      const effectiveProperties =
        await resolutionService.getEffectiveProperties(profile.id);

      return { entity: typedEntity, profile, effectiveProperties };
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
        documentId: z.string().uuid().nullable().optional(),
        properties: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Permission check
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        subjectType: "entity",
        action: "update",
        data: { id: input.id },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return { status: "proposed", message: "Update proposed for review", proposalId: perm.proposalId };
      }

      // Direct DB operation
      const database = await getDb();
      const eventRepo = new EventRepository(sql);
      const entityRepo = new EntityRepository(database, eventRepo);
      const docRepo = new DocumentRepository(database, eventRepo);

      // Check for document link changes
      const previousEntity = await db.query.entities.findFirst({
        where: and(eq(entities.id, input.id), eq(entities.userId, ctx.userId)),
        columns: { documentId: true },
      });

      await entityRepo.update(
        input.id,
        {
          title: input.title || undefined,
          preview: input.description || undefined,
          documentId: input.documentId,
          properties: input.properties || undefined,
        },
        ctx.userId
      );

      // Sync document.entityId when entity.documentId changes
      const oldDocumentId = previousEntity?.documentId ?? null;
      const newDocumentId = input.documentId ?? null;
      if (oldDocumentId !== newDocumentId) {
        if (oldDocumentId) {
          await docRepo.update(oldDocumentId, { entityId: null }, ctx.userId);
        }
        if (newDocumentId) {
          await docRepo.update(newDocumentId, { entityId: input.id }, ctx.userId);
        }
      }

      // Audit + side-effects
      auditLog({
        subjectType: "entity",
        action: "update",
        phase: "completed",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
      });

      emitSideEffects({
        subjectType: "entity",
        action: "update",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
      });

      return { status: "updated", message: "Entity updated" };
    }),

  /**
   * Delete entity (soft delete)
   */
  delete: workspaceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      // Permission check
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        subjectType: "entity",
        action: "delete",
        data: { id: input.id },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return { status: "proposed", message: "Deletion proposed for review", proposalId: perm.proposalId };
      }

      const database = await getDb();
      const eventRepo = new EventRepository(sql);
      const entityRepo = new EntityRepository(database, eventRepo);
      const docRepo = new DocumentRepository(database, eventRepo);

      // Check for cascading document deletion
      const { getUserPreference } = await import("@synap/database");
      const userPref = await getUserPreference(ctx.userId, "entity.deleteDocument");

      if (userPref) {
        const entity = await db.query.entities.findFirst({
          where: and(eq(entities.id, input.id), eq(entities.userId, ctx.userId)),
        });

        if (entity?.documentId) {
          const document = await db.query.documents.findFirst({
            where: and(
              eq(documents.id, entity.documentId),
              eq(documents.userId, ctx.userId)
            ),
          });

          if (document) {
            const { storage } = await import("@synap/storage");
            try {
              if (document.storageKey) await storage.delete(document.storageKey);
            } catch {}
            await docRepo.delete(entity.documentId, ctx.userId);
          }
        }
      }

      await entityRepo.delete(input.id, ctx.userId, { deleteDocument: userPref });

      // Audit + side-effects
      auditLog({
        subjectType: "entity",
        action: "delete",
        phase: "completed",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
      });

      emitSideEffects({
        subjectType: "entity",
        action: "delete",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
      });

      return { status: "deleted", message: "Entity deleted" };
    }),
});
