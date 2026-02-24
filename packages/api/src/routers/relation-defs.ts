/**
 * Relation Definitions Router - Workspace-scoped relation type API
 *
 * Manages custom relation type definitions (e.g., "works_at", "manages").
 */

import { z } from "zod";
import { router, workspaceProcedure } from "../trpc.js";
import { getDb, RelationDefRepository } from "@synap/database";
import { TRPCError } from "@trpc/server";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "relation-defs-router" });

export const relationDefsRouter = router({
  /**
   * List all relation definitions for the current workspace
   */
  list: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    const repo = new RelationDefRepository(db);
    const defs = await repo.list(ctx.workspaceId);
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

      logger.info(
        { id: def.id, slug: def.slug, userId: ctx.userId },
        "Relation definition created"
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

      logger.info(
        { id: input.id, userId: ctx.userId },
        "Relation definition deleted"
      );

      return { success: true };
    }),
});
