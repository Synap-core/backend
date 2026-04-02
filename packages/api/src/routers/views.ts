/**
 * Views Router - Production-Ready
 *
 * Handles:
 * - View CRUD (whiteboards, timelines, kanban, etc.)
 * - Content loading/saving
 * - Integration with documents table
 * - Query execution with filters and sorts
 * - Manual entity ordering
 *
 * Architecture: Synchronous CRUD
 * - All write operations are direct DB calls
 * - Audit logging via events table (fire-and-forget)
 * - Side-effects (search indexing, webhooks) via pg-boss queue
 */

import { z } from "zod";
import { router, protectedProcedure, workspaceProcedure } from "../trpc.js";
import { storage } from "@synap/storage";
import {
  db,
  eq,
  and,
  desc,
  sql as pgSql,
  sqlTemplate as sql,
  inArray,
  or,
  getTableColumns,
  asc,
  type SQL,
  views,
  workspaces,
  documents,
  documentVersions,
  entities,
  relations,
  ViewFilterCompiler,
  PropertyMergingService,
  ViewDefaultColumnsService,
  getDb,
  EventRepository,
  ViewRepository,
  WorkspaceRepository,
  ProfileRepository,
} from "@synap/database";
import { TRPCError } from "@trpc/server";
import { ViewEvents } from "../lib/event-helpers.js";
import { auditLog } from "../utils/audit-log.js";
import { emitSideEffects } from "@synap/jobs";
import { verifyPermission, getWorkspaceMembership } from "@synap/database";
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import { randomUUID } from "crypto";

// Proper package imports
import {
  ViewContentSchema,
  getViewCategory,
  validateViewConfig,
  ViewTypeEnum,
  type ViewMetadata,
  type EntityFilter,
  type SortRule,
  type EntityQuery,
} from "@synap-core/types";

export const viewsRouter = router({
  /**
   * Create a new view (Synchronous: Direct DB insert)
   */
  create: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid().optional(),
        name: z.string().min(1).max(100),
        description: z.string().optional(),
        // Specific validation for view types and custom constraints
        // Uses ViewTypeEnum from @synap-core/types for single source of truth
        type: ViewTypeEnum,
        // NEW: Scope profiles (required for structured views)
        scopeProfileIds: z.array(z.string().uuid()).optional(),
        scopeMode: z.enum(["explicit", "observed"]).optional(),
        // NEW: Consolidated query
        query: z
          .object({
            filters: z.array(z.any()).optional(),
            sorts: z.array(z.any()).optional(),
            search: z.string().optional(),
            limit: z.number().optional(),
            offset: z.number().optional(),
            groupBy: z.string().optional(),
          })
          .optional(),
        // NEW: Render config (overrides only)
        config: z.record(z.string(), z.any()).optional(),
        // NEW: Embedded view IDs (for composite views)
        embeddedViewIds: z.array(z.string().uuid()).optional(),
        // Optional metadata (e.g. homeScope: 'user' for user-scoped Home)
        metadata: z.record(z.string(), z.any()).optional(),
        // Legacy: initialContent (for canvas views)
        initialContent: z.any().optional(),
        source: z.enum(["user", "ai", "intelligence", "system"]).optional(),
        reasoning: z.string().optional(),
        agentUserId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const correlationId = randomUUID();

      // Resolve workspace ID: prefer explicit input, fall back to context header
      const effectiveWorkspaceId = input.workspaceId || ctx.workspaceId || "";

      // If workspace available, check permissions (including AI proposal gate)
      if (effectiveWorkspaceId) {
        const perm = await checkPermissionOrPropose({
          userId: ctx.userId,
          agentUserId: input.agentUserId,
          workspaceId: effectiveWorkspaceId,
          subjectType: "view",
          action: "create",
          source: input.source,
          reasoning: input.reasoning,
          correlationId,
          data: {
            name: input.name,
            type: input.type,
            scopeProfileIds: input.scopeProfileIds,
          },
        });

        if ("denied" in perm && perm.denied) {
          throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
        }
        if ("proposalId" in perm) {
          return {
            view: null as Record<string, unknown> | null,
            documentId: null as string | null,
            status: "proposed" as const,
            message: "View creation proposed for review",
            proposalId: perm.proposalId,
          };
        }
      }

      // Emit .requested event
      auditLog({
        subjectType: "view",
        action: "create",
        phase: "requested",
        subjectId: correlationId,
        userId: ctx.userId,
        workspaceId: effectiveWorkspaceId,
        correlationId,
        data: { name: input.name, type: input.type },
      });

      // Compute category from view type
      const category = getViewCategory(input.type);

      // Validate scopeProfileIds for structured views
      if (category === "structured") {
        if (!input.scopeProfileIds || input.scopeProfileIds.length === 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "scopeProfileIds is required for structured views",
          });
        }
      }

      // Validate initial content if provided (canvas views)
      if (input.initialContent && category === "canvas") {
        const parseResult = ViewContentSchema.safeParse(input.initialContent);
        if (!parseResult.success) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Invalid view content structure",
            cause: parseResult.error,
          });
        }

        if (parseResult.data.category !== category) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `View type '${input.type}' requires '${category}' content, got '${parseResult.data.category}'`,
          });
        }
      }

      // Validate config against view type schema
      if (input.config) {
        const validation = validateViewConfig(input.type, input.config);
        if (!validation.valid) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Invalid view config",
            cause: validation.errors,
          });
        }
      }

      // Audit: log the requested event
      await ViewEvents.createRequested(ctx.userId, {
        type: input.type,
        name: input.name as string,
        workspaceId: effectiveWorkspaceId,
      });

      const { randomUUID: genId } = await import("crypto");
      const viewId = genId();

      // Canvas views (whiteboard, mindmap) need a document for Yjs + MinIO + versioning.
      // Structured and bento views store their config directly in views.config (JSONB) —
      // no document needed.
      let docId: string | null = null;
      if (category === "canvas") {
        const initialContent = input.initialContent || {};
        const contentStr = JSON.stringify(initialContent);
        const contentBuffer = Buffer.from(contentStr, "utf-8");

        const ext = "json";
        const storageKey = storage.buildPath(
          ctx.userId,
          input.type,
          viewId,
          ext
        );
        const uploadResult = await storage.upload(storageKey, contentBuffer, {
          contentType: "application/json",
        });

        docId = genId();
        const [doc] = await db
          .insert(documents)
          .values({
            id: docId,
            userId: ctx.userId,
            workspaceId: effectiveWorkspaceId,
            type: input.type,
            title: input.name,
            storageUrl: uploadResult.url,
            storageKey: uploadResult.path,
            size: uploadResult.size,
            mimeType: "application/json",
            currentVersion: 1,
          })
          .returning();

        await db.insert(documentVersions).values({
          documentId: doc.id,
          version: 1,
          content: contentStr,
          author: "user",
          authorId: ctx.userId,
          message: "Initial version",
        });
      }

      // Create view
      const baseMetadata = {
        entityCount: 0,
        createdBy: ctx.userId,
        ...input.metadata,
      };

      // Canvas views need a yjsRoomId for Yjs collaboration
      const yjsRoomId = docId ? `whiteboard-${docId}` : undefined;

      const dbInstance = await getDb();
      const eventRepo = new EventRepository(pgSql);
      const viewRepo = new ViewRepository(dbInstance, eventRepo);

      const createdView = await viewRepo.create(
        {
          id: viewId,
          type: input.type,
          name: input.name,
          description: input.description,
          documentId: docId,
          yjsRoomId,
          workspaceId: effectiveWorkspaceId,
          userId: ctx.userId,
          scopeProfileIds: input.scopeProfileIds,
          scopeMode: input.scopeMode || "explicit",
          query: (input.query || {}) as Record<string, unknown>,
          config: (input.config || {}) as Record<string, unknown>,
          embeddedViewIds: input.embeddedViewIds || [],
          metadata: baseMetadata,
        },
        ctx.userId
      );

      // Emit .completed event
      auditLog({
        subjectType: "view",
        action: "create",
        phase: "completed",
        subjectId: viewId,
        userId: ctx.userId,
        workspaceId: effectiveWorkspaceId,
        correlationId,
        data: {
          id: viewId,
          type: input.type,
          name: input.name,
          ...(docId ? { documentId: docId } : {}),
        },
      });

      // Side-effects (search indexing, webhooks — fire-and-forget)
      emitSideEffects({
        subjectType: "view",
        action: "create",
        subjectId: viewId,
        userId: ctx.userId,
        workspaceId: effectiveWorkspaceId,
        data: {
          id: viewId,
          type: input.type,
          name: input.name,
        },
      });

      return { view: createdView, documentId: docId, status: "created" };
    }),

  /**
   * List views
   */
  list: protectedProcedure
    .input(
      z.object({
        /** Filter to one or more workspaces. Omit to return all user's views. */
        workspaceIds: z.array(z.string().uuid()).optional(),
        type: z
          .enum([
            "whiteboard",
            "timeline",
            "kanban",
            "table",
            "list",
            "grid",
            "gallery",
            "calendar",
            "gantt",
            "mindmap",
            "graph",
            "all",
          ])
          .optional(),
        /** When true, exclude views that were auto-created by bento block picker */
        excludeAutoCreated: z.boolean().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const workspaceCondition =
        input.workspaceIds && input.workspaceIds.length > 0
          ? inArray(views.workspaceId, input.workspaceIds)
          : undefined;

      const query = db.query.views.findMany({
        where: and(
          eq(views.userId, ctx.userId),
          workspaceCondition,
          input.type && input.type !== "all"
            ? eq(views.type, input.type)
            : undefined,
          input.excludeAutoCreated
            ? sql`(${views.metadata}->>'autoCreated') IS DISTINCT FROM 'true'`
            : undefined
        ),
        orderBy: [desc(views.updatedAt)],
      });

      return await query;
    }),

  /**
   * Get Home bento view for a workspace (workspace-level, user-level, or effective).
   * - effective: user home if exists, else workspace home
   * - workspace: base home (admin-only edit)
   * - user: current user's home (null if not created)
   */
  getHome: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid(),
        scope: z.enum(["workspace", "user", "effective"]).default("effective"),
      })
    )
    .query(async ({ input, ctx }) => {
      const permResult = await verifyPermission({
        db,
        userId: ctx.userId,
        workspace: { id: input.workspaceId },
        requiredPermission: "read",
      });
      if (!permResult.allowed)
        throw new TRPCError({
          code: "FORBIDDEN",
          message: permResult.reason ?? "Insufficient permissions",
        });

      const homeScope = (m: unknown) =>
        (m as Record<string, string> | null)?.homeScope;

      if (input.scope === "user" || input.scope === "effective") {
        const bentoViews = await db.query.views.findMany({
          where: and(
            eq(views.workspaceId, input.workspaceId),
            eq(views.type, "bento"),
            eq(views.userId, ctx.userId)
          ),
        });
        const userHome = bentoViews.find(
          (v) => homeScope(v.metadata) === "user"
        );
        if (userHome) return { view: userHome };
        if (input.scope === "user") return { view: null };
      }

      const bentoViews = await db.query.views.findMany({
        where: and(
          eq(views.workspaceId, input.workspaceId),
          eq(views.type, "bento")
        ),
      });
      const workspaceHome = bentoViews.find(
        (v) => homeScope(v.metadata) === "workspace"
      );
      return { view: workspaceHome ?? null };
    }),

  /**
   * Get view with content
   */
  get: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const view = await db.query.views.findFirst({
        where: eq(views.id, input.id),
      });

      if (!view) {
        throw new TRPCError({ code: "NOT_FOUND", message: "View not found" });
      }

      if (!view.workspaceId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "View must belong to a workspace",
        });
      }
      // Check access
      const permResult = await verifyPermission({
        db,
        userId: ctx.userId,
        workspace: { id: view.workspaceId },
        requiredPermission: "read", // or 'read' for requireViewer
      });
      if (!permResult.allowed)
        throw new TRPCError({
          code: "FORBIDDEN",
          message: permResult.reason || "Insufficient permissions",
        });

      // Load content: whiteboards from MinIO (canonical), others from document_versions
      let content = {};
      if (view.documentId) {
        const doc = await db.query.documents.findFirst({
          where: eq(documents.id, view.documentId),
        });

        if (doc?.storageKey && view.type === "whiteboard") {
          // Whiteboard: MinIO is canonical source (Yjs writeState saves here)
          try {
            const buffer = await storage.downloadBuffer(doc.storageKey);
            content = JSON.parse(buffer.toString("utf-8"));
          } catch {
            content = {};
          }
        } else {
          // Other view types: load from document_versions
          const latestVersion = await db.query.documentVersions.findFirst({
            where: eq(documentVersions.documentId, view.documentId),
            orderBy: [desc(documentVersions.version)],
          });
          if (latestVersion) {
            try {
              content = JSON.parse(latestVersion.content);
            } catch {
              content = {};
            }
          }
        }
      }

      return { view, content };
    }),

  /**
   * Execute view query and return entities
   */
  execute: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const view = await db.query.views.findFirst({
        where: eq(views.id, input.id),
      });

      if (!view) {
        throw new TRPCError({ code: "NOT_FOUND", message: "View not found" });
      }
      if (!view.workspaceId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "View must belong to a workspace",
        });
      }
      // Check access
      const permResult = await verifyPermission({
        db,
        userId: ctx.userId,
        workspace: { id: view.workspaceId },
        requiredPermission: "read", // or 'read' for requireViewer
      });
      if (!permResult.allowed)
        throw new TRPCError({
          code: "FORBIDDEN",
          message: permResult.reason || "Insufficient permissions",
        });

      const category = getViewCategory(view.type);

      // Canvas views: Return document content
      if (category === "canvas") {
        let content = {};
        if (view.documentId) {
          const latestVersion = await db.query.documentVersions.findFirst({
            where: eq(documentVersions.documentId, view.documentId),
            orderBy: [desc(documentVersions.version)],
          });
          if (latestVersion) {
            try {
              content = JSON.parse(latestVersion.content);
            } catch (e) {
              content = {};
            }
          }
        }

        return { view, content, entities: [], relations: [] };
      }

      // Structured views: Execute query from new query structure
      if (!view.scopeProfileIds || view.scopeProfileIds.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "View must have scopeProfileIds. Please recreate the view with profile scope.",
        });
      }

      // NEW: Use consolidated query structure
      const query = (view.query as EntityQuery) || {};
      const {
        filters = [],
        sorts = [],
        search,
        limit = 100,
        offset = 0,
      } = query;

      const conditions: any[] = [];

      // Filter by workspace
      if (view.workspaceId) {
        conditions.push(eq(entities.workspaceId, view.workspaceId));
      }

      // Filter by scope profiles (profileId FK)
      if (view.scopeProfileIds && view.scopeProfileIds.length > 0) {
        conditions.push(inArray(entities.profileId, view.scopeProfileIds));
      }

      // Pre-resolve property definitions (avoid N+1)
      const dbInstance = await getDb();
      const propertyMerging = new PropertyMergingService(dbInstance);
      const mergedProperties =
        await propertyMerging.mergePropertiesFromProfiles(
          view.scopeProfileIds,
          dbInstance
        );

      // Build property definition map
      const propertyDefMap = new Map<string, string[]>();
      for (const [slug, prop] of mergedProperties) {
        propertyDefMap.set(slug, prop.propertyDefIds);
      }

      // Apply custom filters (using ViewFilterCompiler with multi-profile support)
      if (filters && filters.length > 0) {
        const filterCompiler = new ViewFilterCompiler(dbInstance);
        try {
          const compiledFilters = await filterCompiler.compileFilters(
            filters as EntityFilter[],
            view.scopeProfileIds,
            propertyDefMap
          );

          if (compiledFilters) {
            conditions.push(compiledFilters);
          }
        } catch (error) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: error instanceof Error ? error.message : "Invalid filter",
            cause: error,
          });
        }
      }

      // Apply full-text search
      if (search) {
        conditions.push(
          sql`(${entities.title} ILIKE ${`%${search}%`} OR ${entities.preview} ILIKE ${`%${search}%`})`
        );
      }

      // Build order by clauses with STRICT validation
      const orderByClause: any[] = [];
      if (sorts && sorts.length > 0) {
        for (const sort of sorts as SortRule[]) {
          // STRICT POLICY: Validate sort field
          if (sort.field.startsWith("properties.")) {
            const propertySlug = sort.field.split(".")[1];
            const property = mergedProperties.get(propertySlug);

            if (!property) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: `Property "${propertySlug}" not found in scope profiles`,
              });
            }

            // STRICT: Must be indexed
            if (!property.indexed) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: `Cannot sort by "${propertySlug}" - not indexed. Only indexed properties or core fields can be sorted.`,
              });
            }

            // STRICT: Must exist in all profiles
            if (property.profiles.length !== view.scopeProfileIds.length) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: `Cannot sort by "${propertySlug}" - property not present in all scope profiles. Sort requires property to exist in all profiles.`,
              });
            }
          }

          const sortClause = buildSortClause(sort);
          if (sortClause) {
            orderByClause.push(sortClause);
          }
        }
      }

      // Execute query
      let fetchedEntities = await db
        .select()
        .from(entities)
        .where(and(...conditions))
        .orderBy(
          ...(orderByClause.length > 0
            ? orderByClause
            : [desc(entities.createdAt)])
        )
        .limit(limit)
        .offset(offset);

      // Apply manual ordering if present (from metadata)
      const metadata = view.metadata as ViewMetadata | undefined;
      const entityOrders = metadata?.entityOrders;
      if (entityOrders && Object.keys(entityOrders).length > 0) {
        fetchedEntities = fetchedEntities.sort((a, b) => {
          const aOrder = entityOrders[a.id] ?? Infinity;
          const bOrder = entityOrders[b.id] ?? Infinity;
          return aOrder - bOrder;
        });
      }

      // Get relations between entities
      const entityIds = fetchedEntities.map((e) => e.id);
      const fetchedRelations =
        entityIds.length > 0
          ? await db
              .select()
              .from(relations)
              .where(
                or(
                  inArray(relations.sourceEntityId, entityIds),
                  inArray(relations.targetEntityId, entityIds)
                )
              )
          : [];

      // Compute default columns from scope profiles
      const defaultColumnsService = new ViewDefaultColumnsService();
      const defaultColumns = defaultColumnsService.computeTableColumns(
        mergedProperties,
        view.scopeProfileIds.length
      );

      // Apply column overrides from config
      const config = (view.config as Record<string, unknown>) || {};
      const finalColumns = defaultColumnsService.applyColumnOverrides(
        defaultColumns,
        {
          hiddenColumns: config.hiddenColumns as string[] | undefined,
          visibleColumns: config.visibleColumns as string[] | undefined,
          columnOrder: config.columnOrder as string[] | undefined,
          columnWidths: config.columnWidths as
            | Record<string, number>
            | undefined,
        }
      );

      return {
        view,
        query,
        config: view.config || {},
        entities: fetchedEntities,
        relations: fetchedRelations,
        columns: finalColumns,
      };
    }),

  /**
   * Save view content
   */
  save: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        content: z.any(),
        metadata: z.record(z.string(), z.any()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const view = await db.query.views.findFirst({
        where: eq(views.id, input.id),
      });

      if (!view) {
        throw new TRPCError({ code: "NOT_FOUND", message: "View not found" });
      }
      if (!view.workspaceId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "View must belong to a workspace",
        });
      }
      const permResult = await verifyPermission({
        db,
        userId: ctx.userId,
        workspace: { id: view.workspaceId },
        requiredPermission: "write", // or 'read' for requireViewer
      });
      if (!permResult.allowed)
        throw new TRPCError({
          code: "FORBIDDEN",
          message: permResult.reason || "Insufficient permissions",
        });
      // Validate content structure
      const parseResult = ViewContentSchema.safeParse(input.content);
      if (!parseResult.success) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Invalid view content structure",
          cause: parseResult.error,
        });
      }

      // Ensure content category matches view type
      const expectedCategory = getViewCategory(view.type);
      if (parseResult.data.category !== expectedCategory) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `View type '${view.type}' requires '${expectedCategory}' content, got '${parseResult.data.category}'`,
        });
      }

      // Save content to storage + create version snapshot
      if (view.documentId) {
        const doc = await db.query.documents.findFirst({
          where: eq(documents.id, view.documentId),
        });

        const contentStr = JSON.stringify(input.content);

        // Whiteboards: always push to MinIO (canonical source for Yjs)
        if (doc?.storageKey && view.type === "whiteboard") {
          await storage.upload(
            doc.storageKey,
            Buffer.from(contentStr, "utf-8"),
            { contentType: "application/json" }
          );
        }

        const newVersion = (doc?.currentVersion || 0) + 1;

        await db.insert(documentVersions).values({
          documentId: view.documentId,
          version: newVersion,
          content: contentStr,
          author: "user",
          authorId: ctx.userId,
          message: "Manual save",
        });

        await db
          .update(documents)
          .set({
            currentVersion: newVersion,
            lastSavedVersion: newVersion,
            updatedAt: new Date(),
          })
          .where(eq(documents.id, view.documentId));
      }

      // Update view metadata
      if (input.metadata) {
        await db
          .update(views)
          .set({
            metadata: input.metadata,
            updatedAt: new Date(),
          })
          .where(eq(views.id, input.id));
      }

      return { success: true };
    }),
  /**
   * Update view metadata (Synchronous: Direct DB update)
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().min(1).max(100).optional(),
        description: z.string().optional(),
        // NEW: Scope profiles
        scopeProfileIds: z.array(z.string().uuid()).optional(),
        scopeMode: z.enum(["explicit", "observed"]).optional(),
        // NEW: Consolidated query
        query: z
          .object({
            filters: z.array(z.any()).optional(),
            sorts: z.array(z.any()).optional(),
            search: z.string().optional(),
            limit: z.number().optional(),
            offset: z.number().optional(),
            groupBy: z.string().optional(),
          })
          .optional(),
        // NEW: Render config (overrides only)
        config: z.record(z.string(), z.any()).optional(),
        // NEW: Embedded view IDs (for composite views)
        embeddedViewIds: z.array(z.string().uuid()).optional(),
        // NEW: Schema snapshot
        schemaSnapshot: z.record(z.string(), z.any()).optional(),
        snapshotUpdatedAt: z.date().optional(),
        // View type (for switching between types)
        // Uses ViewTypeEnum from @synap-core/types for single source of truth
        type: ViewTypeEnum.optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const view = await db.query.views.findFirst({
        where: eq(views.id, input.id),
      });

      if (!view) {
        throw new TRPCError({ code: "NOT_FOUND", message: "View not found" });
      }
      if (!view.workspaceId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "View must belong to a workspace",
        });
      }

      // Check access
      const permResult = await verifyPermission({
        db,
        userId: ctx.userId,
        workspace: { id: view.workspaceId },
        requiredPermission: "write",
      });
      if (!permResult.allowed)
        throw new TRPCError({
          code: "FORBIDDEN",
          message: permResult.reason || "Insufficient permissions",
        });

      // Workspace Home (metadata.homeScope === 'workspace') is editable only by admin/owner
      const metadata = (view.metadata as Record<string, unknown>) || {};
      if (metadata.homeScope === "workspace") {
        const member = await getWorkspaceMembership(
          db,
          view.workspaceId,
          ctx.userId
        );
        const role = member?.role;
        if (role !== "admin" && role !== "owner")
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Only workspace admins can edit the workspace Home",
          });
      }

      // Validate config against view type schema (use input.type or existing view.type)
      const viewType = input.type || view.type;
      if (input.config) {
        const validation = validateViewConfig(viewType, input.config);
        if (!validation.valid) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Invalid view config",
            cause: validation.errors,
          });
        }
      }

      // Direct DB update via ViewRepository
      const dbInstance = await getDb();
      const eventRepo = new EventRepository(pgSql);
      const viewRepo = new ViewRepository(dbInstance, eventRepo);

      const updatedView = await viewRepo.update(
        input.id,
        {
          name: input.name,
          description: input.description,
          scopeProfileIds: input.scopeProfileIds,
          scopeMode: input.scopeMode,
          query: input.query as Record<string, unknown> | undefined,
          config: input.config as Record<string, unknown> | undefined,
          embeddedViewIds: input.embeddedViewIds,
          schemaSnapshot: input.schemaSnapshot as
            | Record<string, unknown>
            | undefined,
          snapshotUpdatedAt: input.snapshotUpdatedAt,
        },
        ctx.userId
      );

      // Audit log (fire-and-forget)
      auditLog({
        subjectType: "view",
        action: "update",
        phase: "completed",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: view.workspaceId,
        data: {
          id: input.id,
          name: input.name,
          type: input.type,
        },
      });

      // Side-effects (search indexing, webhooks — fire-and-forget)
      emitSideEffects({
        subjectType: "view",
        action: "update",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: view.workspaceId,
        data: {
          id: input.id,
          name: input.name || view.name,
        },
      });

      return {
        status: "updated",
        message: "View updated",
        view: updatedView,
      };
    }),

  /**
   * Delete view (Synchronous: Direct DB delete)
   */
  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const view = await db.query.views.findFirst({
        where: eq(views.id, input.id),
      });

      if (!view) {
        throw new TRPCError({ code: "NOT_FOUND", message: "View not found" });
      }
      if (!view.workspaceId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "View must belong to a workspace",
        });
      }

      // Check access
      const permResult = await verifyPermission({
        db,
        userId: ctx.userId,
        workspace: { id: view.workspaceId },
        requiredPermission: "write", // or 'read' for requireViewer
      });
      if (!permResult.allowed)
        throw new TRPCError({
          code: "FORBIDDEN",
          message: permResult.reason || "Insufficient permissions",
        });

      // Delete view via ViewRepository
      const dbInstance = await getDb();
      const eventRepo = new EventRepository(pgSql);
      const viewRepo = new ViewRepository(dbInstance, eventRepo);

      await viewRepo.delete(input.id, ctx.userId);

      // Also delete the associated document
      if (view.documentId) {
        await db.delete(documents).where(eq(documents.id, view.documentId));
      }

      // Audit log (fire-and-forget)
      auditLog({
        subjectType: "view",
        action: "delete",
        phase: "completed",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: view.workspaceId,
        data: { id: input.id },
      });

      // Side-effects (search de-index, webhooks — fire-and-forget)
      emitSideEffects({
        subjectType: "view",
        action: "delete",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: view.workspaceId,
        data: { id: input.id },
      });

      return { success: true, status: "deleted" };
    }),

  /**
   * Reorder entity in view (manual ordering)
   */
  reorderEntity: protectedProcedure
    .input(
      z.object({
        viewId: z.string().uuid(),
        entityId: z.string().uuid(),
        beforeEntityId: z.string().uuid().optional(),
        afterEntityId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const view = await db.query.views.findFirst({
        where: eq(views.id, input.viewId),
      });

      if (!view) {
        throw new TRPCError({ code: "NOT_FOUND", message: "View not found" });
      }

      if (!view.workspaceId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "View must belong to a workspace",
        });
      }

      // Check access
      const permResult = await verifyPermission({
        db,
        userId: ctx.userId,
        workspace: { id: view.workspaceId },
        requiredPermission: "write", // or 'read' for requireViewer
      });
      if (!permResult.allowed)
        throw new TRPCError({
          code: "FORBIDDEN",
          message: permResult.reason || "Insufficient permissions",
        });

      // Get current entity orders
      const metadata = (view.metadata as ViewMetadata) || {};
      const entityOrders = metadata.entityOrders || {};

      // Calculate new order using fractional indexing
      let newOrder: number;

      if (input.beforeEntityId && input.afterEntityId) {
        const beforeOrder = entityOrders[input.beforeEntityId] ?? 0;
        const afterOrder = entityOrders[input.afterEntityId] ?? beforeOrder + 2;
        newOrder = (beforeOrder + afterOrder) / 2;
      } else if (input.beforeEntityId) {
        const beforeOrder = entityOrders[input.beforeEntityId] ?? 0;
        newOrder = beforeOrder + 1;
      } else if (input.afterEntityId) {
        const afterOrder = entityOrders[input.afterEntityId] ?? 1;
        newOrder = afterOrder / 2;
      } else {
        const maxOrder = Math.max(
          ...(Object.values(entityOrders) as number[]),
          0
        );
        newOrder = maxOrder + 1;
      }

      // Update entity order
      entityOrders[input.entityId] = newOrder;

      // Update view metadata
      await db
        .update(views)
        .set({
          metadata: {
            ...metadata,
            entityOrders,
          },
          updatedAt: new Date(),
        })
        .where(eq(views.id, input.viewId));

      return {
        success: true,
        newOrder,
      };
    }),

  /**
   * Get available columns for a view (from scope profiles)
   */
  getAvailableColumns: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const view = await db.query.views.findFirst({
        where: eq(views.id, input.id),
      });

      if (!view) {
        throw new TRPCError({ code: "NOT_FOUND", message: "View not found" });
      }

      if (!view.workspaceId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "View must belong to a workspace",
        });
      }

      // Check access
      const permResult = await verifyPermission({
        db,
        userId: ctx.userId,
        workspace: { id: view.workspaceId },
        requiredPermission: "read",
      });
      if (!permResult.allowed)
        throw new TRPCError({
          code: "FORBIDDEN",
          message: permResult.reason || "Insufficient permissions",
        });

      // Only structured views have columns
      if (view.category !== "structured") {
        return { columns: [] };
      }

      if (!view.scopeProfileIds || view.scopeProfileIds.length === 0) {
        return { columns: [] };
      }

      // Merge properties from scope profiles
      const dbInstance = await getDb();
      const propertyMerging = new PropertyMergingService(dbInstance);
      const mergedProperties =
        await propertyMerging.mergePropertiesFromProfiles(
          view.scopeProfileIds,
          dbInstance
        );

      // Compute default columns
      const defaultColumnsService = new ViewDefaultColumnsService();
      const columns = defaultColumnsService.computeTableColumns(
        mergedProperties,
        view.scopeProfileIds.length
      );

      return { columns };
    }),

  /**
   * Lazily create (or return existing) bento view for a profile.
   *
   * The viewId is stored in workspace.settings.profileBentoViewIds[profileSlug]
   * (not on the profile row) so system/shared profiles can have different bento
   * views per workspace. Uses mergeSettings for an atomic JSONB patch.
   */
  ensureProfileBento: workspaceProcedure
    .input(z.object({ profileSlug: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const dbConn = await getDb();
      const eventRepo = new EventRepository(pgSql);

      // 1. Check workspace settings for an existing bento view ID (O(1) lookup)
      const workspace = await dbConn.query.workspaces.findFirst({
        where: eq(workspaces.id, ctx.workspaceId),
      });
      if (!workspace) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Workspace not found",
        });
      }

      const settings = (workspace.settings ?? {}) as Record<string, unknown>;
      const profileBentoViewIds = (settings.profileBentoViewIds ??
        {}) as Record<string, string>;
      const existingViewId = profileBentoViewIds[input.profileSlug];
      if (existingViewId) {
        return { viewId: existingViewId };
      }

      // 2. Find the profile
      const profileRepo = new ProfileRepository(dbConn);
      const profile = await profileRepo.getBySlugForWorkspace(
        input.profileSlug,
        ctx.workspaceId
      );
      if (!profile) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Profile '${input.profileSlug}' not found`,
        });
      }

      // 3. Build default blocks and create bento view
      const color =
        ((profile.uiHints as Record<string, unknown>)?.color as
          | string
          | undefined) ?? "#6366F1";
      const rawIcon = (profile.uiHints as Record<string, unknown>)?.icon as
        | string
        | undefined;
      const icon = rawIcon
        ? rawIcon
            .split("-")
            .map((s: string) => s.charAt(0).toUpperCase() + s.slice(1))
            .join("")
        : "Database";
      const slug = profile.slug;

      const blocks = [
        {
          id: `${slug}-header`,
          kind: "widget",
          widgetType: "section-header",
          pos: { x: 0, y: 0, w: 12, h: 2 },
          config: {
            title: profile.displayName,
            icon,
            profileSlug: slug,
            color,
          },
        },
        {
          id: `${slug}-count`,
          kind: "widget",
          widgetType: "stat-card",
          pos: { x: 0, y: 2, w: 3, h: 3 },
          config: {
            label: `Total ${profile.displayName}s`,
            aggregation: "count",
            profileSlug: slug,
            icon,
            color,
          },
        },
        {
          id: `${slug}-table`,
          kind: "widget",
          widgetType: "view-table",
          pos: { x: 0, y: 5, w: 12, h: 9 },
          config: { profileSlug: slug },
        },
      ];

      const viewRepo = new ViewRepository(dbConn, eventRepo);
      const newView = await viewRepo.create(
        {
          name: profile.displayName,
          type: "bento",
          scopeProfileIds: [profile.id],
          config: { layout: "bento", blocks },
          metadata: { isProfileBento: true, profileSlug: slug },
          workspaceId: ctx.workspaceId,
          userId: ctx.userId,
        },
        ctx.userId
      );

      // 4. Atomically merge the new viewId into workspace settings
      const workspaceRepo = new WorkspaceRepository(dbConn, eventRepo);
      await workspaceRepo.mergeSettings(
        ctx.workspaceId,
        { profileBentoViewIds: { ...profileBentoViewIds, [slug]: newView.id } },
        ctx.userId
      );

      return { viewId: newView.id };
    }),
});

/**
 * Build a sort clause from a SortRule
 */
function buildSortClause(sort: SortRule): SQL | null {
  const { field, direction } = sort;
  const isPropertyField = field.startsWith("properties.");

  if (isPropertyField) {
    const propertyKey = field.split(".")[1];
    const propertiesCol = entities.properties; // Use properties instead of metadata

    // Sort by JSON field text value
    return direction === "asc"
      ? sql`${propertiesCol}->>${propertyKey} ASC`
      : sql`${propertiesCol}->>${propertyKey} DESC`;
  } else {
    const entityColumns = getTableColumns(entities);
    if (field in entityColumns) {
      const column = entityColumns[field as keyof typeof entityColumns];
      return direction === "asc" ? asc(column) : desc(column);
    }
    return null;
  }
}
