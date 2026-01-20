/**
 * Views Router - Production-Ready
 *
 * Handles:
 * - View CRUD (whiteboards, timelines, kanban, etc.)
 * - Content loading/saving
 * - Integration with documents table
 * - Query execution with filters and sorts
 * - Manual entity ordering
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import {
  db,
  eq,
  and,
  desc,
  sqlTemplate as sql,
  inArray,
  or,
  like,
  gt,
  lt,
  gte,
  lte,
  isNull,
  isNotNull,
  getTableColumns,
  asc,
  type SQL,
  type Column,
  views,
  documents,
  documentVersions,
  entities,
  relations,
  insertViewSchema,
} from "@synap/database";
import { TRPCError } from "@trpc/server";
import { ViewEvents } from "../lib/event-helpers.js";
import { emitRequestEvent } from "../utils/emit-event.js";
import { verifyPermission } from "@synap/database";

// Proper package imports
import {
  ViewContentSchema,
  getViewCategory,
  type ViewMetadata,
  type StructuredViewConfig,
  type EntityFilter,
  type SortRule,
} from "@synap-core/types";

export const viewsRouter = router({
  /**
   * Create a new view
   */
  create: protectedProcedure
    .input(
      insertViewSchema
        .pick({
          workspaceId: true,
          name: true,
          description: true,
        })
        .extend({
          // Specific validation for view types and custom constraints
          type: z.enum([
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
          ]),
          name: z.string().min(1).max(100),
          initialContent: z.any().optional(),
        })
    )
    .mutation(async ({ input, ctx }) => {
      // If workspace provided, check user has editor role
      if (input.workspaceId) {
        const permResult = await verifyPermission({
          db,
          userId: ctx.userId,
          workspace: { id: input.workspaceId },
          requiredPermission: "write", // or 'read' for requireViewer
        });
        if (!permResult.allowed)
          throw new TRPCError({
            code: "FORBIDDEN",
            message: permResult.reason || "Insufficient permissions",
          });
      }

      // Compute category from view type
      const category = getViewCategory(input.type as any);

      // Validate initial content if provided
      if (input.initialContent) {
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

      await ViewEvents.createRequested(ctx.userId, {
        type: input.type as any,
        name: input.name as string,
        workspaceId: input.workspaceId || "",
      });

      // Create document for content storage
      const [doc] = await db
        .insert(documents)
        .values({
          userId: ctx.userId,
          type: input.type,
          title: input.name,
          storageUrl: "",
          storageKey: `views/${input.type}/${Date.now()}`,
          size: 0,
          currentVersion: 1,
        } as any)
        .returning();

      // Create initial version with content
      await db.insert(documentVersions).values({
        documentId: doc.id,
        version: 1,
        content: JSON.stringify(input.initialContent || {}),
        author: "user",
        authorId: ctx.userId,
        message: "Initial version",
      });

      // Create view (Event-Driven)
      const { randomUUID } = await import("crypto");
      const viewId = randomUUID();

      const optimisticView = {
        id: viewId,
        workspaceId: input.workspaceId,
        userId: ctx.userId,
        type: input.type,
        category,
        name: input.name,
        description: input.description,
        documentId: doc.id,
        metadata: {
          entityCount: 0,
          createdBy: ctx.userId,
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await emitRequestEvent({
        type: "views.create.requested",
        subjectId: viewId,
        subjectType: "view",
        data: {
          id: viewId,
          type: input.type,
          name: input.name,
          documentId: doc.id,
          workspaceId: input.workspaceId,
          config: optimisticView.metadata,
          userId: ctx.userId,
        },
        userId: ctx.userId,
      });

      return { view: optimisticView, documentId: doc.id, status: "requested" };
    }),

  /**
   * List views
   */
  list: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid().optional(),
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
      })
    )
    .query(async ({ input, ctx }) => {
      const query = db.query.views.findMany({
        where: and(
          eq(views.userId, ctx.userId),
          input.workspaceId
            ? eq(views.workspaceId, input.workspaceId)
            : undefined,
          input.type && input.type !== "all"
            ? eq(views.type, input.type)
            : undefined
        ),
        orderBy: [desc(views.updatedAt)],
      });

      return await query;
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

      // Load content from latest document version
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

      const category = getViewCategory(view.type as any);

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

      // Structured views: Execute query from metadata config
      const metadata = view.metadata as ViewMetadata | undefined;
      const config = metadata?.config as StructuredViewConfig | undefined;

      // Ensure config has query property before accessing
      if (!config || !("query" in config) || !config.query) {
        return { view, config, entities: [], relations: [] };
      }

      const { entityTypes, filters, sorts, limit, offset } = config.query;
      const conditions: any[] = [];

      // Filter by workspace
      if (view.workspaceId) {
        conditions.push(eq(entities.workspaceId, view.workspaceId));
      }

      // Filter by entity types
      if (entityTypes && entityTypes.length > 0) {
        conditions.push(inArray(entities.type, entityTypes));
      }

      // Apply custom filters
      if (filters && filters.length > 0) {
        for (const filter of filters) {
          const fieldCondition = buildFilterCondition(filter);
          if (fieldCondition) {
            conditions.push(fieldCondition);
          }
        }
      }

      // Build order by clauses
      const orderByClause: any[] = [];
      if (sorts && sorts.length > 0) {
        for (const sort of sorts) {
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
        .limit(limit || 100)
        .offset(offset || 0);

      // Apply manual ordering if present
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

      return {
        view,
        config,
        entities: fetchedEntities,
        relations: fetchedRelations,
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
        metadata: z.record(z.any()).optional(),
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
      const expectedCategory = getViewCategory(view.type as any);
      if (parseResult.data.category !== expectedCategory) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `View type '${view.type}' requires '${expectedCategory}' content, got '${parseResult.data.category}'`,
        });
      }

      // Create new version with updated content
      if (view.documentId) {
        const doc = await db.query.documents.findFirst({
          where: eq(documents.id, view.documentId),
        });

        const newVersion = (doc?.currentVersion || 0) + 1;

        await db.insert(documentVersions).values({
          documentId: view.documentId,
          version: newVersion,
          content: JSON.stringify(input.content),
          author: "user",
          authorId: ctx.userId,
          message: "Auto-save",
        });

        await db
          .update(documents)
          .set({
            currentVersion: newVersion,
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
   * Update view metadata (name, description)
   */
  update: protectedProcedure
    .input(
      insertViewSchema
        .pick({
          id: true,
          name: true,
          description: true,
        })
        .partial({
          name: true,
          description: true,
        })
        .required({
          id: true,
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
        requiredPermission: "write", // or 'read' for requireViewer
      });
      if (!permResult.allowed)
        throw new TRPCError({
          code: "FORBIDDEN",
          message: permResult.reason || "Insufficient permissions",
        });

      await emitRequestEvent({
        type: "views.update.requested",
        subjectId: input.id,
        subjectType: "view",
        data: {
          id: input.id,
          name: input.name,
          description: input.description,
          userId: ctx.userId,
        },
        userId: ctx.userId,
      });

      return {
        status: "requested",
        message: "View update requested",
      };
    }),

  /**
   * Delete view
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

      await emitRequestEvent({
        type: "views.delete.requested",
        subjectId: input.id,
        subjectType: "view",
        data: {
          id: input.id,
          userId: ctx.userId,
        },
        userId: ctx.userId,
      });

      // Optionally delete document (keeping this synchronous for safety/cleanup as discussed)
      if (view.documentId) {
        await db.delete(documents).where(eq(documents.id, view.documentId));
      }

      return { success: true, status: "requested" };
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
});

/**
 * Build a filter condition from an EntityFilter
 */
function buildFilterCondition(filter: EntityFilter): SQL | null {
  const { field, operator, value } = filter;
  const isMetadataField = field.startsWith("metadata.");

  if (isMetadataField) {
    const metadataKey = field.split(".")[1];

    // Use jsonb_extract_path_text equivalent or the ->> operator
    // Since we are inside sql template, we can't easily avoid raw sql here,
    // but we can type the result
    const metadataCol = entities.metadata;

    switch (operator) {
      case "equals":
        return sql`${metadataCol}->>${metadataKey} = ${value}`;
      case "not_equals":
        return sql`${metadataCol}->>${metadataKey} != ${value}`;
      case "contains":
        return sql`${metadataCol}->>${metadataKey} ILIKE ${"%" + value + "%"}`;
      case "is_empty":
        return sql`${metadataCol}->>${metadataKey} IS NULL`;
      case "is_not_empty":
        return sql`${metadataCol}->>${metadataKey} IS NOT NULL`;
      case "in":
        if (Array.isArray(value)) {
          // Properly escape array values or use Drizzle array operator if available for JSON
          // Using Postgres ANY with string array
          return sql`${metadataCol}->>${metadataKey} = ANY(${value})`;
        }
        return null;
      default:
        return null;
    }
  } else {
    // Dynamically get the column
    // We start with all entity columns
    const entityColumns = getTableColumns(entities);

    // We check if the field exists in the columns
    if (field in entityColumns) {
      // Safe access because we checked existence
      const column = entityColumns[field as keyof typeof entityColumns];

      // Determine column type roughly for stricter operator checks if we wanted,
      // but mostly we need to handle the value type matching.

      // We can't easily exhaustively query column type here to eliminate all casts,
      // but we can eliminate the 'as any' on the return

      switch (operator) {
        case "equals":
          return eq(column, value);
        case "not_equals":
          // Drizzle doesn't have a direct 'ne' or 'neq' in some versions, but usually 'ne' exists or we use not(eq())
          // If 'ne' is missing, sql is fine or notEq
          // Checking imports... we don't have 'ne' or 'notEq' imported.
          return sql`${column} != ${value}`;
        case "contains":
          // Like expects string
          return like(column as Column<any, any, any>, `%${value}%`);
        case "greater_than":
          return gt(column, value);
        case "less_than":
          return lt(column, value);
        case "greater_than_or_equal":
          return gte(column, value);
        case "less_than_or_equal":
          return lte(column, value);
        case "is_empty":
          return isNull(column);
        case "is_not_empty":
          return isNotNull(column);

        default:
          return null;
      }
    }

    return null;
  }
}

/**
 * Build a sort clause from a SortRule
 */
function buildSortClause(sort: SortRule): SQL | null {
  const { field, direction } = sort;
  const isMetadataField = field.startsWith("metadata.");

  if (isMetadataField) {
    const metadataKey = field.split(".")[1];
    const metadataCol = entities.metadata;

    // Sort by JSON field text value
    return direction === "asc"
      ? sql`${metadataCol}->>${metadataKey} ASC`
      : sql`${metadataCol}->>${metadataKey} DESC`;
  } else {
    const entityColumns = getTableColumns(entities);
    if (field in entityColumns) {
      const column = entityColumns[field as keyof typeof entityColumns];
      return direction === "asc" ? asc(column) : desc(column);
    }
    return null;
  }
}
