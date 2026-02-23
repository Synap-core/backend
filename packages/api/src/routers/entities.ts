/**
 * Entities Router - Profile-Based Entity Management
 *
 * Event-driven CRUD with audit trail:
 *   .requested → permission check → inline materialization → .completed
 * Proposal path (AI requiring review) defers to the materializer worker.
 *
 * Supports global entities (workspaceId = null) visible across all workspaces.
 */

import { z } from "zod";
import { router, workspaceProcedure, protectedProcedure } from "../trpc.js";
import {
  db,
  eq,
  desc,
  and,
  or,
  isNull,
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
import { randomUUID } from "crypto";

/** Standard entity shape for API responses */
function toApiEntity(entity: any): Entity {
  return {
    ...entity,
    properties: entity.properties || {},
    fileUrl: null,
    filePath: null,
    fileSize: null,
    fileType: null,
    checksum: null,
  } as Entity;
}

export const entitiesRouter = router({
  /**
   * Create entity with profile-based type system
   *
   * When `global: true`, the entity is created without a workspaceId
   * and will be visible across all workspaces.
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
        /** When true, entity has no workspace — visible everywhere */
        global: z.boolean().optional().default(false),
        /** Source of action for AI governance (e.g. "ai", "intelligence") */
        source: z.enum(["user", "ai", "intelligence", "system"]).optional(),
        /** AI reasoning for proposals */
        reasoning: z.string().optional(),
        /** Agent user ID when action is performed by an AI agent */
        agentUserId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const entityId = randomUUID();
      const correlationId = randomUUID();

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

      // 1. Emit .requested event — records intent regardless of outcome
      auditLog({
        subjectType: "entity",
        action: "create",
        phase: "requested",
        subjectId: entityId,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        correlationId,
        data: {
          profileSlug,
          title: input.title,
          description: input.description,
          properties: input.properties,
          documentId: input.documentId,
          content: input.content ? "[content]" : undefined,
          global: input.global,
        },
      });

      // 2. Permission check (may create proposal with correlationId)
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: ctx.workspaceId,
        subjectType: "entity",
        action: "create",
        source: input.source,
        reasoning: input.reasoning,
        correlationId,
        data: {
          id: entityId,
          profileSlug,
          title: input.title,
          description: input.description,
          properties: input.properties,
          documentId: input.documentId,
          content: input.content,
          global: input.global,
        },
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

      // 3. Materialize — inline DB write (auto-approved)
      const entityWorkspaceId = input.global ? null : ctx.workspaceId;

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
            workspaceId: entityWorkspaceId!,
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
            workspaceId: entityWorkspaceId!,
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

      // 4. Emit .completed event + side-effects
      auditLog({
        subjectType: "entity",
        action: "create",
        phase: "completed",
        subjectId: createdEntity.id,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        correlationId,
        data: { profileSlug, title: input.title, global: input.global },
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
        entity: toApiEntity(createdEntity),
      };
    }),

  /**
   * List entities (workspace-scoped + global)
   *
   * Returns entities belonging to the active workspace AND global entities (workspaceId IS NULL).
   */
  list: workspaceProcedure
    .input(
      z.object({
        profileSlug: z.string().optional(),
        limit: z.number().min(1).max(100).default(50),
        /** When true, only return global entities */
        globalOnly: z.boolean().optional().default(false),
      })
    )
    .output(
      z.object({
        entities: z.array(EntitySchema),
      })
    )
    .query(async ({ input, ctx }) => {
      const userCondition = eq(entities.userId, ctx.userId);

      // Workspace filter: workspace-specific + global, or global-only
      const workspaceCondition = input.globalOnly
        ? isNull(entities.workspaceId)
        : or(
            eq(entities.workspaceId, ctx.workspaceId),
            isNull(entities.workspaceId)
          );

      const conditions: any[] = [userCondition, workspaceCondition];

      if (input.profileSlug) {
        conditions.push(eq(entities.type, input.profileSlug));
      }

      const results = await db.query.entities.findMany({
        where: and(...conditions),
        orderBy: [desc(entities.createdAt)],
        limit: input.limit,
      });

      return { entities: results.map(toApiEntity) };
    }),

  /**
   * List global entities (no workspace required)
   *
   * Returns only entities where workspaceId IS NULL.
   * Uses protectedProcedure — works even without an active workspace.
   */
  listGlobal: protectedProcedure
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
        eq(entities.userId, ctx.userId),
        isNull(entities.workspaceId),
      ];

      if (input.profileSlug) {
        conditions.push(eq(entities.type, input.profileSlug));
      }

      const results = await db.query.entities.findMany({
        where: and(...conditions),
        orderBy: [desc(entities.createdAt)],
        limit: input.limit,
      });

      return { entities: results.map(toApiEntity) };
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
        eq(entities.userId, ctx.userId),
        or(
          eq(entities.workspaceId, ctx.workspaceId),
          isNull(entities.workspaceId)
        ),
      ];

      if (input.profileSlug) {
        conditions.push(eq(entities.type, input.profileSlug));
      }

      const results = await db.query.entities.findMany({
        where: and(...conditions),
        orderBy: [desc(entities.createdAt)],
        limit: input.limit,
      });

      return { entities: results.map(toApiEntity) };
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
          eq(entities.userId, ctx.userId),
          or(
            eq(entities.workspaceId, ctx.workspaceId),
            isNull(entities.workspaceId)
          )
        ),
      });

      if (!entity) return { entity: null };

      return { entity: toApiEntity(entity) };
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
          eq(entities.userId, ctx.userId),
          or(
            eq(entities.workspaceId, ctx.workspaceId),
            isNull(entities.workspaceId)
          )
        ),
      });

      if (!entity) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Entity not found" });
      }

      const typedEntity = toApiEntity(entity);

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
        source: z.enum(["user", "ai", "intelligence", "system"]).optional(),
        reasoning: z.string().optional(),
        agentUserId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const correlationId = randomUUID();

      // 1. Emit .requested event
      auditLog({
        subjectType: "entity",
        action: "update",
        phase: "requested",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        correlationId,
        data: {
          title: input.title,
          description: input.description,
          properties: input.properties,
          documentId: input.documentId,
        },
      });

      // 2. Permission check
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: ctx.workspaceId,
        subjectType: "entity",
        action: "update",
        source: input.source,
        reasoning: input.reasoning,
        correlationId,
        data: {
          id: input.id,
          title: input.title,
          description: input.description,
          properties: input.properties,
          documentId: input.documentId,
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          status: "proposed",
          message: "Update proposed for review",
          proposalId: perm.proposalId,
        };
      }

      // 3. Materialize — inline DB write (auto-approved)
      const database = await getDb();
      const eventRepo = new EventRepository(sql);
      const entityRepo = new EntityRepository(database, eventRepo);
      const docRepo = new DocumentRepository(database, eventRepo);

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
          await docRepo.update(
            newDocumentId,
            { entityId: input.id },
            ctx.userId
          );
        }
      }

      // 4. Emit .completed event + side-effects
      auditLog({
        subjectType: "entity",
        action: "update",
        phase: "completed",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        correlationId,
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
    .input(
      z.object({
        id: z.string().uuid(),
        source: z.enum(["user", "ai", "intelligence", "system"]).optional(),
        reasoning: z.string().optional(),
        agentUserId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const correlationId = randomUUID();

      // 1. Emit .requested event
      auditLog({
        subjectType: "entity",
        action: "delete",
        phase: "requested",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        correlationId,
        data: { id: input.id },
      });

      // 2. Permission check
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: ctx.workspaceId,
        subjectType: "entity",
        action: "delete",
        source: input.source,
        reasoning: input.reasoning,
        correlationId,
        data: { id: input.id },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          status: "proposed",
          message: "Deletion proposed for review",
          proposalId: perm.proposalId,
        };
      }

      // 3. Materialize — inline DB write (auto-approved)
      const database = await getDb();
      const eventRepo = new EventRepository(sql);
      const entityRepo = new EntityRepository(database, eventRepo);
      const docRepo = new DocumentRepository(database, eventRepo);

      const { getUserPreference } = await import("@synap/database");
      const userPref = await getUserPreference(
        ctx.userId,
        "entity.deleteDocument"
      );

      if (userPref) {
        const entity = await db.query.entities.findFirst({
          where: and(
            eq(entities.id, input.id),
            eq(entities.userId, ctx.userId)
          ),
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
              if (document.storageKey)
                await storage.delete(document.storageKey);
            } catch {}
            await docRepo.delete(entity.documentId, ctx.userId);
          }
        }
      }

      await entityRepo.delete(input.id, ctx.userId, {
        deleteDocument: userPref,
      });

      // 4. Emit .completed event + side-effects
      auditLog({
        subjectType: "entity",
        action: "delete",
        phase: "completed",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        correlationId,
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
