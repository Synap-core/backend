/**
 * Cell Instances Router
 *
 * Lifecycle management for persisted cell instances (the universal rendering
 * unit). Distinct from `cells.ts` (which handles marketplace ViewFrame cell
 * *type* install into widget_definitions).
 *
 * A cell instance is a concrete, addressable cell living in a workspace:
 *   - config-only cells (the common case), or
 *   - content cells whose versioned HTML/markdown lives in a `documents` row
 *     (`createHtmlCell` reuses the existing MinIO document path — it does NOT
 *     invent its own storage).
 *
 * Polymorphic relations: `link` creates a relation with a CELL source endpoint
 * and an ENTITY target endpoint, exercising the additive polymorphic columns
 * without disturbing entity↔entity relations.
 */

import { z } from "zod";
import { router, protectedProcedure, workspaceProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import {
  db,
  eq,
  and,
  desc,
  getDb,
  EventRepository,
  RelationRepository,
  RelationDefRepository,
  SYSTEM_RELATION_TYPES,
  sql,
  normalizeDocumentType,
  documents,
  cellInstances,
} from "@synap/database";
import { storage } from "@synap/storage";
import { requireUserId } from "../utils/user-scoped.js";
import { randomUUID } from "crypto";

// ============================================================================
// SCHEMAS
// ============================================================================

const ConfigSchema = z.record(z.string(), z.unknown());

const CreateCellInstanceSchema = z.object({
  cellType: z.string().min(1),
  config: ConfigSchema.optional(),
  name: z.string().optional(),
  isTemplate: z.boolean().optional(),
  sourceDocumentId: z.string().uuid().optional(),
  /** Optional: when omitted, uses X-Workspace-Id header. */
  workspaceId: z.string().uuid().optional(),
});

const CreateHtmlCellSchema = z.object({
  html: z.string(),
  name: z.string().optional(),
  workspaceId: z.string().uuid().optional(),
});

// ============================================================================
// HELPERS
// ============================================================================

/** Shape a row for API consumers (stable contract for the frontend). */
function serialize(row: typeof cellInstances.$inferSelect) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    cellType: row.cellType,
    config: (row.config ?? {}) as Record<string, unknown>,
    name: row.name,
    isTemplate: row.isTemplate,
    sourceDocumentId: row.sourceDocumentId,
    createdByKind: row.createdByKind,
    trustLevel: row.trustLevel,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ============================================================================
// ROUTER
// ============================================================================

export const cellInstancesRouter = router({
  /**
   * Create a cell instance from a cellType + config (the declarative path).
   */
  create: workspaceProcedure
    .input(CreateCellInstanceSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const workspaceId = input.workspaceId ?? ctx.workspaceId ?? null;
      if (!workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Workspace ID required. Pass workspaceId or set active workspace (X-Workspace-Id).",
        });
      }

      const [row] = await db
        .insert(cellInstances)
        .values({
          workspaceId,
          userId,
          cellType: input.cellType,
          config: input.config ?? {},
          name: input.name,
          isTemplate: input.isTemplate ?? false,
          sourceDocumentId: input.sourceDocumentId,
          createdByKind: "user",
          trustLevel: "trusted",
        })
        .returning();

      return serialize(row);
    }),

  /**
   * Create an HTML cell.
   *
   * Reuses the EXISTING document-creation path (MinIO via @synap/storage,
   * mirroring `documents.create` in routers/documents.ts:90-143): build a
   * storage key, upload the html to MinIO, insert a versioned `documents` row,
   * then create a `cell_instances` row of cellType 'html-embed' referencing it.
   * This is the canonical document/MinIO path — no bespoke blob storage.
   */
  createHtmlCell: workspaceProcedure
    .input(CreateHtmlCellSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const workspaceId = input.workspaceId ?? ctx.workspaceId ?? null;
      if (!workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Workspace ID required. Pass workspaceId or set active workspace (X-Workspace-Id).",
        });
      }

      const title = input.name ?? "HTML Cell";

      // 1. Create the backing document via the existing MinIO path.
      const documentId = randomUUID();
      const docType = normalizeDocumentType("text", "text");
      const storageKey = storage.buildPath(
        userId,
        "document",
        documentId,
        "html"
      );
      const metadata = await storage.upload(storageKey, input.html, {
        contentType: "text/html",
      });
      const [document] = await db
        .insert(documents)
        .values({
          id: documentId,
          userId,
          workspaceId,
          title,
          type: docType as "text" | "markdown" | "code" | "pdf" | "docx",
          storageUrl: metadata.url,
          storageKey: metadata.path,
          size: metadata.size,
          mimeType: "text/html",
          currentVersion: 1,
        })
        .returning();

      // 2. Create the html-embed cell referencing the versioned document.
      const [row] = await db
        .insert(cellInstances)
        .values({
          workspaceId,
          userId,
          cellType: "html-embed",
          config: {},
          name: input.name,
          isTemplate: false,
          sourceDocumentId: document.id,
          createdByKind: "user",
          trustLevel: "trusted",
        })
        .returning();

      return serialize(row);
    }),

  /**
   * Get a cell instance by ID (user-scoped).
   */
  get: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const [row] = await db
        .select()
        .from(cellInstances)
        .where(
          and(eq(cellInstances.id, input.id), eq(cellInstances.userId, userId))
        )
        .limit(1);
      if (!row) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Cell instance not found",
        });
      }
      return serialize(row);
    }),

  /**
   * List cell instances in a workspace, optionally filtering by template flag.
   */
  list: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid(),
        isTemplate: z.boolean().optional(),
      })
    )
    .query(async ({ input }) => {
      const where =
        input.isTemplate === undefined
          ? eq(cellInstances.workspaceId, input.workspaceId)
          : and(
              eq(cellInstances.workspaceId, input.workspaceId),
              eq(cellInstances.isTemplate, input.isTemplate)
            );

      const rows = await db
        .select()
        .from(cellInstances)
        .where(where)
        .orderBy(desc(cellInstances.updatedAt));

      return { cellInstances: rows.map(serialize) };
    }),

  /**
   * Replace a cell instance's config.
   */
  updateConfig: protectedProcedure
    .input(z.object({ id: z.string().uuid(), config: ConfigSchema }))
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const [row] = await db
        .update(cellInstances)
        .set({ config: input.config, updatedAt: new Date() })
        .where(
          and(eq(cellInstances.id, input.id), eq(cellInstances.userId, userId))
        )
        .returning();
      if (!row) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Cell instance not found",
        });
      }
      return serialize(row);
    }),

  /**
   * Duplicate a cell instance.
   *
   * Shallow (default): copy config + identity into a new instance.
   * Deep (`deep: true`): additionally clone any child instances referenced in
   * config under `config.instanceIds` (array of cell instance ids), rewriting
   * those references to the freshly-cloned ids. Leaf cells (no instanceIds) are
   * a plain config copy in both modes.
   */
  duplicate: protectedProcedure
    .input(z.object({ id: z.string().uuid(), deep: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      const [source] = await db
        .select()
        .from(cellInstances)
        .where(
          and(eq(cellInstances.id, input.id), eq(cellInstances.userId, userId))
        )
        .limit(1);
      if (!source) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Cell instance not found",
        });
      }

      let newConfig = (source.config ?? {}) as Record<string, unknown>;

      if (input.deep) {
        const childIds = Array.isArray(
          (newConfig as { instanceIds?: unknown }).instanceIds
        )
          ? ((newConfig as { instanceIds: unknown[] }).instanceIds.filter(
              (v): v is string => typeof v === "string"
            ) as string[])
          : [];

        if (childIds.length > 0) {
          const children = await db
            .select()
            .from(cellInstances)
            .where(eq(cellInstances.userId, userId));
          const childMap = new Map(children.map((c) => [c.id, c]));

          const idRewrite: Record<string, string> = {};
          for (const childId of childIds) {
            const child = childMap.get(childId);
            if (!child || child.workspaceId !== source.workspaceId) continue;
            const [clone] = await db
              .insert(cellInstances)
              .values({
                workspaceId: child.workspaceId,
                userId,
                cellType: child.cellType,
                config: (child.config ?? {}) as Record<string, unknown>,
                name: child.name,
                isTemplate: false,
                sourceDocumentId: child.sourceDocumentId,
                createdByKind: "user",
                trustLevel: child.trustLevel,
              })
              .returning();
            idRewrite[childId] = clone.id;
          }

          newConfig = {
            ...newConfig,
            instanceIds: childIds.map((cid) => idRewrite[cid] ?? cid),
          };
        }
      }

      const [duplicate] = await db
        .insert(cellInstances)
        .values({
          workspaceId: source.workspaceId,
          userId,
          cellType: source.cellType,
          config: newConfig,
          name: source.name ? `${source.name} (copy)` : null,
          isTemplate: source.isTemplate,
          sourceDocumentId: source.sourceDocumentId,
          createdByKind: "user",
          trustLevel: source.trustLevel,
        })
        .returning();

      return serialize(duplicate);
    }),

  /**
   * Link a cell instance to an entity via a polymorphic relation.
   *
   * Creates a relation with source=cell (sourceKind='cell', sourceCellId) and
   * target=entity (targetKind='entity', targetEntityId). Exercises the additive
   * polymorphic columns without touching entity↔entity relations.
   */
  link: protectedProcedure
    .input(
      z.object({
        cellId: z.string().uuid(),
        entityId: z.string().uuid(),
        relationType: z.string().min(1).optional(),
        workspaceId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const effectiveWorkspaceId = input.workspaceId || ctx.workspaceId;
      if (!effectiveWorkspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "workspaceId is required (pass in input or set X-Workspace-Id header)",
        });
      }

      const type = input.relationType ?? "references";

      // Validate type: system type OR workspace relation def (mirrors relations.create).
      const isSystemType = (
        SYSTEM_RELATION_TYPES as readonly string[]
      ).includes(type);
      if (!isSystemType) {
        const database = await getDb();
        const relDefRepo = new RelationDefRepository(database);
        const def = await relDefRepo.getBySlug(type, effectiveWorkspaceId);
        if (!def) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Unknown relation type: "${type}". Must be a workspace relation definition.`,
          });
        }
      }

      const database = await getDb();
      const eventRepo = new EventRepository(sql);
      const relationRepo = new RelationRepository(database, eventRepo);

      const relation = await relationRepo.create(
        {
          sourceKind: "cell",
          sourceCellId: input.cellId,
          targetKind: "entity",
          targetEntityId: input.entityId,
          type,
          workspaceId: effectiveWorkspaceId,
          userId,
        },
        userId
      );

      return { id: relation.id, status: "created" as const };
    }),
});
