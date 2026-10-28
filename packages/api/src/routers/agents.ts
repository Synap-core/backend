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
import {
  router,
  workspaceProcedure,
  podProcedure,
  assertPodAdmin,
} from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { db, eq, ne, desc, or, and, verifyPermission } from "@synap/database";
import { agents } from "@synap/database/schema";
import { ownAdjunctFilter } from "../services/agent-identity-service.js";
import { isPodAdmin } from "../utils/workspace-role.js";
import { randomUUID } from "crypto";

/** The slug every chat fallback resolves to; never a user-owned agent's. */
const ORCHESTRATOR_SLUG = "orchestrator";

/**
 * What a caller may READ in the catalog: the shared built-ins
 * (system / provider) and their OWN user-owned adjuncts. The same predicate
 * `getById` and `workspaceList` apply.
 */
function visibleAgentFilter(userId: string) {
  return or(
    eq(agents.ownerType, "system"),
    eq(agents.ownerType, "provider"),
    ownAdjunctFilter(userId)
  );
}

/**
 * Load the agent row a caller may WRITE (audit 2026-10-28, pod-routers F1).
 *
 * `agents` rows are POD-GLOBAL (no workspace column), so the caller's
 * "manage" role in the header workspace says nothing about a row. The writer
 * is the person whose adjunct it is (`ownAdjunctFilter`), or a pod admin for
 * everything else: the shared system / provider rows (the orchestrator among
 * them) and rows with no owner. Another person's private adjunct reads as
 * NOT_FOUND (it is not visible to them); a shared row as FORBIDDEN.
 */
async function loadWritableAgent(userId: string, id: string) {
  const [own] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, id), ownAdjunctFilter(userId)))
    .limit(1);
  if (own) return own;

  const existing = await db.query.agents.findFirst({
    where: eq(agents.id, id),
  });
  const shared =
    existing?.ownerType === "system" || existing?.ownerType === "provider";
  if (!existing || (!shared && !(await isPodAdmin(userId)))) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Agent ${id} not found`,
    });
  }
  await assertPodAdmin(userId);
  return existing;
}

/**
 * A slug is held by at most ONE active agent, whatever its owner: chat paths
 * resolve a slug with `.limit(1)` and no order (`resolveSlugToAgentId`), so a
 * second holder makes the resolution nondeterministic. `orchestrator` is
 * reserved to the row that already holds it.
 */
async function assertSlugFree(slug: string, exceptId?: string) {
  if (slug === ORCHESTRATOR_SLUG) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `Agent slug '${slug}' is reserved`,
    });
  }
  const holder = await db.query.agents.findFirst({
    where: and(
      eq(agents.slug, slug),
      eq(agents.active, true),
      exceptId ? ne(agents.id, exceptId) : undefined
    ),
    columns: { id: true },
  });
  if (holder) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `Agent slug '${slug}' already exists`,
    });
  }
}

/**
 * List visible agents (signed-in caller): the shared system / provider
 * agents and the caller's own adjuncts, never another person's.
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
    .query(async ({ input, ctx }) => {
      // Never another person's private adjunct (audit F2): the same floor
      // getById / workspaceList apply, AND-ed with the caller's filters.
      const conditions = [
        visibleAgentFilter(ctx.userId),
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
        .where(and(...conditions))
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
      // `user`-owned agents are PRIVATE local/CLI adjuncts — scoped to the caller
      // via the canonical owner predicate (owner = the actor's `createdByUserId`,
      // NOT `agents.userId`, which is the actor id). One door: `ownAdjunctFilter`.
      const ownAdjuncts = ownAdjunctFilter(ctx.userId);
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
  getById: podProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      // Single-object read: user-floor visibility, lens-free. system/provider
      // agents are shared; user-owned agents are private to their owner. The
      // previous query had NO ownership predicate — it returned any user's
      // private agent by id once the (now-removed) workspace precondition passed.
      const [agent] = await db
        .select()
        .from(agents)
        .where(and(eq(agents.id, input.id), visibleAgentFilter(ctx.userId)))
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

      await assertSlugFree(input.slug);

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

      const existing = await loadWritableAgent(ctx.userId, input.id);
      if (input.slug !== undefined && input.slug !== existing.slug) {
        await assertSlugFree(input.slug, existing.id);
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

      const existing = await loadWritableAgent(ctx.userId, input.id);

      if (existing.ownerType !== "user") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Cannot delete system or provider agents",
        });
      }

      if (existing.slug === ORCHESTRATOR_SLUG) {
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
