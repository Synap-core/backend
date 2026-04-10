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
  inArray,
  getDb,
  ProfileResolutionService,
  EventRepository,
  EntityRepository,
  DocumentRepository,
  drizzleSql,
} from "@synap/database";
import { entities, documents, views, workspaces } from "@synap/database/schema";
import { type Entity, EntitySchema } from "@synap-core/types";
import { TRPCError } from "@trpc/server";
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import { auditLog } from "../utils/audit-log.js";
import { emitSideEffects } from "@synap/jobs";
import { randomUUID } from "crypto";
import { syncPropertyToRelations } from "../utils/property-relation-sync.js";
import { paginatedInput, buildPaginatedResponse } from "../utils/pagination.js";

/** Standard entity shape for API responses */
function toApiEntity(entity: any): Entity {
  return {
    ...entity,
    properties: entity.properties || {},
    systemData: entity.systemData || {},
    fileUrl: null,
    filePath: null,
    fileSize: null,
    fileType: null,
    checksum: null,
  } as Entity;
}

// ── Built-in per-profile bento templates ──────────────────────────────────
// Provide richer defaults than the generic 3-widget layout for common profiles.
// Workspace settings (profileEntityBentoTemplates) override these.
const DEFAULT_ENTITY_BENTO_TEMPLATES: Record<
  string,
  Array<Record<string, unknown>>
> = {
  event: [
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
    {
      id: "linked-notes",
      kind: "widget",
      widgetType: "entity-links",
      pos: { x: 4, y: 2, w: 4, h: 6 },
      config: { profileSlug: "note", title: "Notes" },
    },
    {
      id: "linked-tasks",
      kind: "widget",
      widgetType: "entity-links",
      pos: { x: 8, y: 2, w: 4, h: 6 },
      config: { profileSlug: "task", title: "Tasks" },
    },
    {
      id: "linked-docs",
      kind: "widget",
      widgetType: "entity-links",
      pos: { x: 0, y: 8, w: 6, h: 4 },
      config: { profileSlug: "file", title: "Documents" },
    },
    {
      id: "all-links",
      kind: "widget",
      widgetType: "entity-links",
      pos: { x: 6, y: 8, w: 6, h: 4 },
    },
  ],
  project: [
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
    {
      id: "linked-tasks",
      kind: "widget",
      widgetType: "entity-links",
      pos: { x: 4, y: 2, w: 8, h: 6 },
      config: { profileSlug: "task", title: "Tasks" },
    },
    {
      id: "linked-notes",
      kind: "widget",
      widgetType: "entity-links",
      pos: { x: 0, y: 8, w: 6, h: 4 },
      config: { profileSlug: "note", title: "Notes" },
    },
    {
      id: "linked-docs",
      kind: "widget",
      widgetType: "entity-links",
      pos: { x: 6, y: 8, w: 6, h: 4 },
      config: { profileSlug: "file", title: "Documents" },
    },
  ],
};

export const entitiesRouter = router({
  /**
   * Count entities grouped by profile slug.
   *
   * Returns a map of { [profileSlug]: count } for the active workspace
   * (including global entities). Useful for data-structure visualisation badges.
   */
  countByProfile: workspaceProcedure
    .output(
      z.object({
        counts: z.record(z.string(), z.number()),
      })
    )
    .query(async ({ ctx }) => {
      const rows = await db
        .select({
          profileSlug: entities.type,
          count: drizzleSql<number>`cast(count(*) as integer)`,
        })
        .from(entities)
        .where(
          and(
            eq(entities.userId, ctx.userId),
            or(
              eq(entities.workspaceId, ctx.workspaceId),
              isNull(entities.workspaceId)
            ),
            isNull(entities.deletedAt)
          )
        )
        .groupBy(entities.type);

      const counts: Record<string, number> = {};
      for (const row of rows) {
        if (row.profileSlug) {
          counts[row.profileSlug] = row.count;
        }
      }
      return { counts };
    }),

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
        /** Override the target workspace for this entity (defaults to current workspace). */
        targetWorkspaceId: z.string().uuid().optional(),
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
        sourceMessageId: ctx.sourceMessageId ?? undefined,
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
          entity: null as Record<string, unknown> | null,
          proposalId: perm.proposalId,
        };
      }

      // 3. Materialize — inline DB write (auto-approved)
      const database = await getDb();
      const eventRepo = new EventRepository(sql);
      const entityRepo = new EntityRepository(database, eventRepo);
      const docRepo = new DocumentRepository(database, eventRepo);

      // Resolve profile for defaultValues and entityScope
      let resolvedProfile: any = earlyResolvedProfile;
      if (!resolvedProfile && input.profileSlug) {
        const resolutionService = new ProfileResolutionService(database);
        resolvedProfile = await resolutionService.resolveProfile(
          input.profileSlug,
          ctx.userId,
          ctx.workspaceId
        );
      }
      if (!resolvedProfile) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Profile not found: ${profileSlug}`,
        });
      }

      // Determine workspaceId: explicit global flag > profile entityScope > workspace-scoped
      const profileEntityScope = resolvedProfile.entityScope ?? "workspace";
      const entityWorkspaceId = input.global
        ? null
        : profileEntityScope === "pod"
          ? null
          : (input.targetWorkspaceId ?? ctx.workspaceId);

      // Merge profile.defaultValues into caller-supplied properties.
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
            workspaceId: entityWorkspaceId ?? undefined,
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
        try {
          createdEntity = await entityRepo.create(
            {
              workspaceId: entityWorkspaceId ?? undefined,
              userId: ctx.userId,
              title: input.title || undefined,
              preview: input.description || undefined,
              documentId: input.documentId || undefined,
              properties: effectiveProperties,
              profileSlug,
            },
            ctx.userId
          );
        } catch (createErr) {
          const msg =
            createErr instanceof Error ? createErr.message : String(createErr);
          console.error("[entities.create] Entity creation failed:", msg, {
            profileSlug,
            title: input.title,
            workspaceId: entityWorkspaceId,
          });
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `Entity creation failed: ${msg}`,
          });
        }
      }

      // 3b. Auto-sync entity_id properties → relations (non-blocking)
      if (
        createdEntity.profileId &&
        effectiveProperties &&
        Object.keys(effectiveProperties).length > 0
      ) {
        syncPropertyToRelations(
          createdEntity.id,
          createdEntity.profileId,
          ctx.workspaceId,
          ctx.userId,
          {}, // old properties = empty (new entity)
          effectiveProperties as Record<string, unknown>
        ).catch((err) => {
          console.warn("[entities.create] Property→relation sync failed:", err);
        });
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

      // Dispatch AI classification for raw captures (non-blocking)
      // Upgrades profileSlug from "capture" → typed profile (note, bookmark, task…)
      if (profileSlug === "capture") {
        try {
          const { getBoss } = await import("@synap/jobs");
          await getBoss().send("ai-analysis", {
            entityId: createdEntity.id,
            workspaceId: ctx.workspaceId,
            userId: ctx.userId,
          });
        } catch (err) {
          console.warn(
            "[entities.create] Failed to queue AI analysis job:",
            err
          );
        }
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
      paginatedInput.extend({
        profileSlug: z.string().optional(),
        /** When true and profileSlug is set, also return entities of child profiles.
         *  e.g. profileSlug='person' + includeDescendants=true → returns person + contact + any custom children. */
        includeDescendants: z.boolean().optional().default(false),
        /** When true, only return global entities */
        globalOnly: z.boolean().optional().default(false),
      })
    )
    .query(async ({ input, ctx }) => {
      const userCondition = eq(entities.userId, ctx.userId);

      const conditions: any[] = [userCondition, isNull(entities.deletedAt)];

      if (input.profileSlug) {
        // Resolve profile slugs to query (optionally including child profiles)
        const database = await getDb();
        const profileService = new ProfileResolutionService(database);

        let profileSlugs = [input.profileSlug];
        if (input.includeDescendants) {
          const descendants = await profileService.getDescendantSlugs(
            input.profileSlug,
            ctx.workspaceId
          );
          profileSlugs = [input.profileSlug, ...descendants];
        }

        // Use inArray for multiple slugs, eq for single (simpler query plan)
        if (profileSlugs.length === 1) {
          conditions.push(eq(entities.type, profileSlugs[0]));
        } else {
          conditions.push(inArray(entities.type, profileSlugs));
        }

        // Check if this profile type is pod-wide — if so, skip workspace filter
        const entityScope = await profileService.getEntityScope(
          input.profileSlug,
          ctx.workspaceId
        );

        if (entityScope === "pod") {
          // Pod-wide: show all entities of this type regardless of workspace
          // (userCondition already ensures ownership — no workspaceId filter needed)
        } else {
          // Workspace-scoped: this workspace + global entities
          conditions.push(
            input.globalOnly
              ? isNull(entities.workspaceId)
              : or(
                  eq(entities.workspaceId, ctx.workspaceId),
                  isNull(entities.workspaceId)
                )
          );
        }
      } else {
        // No profile filter — use standard workspace scoping
        conditions.push(
          input.globalOnly
            ? isNull(entities.workspaceId)
            : or(
                eq(entities.workspaceId, ctx.workspaceId),
                isNull(entities.workspaceId)
              )
        );
      }

      const results = await db.query.entities.findMany({
        where: and(...conditions),
        orderBy: [desc(entities.createdAt)],
        limit: input.limit + 1,
        offset: input.offset,
      });

      const { items, pagination } = buildPaginatedResponse(
        results.map(toApiEntity),
        input
      );

      return {
        items,
        pagination,
        /** @deprecated Use `items` instead */
        entities: items,
        /** @deprecated Use `pagination.hasMore` instead */
        hasMore: pagination.hasMore,
      };
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
      const conditions: any[] = [eq(entities.userId, ctx.userId)];

      if (input.profileSlug) {
        conditions.push(eq(entities.type, input.profileSlug));

        // Check if this profile type is pod-wide — if so, skip workspace filter
        const database = await getDb();
        const profileService = new ProfileResolutionService(database);
        const entityScope = await profileService.getEntityScope(
          input.profileSlug,
          ctx.workspaceId
        );

        if (entityScope !== "pod") {
          conditions.push(
            or(
              eq(entities.workspaceId, ctx.workspaceId),
              isNull(entities.workspaceId)
            )
          );
        }
      } else {
        conditions.push(
          or(
            eq(entities.workspaceId, ctx.workspaceId),
            isNull(entities.workspaceId)
          )
        );
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
        await resolutionService.getEffectiveProperties(
          profile.id,
          ctx.workspaceId
        );

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
        /** Change entity's profile type by slug (e.g. 'person' → 'contact') */
        profileSlug: z.string().optional(),
        source: z
          .enum(["user", "ai", "intelligence", "system", "agent"])
          .optional(),
        reasoning: z.string().optional(),
        agentUserId: z.string().uuid().optional(),
        /** When true, removes workspace scoping — entity becomes pod-wide (visible in all workspaces). */
        global: z.boolean().optional(),
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
          profileSlug: input.profileSlug,
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
          profileSlug: input.profileSlug,
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

      // Snapshot old properties for relation sync (before update)
      let oldEntity:
        | { profileId: string | null; properties: unknown }
        | undefined;
      if (input.properties) {
        oldEntity = await database.query.entities.findFirst({
          where: eq(entities.id, input.id),
          columns: { profileId: true, properties: true },
        });
      }

      await entityRepo.update(
        input.id,
        {
          title: input.title || undefined,
          preview: input.description || undefined,
          documentId: input.documentId,
          properties: input.properties || undefined,
          profileSlug: input.profileSlug || undefined,
          // Thread the workspace lens so overlay props validate/index correctly
          workspaceId: ctx.workspaceId,
        },
        ctx.userId
      );

      // 3b. If global flag is set, remove workspace scoping (pod-wide visibility)
      if (input.global === true) {
        await database
          .update(entities)
          .set({ workspaceId: null })
          .where(eq(entities.id, input.id));
      }

      // 3c. Auto-sync entity_id properties → relations (non-blocking)
      if (input.properties && oldEntity?.profileId) {
        const oldProps =
          (oldEntity.properties as Record<string, unknown>) ?? {};
        const newProps = { ...oldProps, ...input.properties };
        syncPropertyToRelations(
          input.id,
          oldEntity.profileId,
          ctx.workspaceId,
          ctx.userId,
          oldProps,
          newProps
        ).catch((err) => {
          console.warn("[entities.update] Property→relation sync failed:", err);
        });
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
            } catch {
              // Storage deletion is best-effort — entity delete proceeds regardless
            }
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
   * 3-level bento hierarchy for the initial layout:
   *   1. workspace.settings.profileEntityBentoTemplates[profileSlug]  — template-defined default
   *   2. Generic fallback (header + properties + content)
   *
   * State is stored in entity.systemData (not entity.properties) to avoid polluting
   * user-defined fields and bypassing property validation.
   * Any workspace member can set view mode (not just the entity creator).
   *
   * Built-in bento templates for common profiles provide richer defaults than
   * the generic 3-widget layout. Workspace settings can override these.
   */

  // ── Built-in per-profile bento templates ──────────────────────────────────
  // keyed by profileSlug → array of bento blocks
  // These provide sensible defaults when no workspace-level template exists.

  setEntityViewMode: workspaceProcedure
    .input(
      z.object({
        entityId: z.string().uuid(),
        mode: z.enum(["document", "bento"]),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Fetch entity — allow any workspace member (not just creator)
      const entity = await db.query.entities.findFirst({
        where: and(
          eq(entities.id, input.entityId),
          or(
            eq(entities.workspaceId, ctx.workspaceId!),
            isNull(entities.workspaceId)
          )
        ),
      });

      if (!entity) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Entity not found" });
      }

      const currentSystemData =
        (entity.systemData as Record<string, unknown>) || {};
      let bentoViewId = currentSystemData.bentoViewId as string | undefined;

      // Create bento view on first switch to bento mode
      if (input.mode === "bento" && !bentoViewId) {
        // Look up workspace settings for a profile-specific bento template
        const workspace = await db.query.workspaces.findFirst({
          where: eq(workspaces.id, ctx.workspaceId as string),
        });

        const profileSlug = entity.type; // entity.type === profile slug
        const workspaceSettings =
          (workspace?.settings as Record<string, unknown>) ?? {};
        const profileTemplates =
          workspaceSettings.profileEntityBentoTemplates as
            | Record<string, { blocks: unknown[] }>
            | undefined;

        // Level 1: profile-specific template from workspace settings
        // Level 2: built-in profile templates for common entity types
        // Level 3: generic 3-widget fallback
        const blocks = profileTemplates?.[profileSlug]?.blocks ??
          DEFAULT_ENTITY_BENTO_TEMPLATES[profileSlug] ?? [
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
            {
              id: "entity-content",
              kind: "widget",
              widgetType: "entity-links",
              pos: { x: 4, y: 2, w: 8, h: 6 },
            },
          ];

        const newViewId = randomUUID();
        await db.insert(views).values({
          id: newViewId,
          workspaceId: ctx.workspaceId || null,
          userId: ctx.userId,
          type: "bento",
          category: "composite",
          name: `${entity.title || "Entity"} Dashboard`,
          config: { layout: "bento", blocks },
          metadata: {
            entityId: input.entityId,
            source: "entity-bento",
            profileSlug,
          },
        });
        bentoViewId = newViewId;
      }

      // Write to systemData column (not properties) — clean separation from user fields
      const updatedSystemData: Record<string, unknown> = {
        ...currentSystemData,
        viewMode: input.mode,
        ...(bentoViewId ? { bentoViewId } : {}),
      };

      await db
        .update(entities)
        .set({ systemData: updatedSystemData, updatedAt: new Date() })
        .where(eq(entities.id, input.entityId));

      return {
        status: "ok",
        viewMode: input.mode,
        bentoViewId: bentoViewId ?? null,
      };
    }),
});
