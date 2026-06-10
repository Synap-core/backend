/**
 * Agents Router — tRPC routes for the agent identity layer.
 *
 * Public (podProcedure = auth optional):
 *  - agents.list    — list visible agents
 *
 * Protected (workspaceProcedure):
 *  - agents.workspaceList — workspace-scoped agent list
 *  - agents.getById/:id   — individual agent detail
 */

import { z } from "zod";
import { router, workspaceProcedure, podProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { db, eq, desc, or, and, verifyPermission } from "@synap/database";
import { agents } from "@synap/database/schema";
import { randomUUID } from "crypto";

/**
 * List visible agents — public listing (Pod Procedure).
 * Auth: optional (works for anonymous discovery of marketplace agents).
 */
export const agentsRouter = router({
  list: podProcedure
    .input(
      z.object({
        intelligenceServiceId: z.string().uuid().optional(),
        ownerType: z.enum(["system", "user", "provider"]).optional(),
        active: z.boolean().optional(),
      })
    )
    .query(async ({ input }) => {
      const conditions = [
        input.intelligenceServiceId
          ? eq(agents.intelligenceServiceId, input.intelligenceServiceId)
          : undefined,
        input.ownerType ? eq(agents.ownerType, input.ownerType) : undefined,
        input.active !== undefined
          ? eq(agents.active, input.active)
          : undefined,
      ].filter(Boolean) as Parameters<typeof and>;

      return db
        .select()
        .from(agents)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(agents.createdAt));
    }),

  /**
   * Workspace-scoped agent list (authenticated).
   * Default: show system + provider + user agents.
   *
   * `user`-owned agents are the local/CLI ADJUNCTS — registry rows created by
   * the terminal when a local agent CLI (claude/codex/opencode) runs. Including
   * them here makes them first-class in the agent picker / management UI so the
   * user can discover, select, and @-mention them. Their "conversation" is the
   * terminal-cell (Option A, terminal-routed) — see the renderer-side wiring.
   */
  workspaceList: workspaceProcedure
    .input(
      z.object({
        ownerType: z.enum(["system", "provider", "user"]).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      // `system` + `provider` agents are SHARED (visible to everyone).
      // `user`-owned agents are PRIVATE local/CLI adjuncts — they MUST be
      // scoped to the requesting user, or one user's adjuncts leak into every
      // other user's picker. Filter by USER, never by ownerType alone.
      const ownAdjuncts = and(
        eq(agents.ownerType, "user"),
        eq(agents.userId, ctx.userId)
      );
      const ownerFilter =
        input.ownerType === "user"
          ? ownAdjuncts
          : input.ownerType
            ? eq(agents.ownerType, input.ownerType) // system | provider — shared
            : or(
                eq(agents.ownerType, "system"),
                eq(agents.ownerType, "provider"),
                ownAdjuncts
              );

      return db
        .select()
        .from(agents)
        .where(ownerFilter)
        .orderBy(desc(agents.createdAt));
    }),

  /**
   * Get a single agent by ID (workspace-scoped).
   */
  getById: workspaceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input }) => {
      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, input.id))
        .limit(1);

      if (!agent) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Agent ${input.id} not found`,
        });
      }

      return agent;
    }),

  /**
   * Create a user-owned agent (workspace-scoped).
   */
  create: workspaceProcedure
    .input(
      z.object({
        name: z.string().min(1).max(200),
        slug: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[\w:.-]+$/),
        description: z.string().max(1000).optional(),
        capabilities: z.array(z.string()).optional(),
        intelligenceServiceId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const perm = await verifyPermission({
        db,
        userId: ctx.userId,
        workspace: { id: ctx.workspaceId },
        requiredPermission: "manage",
      });
      if (!perm.allowed) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Workspace manager role required to create agents.",
        });
      }

      const existing = await db.query.agents.findFirst({
        where: and(
          eq(agents.slug, input.slug),
          eq(agents.ownerType, "user"),
          eq(agents.active, true)
        ),
      });

      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Agent slug '${input.slug}' already exists`,
        });
      }

      const [agent] = await db
        .insert(agents)
        .values({
          id: randomUUID(),
          name: input.name,
          slug: input.slug,
          description: input.description ?? null,
          capabilities: input.capabilities ?? [],
          intelligenceServiceId: input.intelligenceServiceId ?? null,
          ownerType: "user",
          active: true,
        })
        .returning();

      return agent;
    }),

  /**
   * Update an agent (workspace-scoped).
   */
  update: workspaceProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().min(1).max(200).optional(),
        slug: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[\w:.-]+$/)
          .optional(),
        description: z.string().max(1000).optional(),
        capabilities: z.array(z.string()).optional(),
        intelligenceServiceId: z.string().uuid().optional(),
        active: z.boolean().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const perm = await verifyPermission({
        db,
        userId: ctx.userId,
        workspace: { id: ctx.workspaceId },
        requiredPermission: "manage",
      });
      if (!perm.allowed) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Workspace manager role required to update agents.",
        });
      }

      const existing = await db.query.agents.findFirst({
        where: eq(agents.id, input.id),
      });

      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Agent ${input.id} not found`,
        });
      }

      const updates: Record<string, unknown> = {};
      if (input.name !== undefined) updates.name = input.name;
      if (input.slug !== undefined) updates.slug = input.slug;
      if (input.description !== undefined)
        updates.description = input.description;
      if (input.capabilities !== undefined)
        updates.capabilities = input.capabilities;
      if (input.intelligenceServiceId !== undefined)
        updates.intelligenceServiceId = input.intelligenceServiceId;
      if (input.active !== undefined) updates.active = input.active;

      if (Object.keys(updates).length === 0) {
        return existing;
      }

      const [updated] = await db
        .update(agents)
        .set(updates)
        .where(eq(agents.id, input.id))
        .returning();

      return updated;
    }),

  /**
   * Delete (deactivate) an agent (workspace-scoped).
   */
  delete: workspaceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const perm = await verifyPermission({
        db,
        userId: ctx.userId,
        workspace: { id: ctx.workspaceId },
        requiredPermission: "manage",
      });
      if (!perm.allowed) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Workspace manager role required to delete agents.",
        });
      }

      const existing = await db.query.agents.findFirst({
        where: eq(agents.id, input.id),
      });

      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Agent ${input.id} not found`,
        });
      }

      if (existing.ownerType !== "user") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Cannot delete system or provider agents",
        });
      }

      if (existing.slug === "orchestrator") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Cannot delete the orchestrator agent",
        });
      }

      await db
        .update(agents)
        .set({ active: false })
        .where(eq(agents.id, input.id));

      return { success: true };
    }),
});
