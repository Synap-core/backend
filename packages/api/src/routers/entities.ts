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
  sql,
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
  drizzleSql,
} from "@synap/database";
import { entities, documents, views } from "@synap/database/schema";
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
        source: z
          .enum(["user", "ai", "intelligence", "system", "agent"])
          .optional(),
        /** AI reasoning for proposals */
        reasoning: z.string().optional(),
        /** Agent user ID when action is performed by an AI agent */
        agentUserId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const entityId = randomUUID();
      const correlationId = randomUUID();

      // Resolve profile — capture full profile object so defaultValues are available at step 3
      let profileSlug: string | undefined;
      let earlyResolvedProfile: any = null;
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
        earlyResolvedProfile = profile; // carry forward — avoids second DB call below
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
        sourceMessageId: (ctx as any).sourceMessageId ?? undefined,
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

      // Merge profile.defaultValues into caller-supplied properties.
      // Profile defaults are applied first; caller values take precedence.
      // For profileSlug path: resolve now. For profileId path: already resolved above.
      let resolvedProfile: any = earlyResolvedProfile;
      if (!resolvedProfile && input.profileSlug) {
        const resolutionService = new ProfileResolutionService(database);
        resolvedProfile = await resolutionService.resolveProfile(
          input.profileSlug,
          ctx.userId,
          ctx.workspaceId
        );
      }
      const profileDefaults =
        (resolvedProfile?.defaultValues as Record<string, unknown>) ?? {};
      const effectiveProperties: Record<string, unknown> = {
        ...profileDefaults,
        ...(input.properties ?? {}),
      };

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
            properties: effectiveProperties,
            profileSlug,
          },
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
            properties: effectiveProperties,
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

      // Dispatch entity embedding job (non-blocking — failure never blocks creation)
      try {
        const { getBoss } = await import("@synap/jobs");
        await getBoss().send("entity-embedding", {
          entityId: createdEntity.id,
          title: createdEntity.title || input.title,
          preview: createdEntity.preview || input.description,
          userId: ctx.userId,
          action: "create",
        });
      } catch (err) {
        console.warn("[entities.create] Failed to queue embedding job:", err);
      }

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
   * List entities across multiple workspaces the user has access to.
   *
   * Unlike `list` (which is workspace-scoped via header), this endpoint
   * accepts an explicit `workspaceIds` array and is callable without an
   * active workspace header. Useful for cross-workspace dashboards and
   * global search aggregation.
   *
   * Security: `workspaceIds` is silently filtered to workspaces the caller
   * is actually a member of — unknown or inaccessible IDs are ignored.
   * Omitting `workspaceIds` returns entities from ALL user's workspaces.
   */
  listMulti: protectedProcedure
    .input(
      z.object({
        workspaceIds: z.array(z.string().uuid()).optional(),
        profileSlug: z.string().optional(),
        includeGlobal: z.boolean().default(false),
        limit: z.number().min(1).max(200).default(50),
      })
    )
    .output(
      z.object({
        entities: z.array(EntitySchema),
      })
    )
    .query(async ({ input, ctx }) => {
      const { validateWorkspaceAccess } =
        await import("../utils/workspace-membership.js");

      const validatedIds = await validateWorkspaceAccess(
        ctx.userId,
        input.workspaceIds
      );

      const db2 = await getDb();
      const eventRepo = new EventRepository(sql);
      const entityRepo = new EntityRepository(db2, eventRepo);

      const results = await entityRepo.listForWorkspaces(
        validatedIds,
        ctx.userId,
        {
          profileSlug: input.profileSlug,
          limit: input.limit,
          includeGlobal: input.includeGlobal,
        }
      );

      return { entities: results.map(toApiEntity) };
    }),

  /**
   * List all entities in this workspace that have a URL property.
   * Used by the browser's URL index to know which pages have been saved,
   * powering the bookmark ⭐ state and duplicate detection.
   * Returns a slim payload — no full property values, just what the index needs.
   */
  listSavedUrls: workspaceProcedure
    .output(
      z.array(
        z.object({
          id: z.string(),
          url: z.string(),
          title: z.string(),
          profileSlug: z.string(),
          createdAt: z.string(),
        })
      )
    )
    .query(async ({ ctx }) => {
      const rows = await db
        .select({
          id: entities.id,
          title: entities.title,
          type: entities.type,
          createdAt: entities.createdAt,
          url: drizzleSql<string>`${entities.properties}->>'url'`,
        })
        .from(entities)
        .where(
          and(
            eq(entities.userId, ctx.userId),
            or(
              eq(entities.workspaceId, ctx.workspaceId),
              isNull(entities.workspaceId)
            ),
            drizzleSql`${entities.properties}->>'url' IS NOT NULL`,
            drizzleSql`${entities.properties}->>'url' != ''`
          )
        )
        .orderBy(desc(entities.createdAt));

      return rows.map((r) => ({
        id: r.id,
        url: r.url,
        title: r.title ?? r.url,
        profileSlug: r.type ?? "bookmark",
        createdAt: r.createdAt?.toISOString() ?? new Date().toISOString(),
      }));
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
        source: z
          .enum(["user", "ai", "intelligence", "system", "agent"])
          .optional(),
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

      // Dispatch entity embedding job (non-blocking — only if searchable fields changed)
      if (input.title !== undefined || input.description !== undefined) {
        try {
          const { getBoss } = await import("@synap/jobs");
          await getBoss().send("entity-embedding", {
            entityId: input.id,
            title: input.title,
            preview: input.description,
            userId: ctx.userId,
            action: "update",
          });
        } catch (err) {
          console.warn("[entities.update] Failed to queue embedding job:", err);
        }
      }

      return { status: "updated", message: "Entity updated" };
    }),

  /**
   * Delete entity (soft delete)
   */
  delete: workspaceProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        source: z
          .enum(["user", "ai", "intelligence", "system", "agent"])
          .optional(),
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

  /**
   * Set entity view mode: "document" (default) or "bento" (dashboard).
   *
   * When switching to bento for the first time, automatically creates a
   * dedicated bento view and stores its ID in entity properties (__bentoViewId).
   * System keys use __ prefix to distinguish from user-defined properties.
   */
  setEntityViewMode: workspaceProcedure
    .input(
      z.object({
        entityId: z.string().uuid(),
        mode: z.enum(["document", "bento"]),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const database = await getDb();
      const eventRepo = new EventRepository(sql);
      const entityRepo = new EntityRepository(database, eventRepo);

      // Fetch current entity
      const entity = await db.query.entities.findFirst({
        where: and(
          eq(entities.id, input.entityId),
          eq(entities.userId, ctx.userId)
        ),
      });

      if (!entity) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Entity not found" });
      }

      const currentProperties =
        (entity.properties as Record<string, unknown>) || {};
      let bentoViewId = currentProperties.__bentoViewId as string | undefined;

      // Create bento view on first switch to bento mode
      if (input.mode === "bento" && !bentoViewId) {
        const DEFAULT_ENTITY_BENTO_CONFIG = {
          layout: "bento",
          blocks: [
            {
              id: "entity-header",
              kind: "widget",
              widgetType: "entity-header",
              pos: { x: 0, y: 0, w: 12, h: 2 },
            },
            {
              id: "entity-props",
              kind: "widget",
              widgetType: "entity-properties",
              pos: { x: 0, y: 2, w: 4, h: 6 },
            },
          ],
        };

        const newViewId = randomUUID();
        await db.insert(views).values({
          id: newViewId,
          workspaceId: ctx.workspaceId || null,
          userId: ctx.userId,
          type: "bento",
          category: "composite",
          name: `${entity.title || "Entity"} Dashboard`,
          config: DEFAULT_ENTITY_BENTO_CONFIG,
          metadata: { entityId: input.entityId, source: "entity-bento" },
        });
        bentoViewId = newViewId;
      }

      // Merge system keys into existing properties
      const updatedProperties: Record<string, unknown> = {
        ...currentProperties,
        __viewMode: input.mode,
        ...(bentoViewId ? { __bentoViewId: bentoViewId } : {}),
      };

      await entityRepo.update(
        input.entityId,
        { properties: updatedProperties },
        ctx.userId
      );

      return {
        status: "ok",
        viewMode: input.mode,
        bentoViewId: bentoViewId ?? null,
      };
    }),
});
