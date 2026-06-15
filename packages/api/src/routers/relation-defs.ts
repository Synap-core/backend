/**
 * Relation Definitions Router - Workspace-scoped relation type API
 *
 * Manages custom relation type definitions (e.g., "works_at", "manages").
 */

import { z } from "zod";
import { router, workspaceProcedure, podProcedure } from "../trpc.js";
import { getDb, RelationDefRepository, asc } from "@synap/database";
import { relationDefs } from "@synap/database/schema";
import { TRPCError } from "@trpc/server";
import { createLogger } from "@synap-core/core";
import { auditLog } from "../utils/audit-log.js";
import { scopedDb, AccessContext } from "../access/index.js";

const logger = createLogger({ module: "relation-defs-router" });

export const relationDefsRouter = router({
  /**
   * List all relation definitions for the current workspace
   */
  // Workspace is a LENS here: an active workspace → that workspace's defs +
  // pod-wide base defs; no workspace (pod-wide/agent caller) → base defs only
  // (`?? null`, consistent with widget-definitions/intelligence) instead of the
  // old "Workspace ID required" 400. Scoping is the registered `workspace` rule
  // (substrate: includeGlobalsInLens), applied centrally by scopedDb.
  list: podProcedure.query(async ({ ctx }) => {
    const defs = await scopedDb(
      AccessContext.from(ctx).withLens(ctx.workspaceId ?? null)
    ).findMany<typeof relationDefs.$inferSelect>(relationDefs, {
      orderBy: [asc(relationDefs.slug)],
    });
    return { relationDefs: defs };
  }),

  /**
   * Create a custom relation definition
   */
  create: workspaceProcedure
    .input(
      z.object({
        slug: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[a-z][a-z0-9_]*$/),
        displayName: z.string().min(1).max(100),
        description: z.string().optional(),
        uiHints: z.record(z.string(), z.unknown()).optional(),
        isDirectional: z.boolean().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      const repo = new RelationDefRepository(db);

      const def = await repo.create({
        slug: input.slug,
        displayName: input.displayName,
        description: input.description,
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        uiHints: input.uiHints,
        isDirectional: input.isDirectional,
      });

      auditLog({
        subjectType: "relation_def",
        action: "create",
        phase: "completed",
        subjectId: def.id,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        data: { slug: def.slug, displayName: def.displayName },
      });

      logger.info(
        { id: def.id, slug: def.slug, userId: ctx.userId },
        "Relation definition created"
      );

      return { relationDef: def };
    }),

  /**
   * Update an existing relation definition
   */
  update: workspaceProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        displayName: z.string().min(1).max(100).optional(),
        description: z.string().optional(),
        uiHints: z.record(z.string(), z.unknown()).optional(),
        isDirectional: z.boolean().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      const repo = new RelationDefRepository(db);

      const def = await repo.update(input.id, ctx.workspaceId, {
        displayName: input.displayName,
        description: input.description,
        uiHints: input.uiHints,
        isDirectional: input.isDirectional,
      });

      auditLog({
        subjectType: "relation_def",
        action: "update",
        phase: "completed",
        subjectId: def.id,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        data: { slug: def.slug, displayName: def.displayName },
      });

      logger.info(
        { id: def.id, slug: def.slug, userId: ctx.userId },
        "Relation definition updated"
      );

      return { relationDef: def };
    }),

  /**
   * Delete a relation definition (owner/admin only)
   */
  delete: workspaceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      if (!["owner", "admin"].includes(ctx.workspaceRole)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "Only workspace owners/admins can delete relation definitions",
        });
      }

      const db = await getDb();
      const repo = new RelationDefRepository(db);
      await repo.delete(input.id);

      auditLog({
        subjectType: "relation_def",
        action: "delete",
        phase: "completed",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        data: { id: input.id },
      });

      logger.info(
        { id: input.id, userId: ctx.userId },
        "Relation definition deleted"
      );

      return { success: true };
    }),
});
