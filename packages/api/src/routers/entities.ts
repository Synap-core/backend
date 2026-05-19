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
import {
  router,
  workspaceProcedure,
  protectedProcedure,
  podProcedure,
  podAdminProcedure,
} from "../trpc.js";
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
import {
  entities,
  documents,
  views,
  workspaces,
  entityExternalLinks,
} from "@synap/database/schema";
import { type Entity, EntitySchema } from "@synap-core/types";
import { entityToWire } from "./hub-protocol/rest/_codecs/entity.js";
import { TRPCError } from "@trpc/server";
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import { auditLog } from "../utils/audit-log.js";
import { emitSideEffects, getBoss } from "@synap/events";
import { randomUUID } from "crypto";
import { syncPropertyToRelations } from "../utils/property-relation-sync.js";
import { paginatedInput, buildPaginatedResponse } from "../utils/pagination.js";
import { dispatchWebhooksForEvent } from "../utils/webhook-delivery.js";
import { userVisibleWhere } from "../utils/user-visible-where.js";

/**
 * Standard entity shape for API responses.
 *
 * Uses `entityToWire` (the single canonical entity codec used by Hub Protocol REST)
 * to normalize properties / systemData / profileSlug, then layers on the file fields
 * the existing tRPC consumers expect. Keeping the wrapper preserves the long-standing
 * `Entity` shape (`type` field instead of `profileSlug`) plus the explicit null
 * file fields, while routing the source-of-truth normalization through the codec.
 */
function toApiEntity(entity: any): Entity {
  // Defer to the canonical codec for shape normalization. We then spread the
  // original DB row over the result so any tRPC-only fields (profileId, version,
  // deletedAt, etc.) that don't exist on the wire shape are preserved verbatim
  // for the Entity Zod schema.
  const wire = entityToWire(entity);
  return {
    ...entity,
    profileSlug: wire.profileSlug,
    type: wire.type,
    properties: wire.properties,
    systemData: wire.systemData ?? {},
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
  create: podProcedure
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
        /**
         * Source of action for AI governance + downstream audit/event tagging.
         * Hub Protocol callers may pass connector-specific values (e.g.
         * "openwebui-pipeline", "openclaw", "extension") so the proposal layer
         * carries accurate provenance. Permission gating is unchanged: the
         * legacy AI gate only branches on "ai"/"intelligence"; everything else
         * falls through to the agentUserId / role-based path.
         */
        source: z
          .enum([
            "user",
            "ai",
            "intelligence",
            "system",
            "agent",
            "openwebui-pipeline",
            "openclaw",
            "extension",
            "cli",
            "n8n",
            "raycast",
          ])
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
      const requestedEvent = await auditLog({
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
        requestedEventId: requestedEvent?.id,
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
      await auditLog({
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
  list: podProcedure
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
      // Visibility is gated by workspace membership (workspaceProcedure).
      // userId is attribution only — all workspace members see all workspace entities.
      const conditions: any[] = [isNull(entities.deletedAt)];

      if (input.profileSlug) {
        // Resolve profile slugs to query (optionally including child profiles)
        const database = await getDb();
        const profileService = new ProfileResolutionService(database);

        let profileSlugs = [input.profileSlug];
        if (input.includeDescendants) {
          const descendants = await profileService.getDescendantSlugs(
            input.profileSlug,
            ctx.workspaceId ?? undefined
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
          // Pod-wide: no workspace filter — visible to all workspace members.
        } else {
          // Workspace-scoped: this workspace + global entities.
          // Workspace-less callers (hydration) see pod-wide only.
          conditions.push(
            input.globalOnly || !ctx.workspaceId
              ? isNull(entities.workspaceId)
              : or(
                  eq(entities.workspaceId, ctx.workspaceId),
                  isNull(entities.workspaceId)
                )
          );
        }
      } else {
        // No profile filter — use standard workspace scoping.
        // Workspace-less callers (hydration) see pod-wide only.
        conditions.push(
          input.globalOnly || !ctx.workspaceId
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
   * List entities visible to the user across EVERY workspace they belong to,
   * plus pod-wide globals. The user-wide sibling of `list`.
   *
   * Used by surfaces above the workspace level — Eve OS, cross-workspace
   * search, dashboards, AI agents that span contexts. The principle is in
   * synap-app's CLAUDE.md: "Workspaces are lenses, not scopes. Filter by
   * USER, never by workspace, for all flows crossing pod↔outside boundary."
   *
   * Same input + output shape as `list` so consumers can swap variants
   * without restructuring the call site. No `globalOnly` flag — that's a
   * `.list`-only optimisation for one workspace at a time.
   */
  listAll: podProcedure
    .input(
      paginatedInput.extend({
        profileSlug: z.string().optional(),
        /** When true and profileSlug is set, also return entities of child profiles. */
        includeDescendants: z.boolean().optional().default(false),
      })
    )
    .query(async ({ input, ctx }) => {
      const conditions: any[] = [
        isNull(entities.deletedAt),
        userVisibleWhere(entities.workspaceId, ctx.userId),
      ];

      if (input.profileSlug) {
        const database = await getDb();
        const profileService = new ProfileResolutionService(database);
        let profileSlugs = [input.profileSlug];
        if (input.includeDescendants) {
          const descendants = await profileService.getDescendantSlugs(
            input.profileSlug,
            ctx.workspaceId ?? undefined
          );
          profileSlugs = [input.profileSlug, ...descendants];
        }
        if (profileSlugs.length === 1) {
          conditions.push(eq(entities.type, profileSlugs[0]));
        } else {
          conditions.push(inArray(entities.type, profileSlugs));
        }
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
  get: podProcedure
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
        /** Tracks where this entity was imported from (empty for user-created entities). */
        externalLinks: z
          .array(
            z.object({
              provider: z.string(),
              externalId: z.string(),
              createdAt: z.string(),
            })
          )
          .optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const entity = await db.query.entities.findFirst({
        where: and(
          eq(entities.id, input.id),
          eq(entities.userId, ctx.userId),
          ctx.workspaceId
            ? or(
                eq(entities.workspaceId, ctx.workspaceId),
                isNull(entities.workspaceId)
              )
            : isNull(entities.workspaceId)
        ),
      });

      if (!entity) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Entity not found" });
      }

      const typedEntity = toApiEntity(entity);

      // Provenance: always include externalLinks (possibly empty) to keep
      // client types predictable. Single-row entity ⇒ single cheap join.
      const linkRows = await db.query.entityExternalLinks.findMany({
        where: eq(entityExternalLinks.entityId, entity.id),
      });
      const externalLinks = linkRows.map((l) => ({
        provider: l.provider,
        externalId: l.externalId,
        createdAt:
          l.createdAt instanceof Date
            ? l.createdAt.toISOString()
            : new Date(l.createdAt as unknown as string).toISOString(),
      }));

      if (!input.includeProfile) {
        return { entity: typedEntity, externalLinks };
      }

      const database = await getDb();
      const resolutionService = new ProfileResolutionService(database);
      const profile = await resolutionService.resolveProfile(
        entity.type,
        ctx.userId,
        ctx.workspaceId
      );

      if (!profile) return { entity: typedEntity, externalLinks };

      const effectiveProperties =
        await resolutionService.getEffectiveProperties(
          profile.id,
          ctx.workspaceId
        );

      return {
        entity: typedEntity,
        profile,
        effectiveProperties,
        externalLinks,
      };
    }),

  /**
   * Update entity
   */
  update: podProcedure
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
      const requestedEvent = await auditLog({
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
        requestedEventId: requestedEvent?.id,
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
        | { profileId: string | null; properties: unknown; type: string | null }
        | undefined;
      if (input.properties) {
        oldEntity = await database.query.entities.findFirst({
          where: eq(entities.id, input.id),
          columns: { profileId: true, properties: true, type: true },
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
      await auditLog({
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

      // Dispatch webhooks for entity property updates (fire-and-forget, non-blocking)
      if (input.properties && oldEntity) {
        const oldProps =
          (oldEntity.properties as Record<string, unknown>) ?? {};
        const changedProperties: Record<string, unknown> = {};
        const mergedProps = { ...oldProps, ...input.properties };
        for (const key of new Set([
          ...Object.keys(oldProps),
          ...Object.keys(input.properties),
        ])) {
          if (
            JSON.stringify(oldProps[key]) !== JSON.stringify(mergedProps[key])
          ) {
            changedProperties[key] = mergedProps[key];
          }
        }
        if (Object.keys(changedProperties).length > 0) {
          dispatchWebhooksForEvent("entity.update.completed", {
            entityId: input.id,
            entityType: oldEntity.type,
            workspaceId: ctx.workspaceId,
            changedProperties,
          });
        }
      }

      // Dispatch entity embedding job (non-blocking — only if searchable fields changed)
      if (input.title !== undefined || input.description !== undefined) {
        try {
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
  delete: podProcedure
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
      const requestedEvent = await auditLog({
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
        requestedEventId: requestedEvent?.id,
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

  /**
   * Admin: list entities pod-wide or scoped to a workspace.
   *
   * - workspaceId === undefined → all entities pod-wide
   * - workspaceId === null      → only pod-wide entities (workspace_id IS NULL)
   * - workspaceId === string    → that workspace's entities
   */
  adminList: podAdminProcedure
    .input(
      z.object({
        workspaceId: z.union([z.string().uuid(), z.null()]).optional(),
        profileSlug: z.string().optional(),
        search: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      })
    )
    .query(async ({ input }) => {
      const conditions: any[] = [isNull(entities.deletedAt)];

      if (input.workspaceId === null) {
        conditions.push(isNull(entities.workspaceId));
      } else if (typeof input.workspaceId === "string") {
        conditions.push(eq(entities.workspaceId, input.workspaceId));
      }

      if (input.profileSlug) {
        conditions.push(eq(entities.type, input.profileSlug));
      }

      if (input.search && input.search.trim().length > 0) {
        const term = `%${input.search.trim()}%`;
        conditions.push(
          or(
            drizzleSql`${entities.title} ILIKE ${term}`,
            drizzleSql`${entities.preview} ILIKE ${term}`,
            drizzleSql`${entities.properties}::text ILIKE ${term}`
          )
        );
      }

      const totalRow = await db
        .select({ count: drizzleSql<number>`count(*)::int` })
        .from(entities)
        .where(and(...conditions));
      const total = totalRow[0]?.count ?? 0;

      const rows = await db.query.entities.findMany({
        where: and(...conditions),
        orderBy: [desc(entities.updatedAt)],
        limit: input.limit,
        offset: input.offset,
        columns: {
          id: true,
          title: true,
          preview: true,
          type: true,
          workspaceId: true,
          userId: true,
          createdAt: true,
          updatedAt: true,
          properties: true,
        },
      });

      // Resolve workspace names for the rows
      const wsIds = Array.from(
        new Set(
          rows.map((r) => r.workspaceId).filter((id): id is string => !!id)
        )
      );
      const wsRows =
        wsIds.length > 0
          ? await db.query.workspaces.findMany({
              where: inArray(workspaces.id, wsIds),
              columns: { id: true, name: true },
            })
          : [];
      const wsNameById = new Map(wsRows.map((w) => [w.id, w.name]));

      // Truncate properties to keep payload small
      const items = rows.map((r) => {
        const propsString = JSON.stringify(r.properties ?? {});
        const truncated =
          propsString.length > 240
            ? propsString.slice(0, 240) + "…"
            : propsString;
        return {
          id: r.id,
          title: r.title,
          preview: r.preview,
          profileSlug: r.type,
          workspaceId: r.workspaceId,
          workspaceName: r.workspaceId
            ? (wsNameById.get(r.workspaceId) ?? null)
            : null,
          userId: r.userId,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          propertiesPreview: truncated,
        };
      });

      return { items, total };
    }),

  /**
   * Batch create entities in a single call.
   *
   * Auto-creates missing profiles on the fly (workspace-scoped, with optional
   * displayName/icon/color). Each entity is identified by a caller-supplied
   * `refKey` (e.g. "app:web", "pkg:@synap-core/client") so relations can
   * reference them without knowing UUIDs ahead of time.
   *
   * Idempotent: entities with the same (profileSlug, title) in the same
   * workspace are returned as-is, not duplicated.
   */
  batchCreate: workspaceProcedure
    .input(
      z.object({
        entities: z.array(
          z.object({
            /** Stable caller-supplied reference key (e.g. "app:web", "pkg:@synap-core/client") */
            refKey: z.string().min(1),
            profileSlug: z.string().min(1),
            title: z.string().min(1),
            description: z.string().optional(),
            properties: z.record(z.string(), z.unknown()).optional(),
            content: z.string().optional(),
            source: z
              .enum(["user", "ai", "intelligence", "system", "agent", "cli"])
              .optional(),
            /** If the profile doesn't exist, create it with these hints */
            profileHints: z
              .object({
                displayName: z.string().optional(),
                icon: z.string().optional(),
                color: z.string().optional(),
                description: z.string().optional(),
              })
              .optional(),
          })
        ),
      })
    )
    .output(
      z.object({
        created: z.number(),
        skipped: z.number(),
        profilesCreated: z.number(),
        entityIds: z.record(z.string(), z.string()), // refKey → entityId
        errors: z.array(
          z.object({
            refKey: z.string(),
            error: z.string(),
          })
        ),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const database = await getDb();
      const eventRepo = new EventRepository(sql);
      const entityRepo = new EntityRepository(database, eventRepo);
      const profileRepo = new (
        await import("@synap/database")
      ).ProfileRepository(database);

      // 1. Ensure all profiles exist (auto-create missing ones)
      const profileCache = new Map<string, string>(); // slug → id
      let profilesCreated = 0;

      // Gather unique profile slugs that need hints
      const profileHintsMap = new Map<
        string,
        {
          displayName?: string;
          icon?: string;
          color?: string;
          description?: string;
        }
      >();
      for (const e of input.entities) {
        if (e.profileHints && !profileHintsMap.has(e.profileSlug)) {
          profileHintsMap.set(e.profileSlug, e.profileHints);
        }
      }

      for (const entity of input.entities) {
        if (profileCache.has(entity.profileSlug)) continue;

        // Try to resolve existing profile
        const existing = await profileRepo.getBySlugForWorkspace(
          entity.profileSlug,
          ctx.workspaceId
        );
        if (existing) {
          profileCache.set(entity.profileSlug, existing.id);
          continue;
        }

        // Profile doesn't exist — create it
        const hints = profileHintsMap.get(entity.profileSlug) ?? {};
        const newProfile = await profileRepo.create({
          slug: entity.profileSlug,
          displayName: hints.displayName ?? entity.profileSlug,
          uiHints: {
            icon: hints.icon,
            color: hints.color,
            description: hints.description,
          },
          scope: "workspace" as any,
          workspaceId: ctx.workspaceId,
          userId: ctx.userId,
        });
        profileCache.set(entity.profileSlug, newProfile.id);
        profilesCreated++;
      }

      // 2. Check for existing entities (idempotency by profileSlug + title)
      const existingEntities = await database.query.entities.findMany({
        where: and(
          eq(entities.userId, ctx.userId),
          eq(entities.workspaceId, ctx.workspaceId),
          inArray(
            entities.type,
            input.entities.map((e) => e.profileSlug)
          )
        ),
      });

      const existingByKey = new Map<string, string>(); // "slug:title" → entityId
      for (const e of existingEntities) {
        existingByKey.set(`${e.type}:${e.title}`, e.id);
      }

      // 3. Create missing entities
      const entityIds: Record<string, string> = {};
      const errors: Array<{ refKey: string; error: string }> = [];
      let created = 0;
      let skipped = 0;

      for (const entity of input.entities) {
        const cacheKey = `${entity.profileSlug}:${entity.title}`;

        // Already exists → skip
        if (existingByKey.has(cacheKey)) {
          entityIds[entity.refKey] = existingByKey.get(cacheKey)!;
          skipped++;
          continue;
        }

        try {
          const profileId = profileCache.get(entity.profileSlug);
          if (!profileId) {
            throw new Error(`Profile ${entity.profileSlug} not in cache`);
          }

          const result = await entityRepo.create(
            {
              profileId,
              title: entity.title,
              properties: entity.properties,
              workspaceId: ctx.workspaceId,
              userId: ctx.userId,
              skipValidation: true, // seed data — trust the input
            },
            ctx.userId
          );
          entityIds[entity.refKey] = result.id;
          created++;
        } catch (err) {
          errors.push({
            refKey: entity.refKey,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return { created, skipped, profilesCreated, entityIds, errors };
    }),

  /**
   * Admin: get full entity detail by id (pod-admin only).
   */
  adminGet: podAdminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input }) => {
      const row = await db.query.entities.findFirst({
        where: eq(entities.id, input.id),
      });
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Entity not found" });
      }

      const ws = row.workspaceId
        ? await db.query.workspaces.findFirst({
            where: eq(workspaces.id, row.workspaceId),
            columns: { id: true, name: true },
          })
        : null;

      return {
        ...row,
        properties: row.properties ?? {},
        systemData: row.systemData ?? {},
        workspaceName: ws?.name ?? null,
      };
    }),

  /**
   * Admin: list profile slugs with entity counts (for the profile filter).
   */
  adminListProfiles: podAdminProcedure
    .input(
      z.object({
        workspaceId: z.union([z.string().uuid(), z.null()]).optional(),
      })
    )
    .query(async ({ input }) => {
      const conditions: any[] = [isNull(entities.deletedAt)];
      if (input.workspaceId === null) {
        conditions.push(isNull(entities.workspaceId));
      } else if (typeof input.workspaceId === "string") {
        conditions.push(eq(entities.workspaceId, input.workspaceId));
      }

      const rows = await db
        .select({
          profileSlug: entities.type,
          count: drizzleSql<number>`count(*)::int`,
        })
        .from(entities)
        .where(and(...conditions))
        .groupBy(entities.type)
        .orderBy(desc(drizzleSql`count(*)`));

      return rows.map((r) => ({
        profileSlug: r.profileSlug,
        count: r.count,
      }));
    }),
});
