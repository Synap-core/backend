/**
 * Agent Users Router - AI Agent User Management
 *
 * AI agents are first-class users with workspace memberships and role-based permissions.
 * Workspace owners/admins can create, list, update, and remove agent users.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { db, eq, and } from "@synap/database";
import { users, workspaceMembers } from "@synap/database/schema";
import { verifyPermission } from "@synap/database";
import { randomUUID } from "crypto";
import { auditLog } from "../utils/audit-log.js";

export const agentUsersRouter = router({
  /**
   * Create an AI agent user and add it to a workspace
   */
  create: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid(),
        agentType: z.string().min(1).max(50),
        name: z.string().min(1).max(100),
        role: z.enum(["admin", "editor", "viewer"]),
        description: z.string().optional(),
        capabilities: z.array(z.string()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Caller must be owner or admin
      const perm = await verifyPermission({
        db,
        userId: ctx.userId,
        workspace: { id: input.workspaceId },
        requiredPermission: "manage",
      });

      if (!perm.allowed) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: perm.reason || "Only workspace owners and admins can manage agent users",
        });
      }

      const agentId = randomUUID();
      const shortId = agentId.slice(0, 8);
      const email = `agent-${input.agentType}-${shortId}@synap.agent`;

      // Create user record
      await db.insert(users).values({
        id: agentId,
        email,
        name: input.name,
        emailVerified: true,
        userType: "agent",
        agentMetadata: {
          agentType: input.agentType,
          description: input.description,
          createdByUserId: ctx.userId,
          capabilities: input.capabilities,
        },
        timezone: "UTC",
        locale: "en",
      });

      // Add to workspace with specified role
      await db.insert(workspaceMembers).values({
        workspaceId: input.workspaceId,
        userId: agentId,
        role: input.role,
        invitedBy: ctx.userId,
      });

      auditLog({
        subjectType: "agent_user",
        action: "create",
        phase: "completed",
        subjectId: agentId,
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        data: { agentType: input.agentType, name: input.name, role: input.role },
      });

      return {
        id: agentId,
        email,
        name: input.name,
        agentType: input.agentType,
        role: input.role,
      };
    }),

  /**
   * List AI agent users in a workspace
   */
  list: protectedProcedure
    .input(z.object({ workspaceId: z.string().uuid() }))
    .query(async ({ input }) => {
      const results = await db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          agentMetadata: users.agentMetadata,
          role: workspaceMembers.role,
          joinedAt: workspaceMembers.joinedAt,
        })
        .from(users)
        .innerJoin(
          workspaceMembers,
          and(
            eq(workspaceMembers.userId, users.id),
            eq(workspaceMembers.workspaceId, input.workspaceId)
          )
        )
        .where(eq(users.userType, "agent"));

      return results;
    }),

  /**
   * Update an AI agent user
   */
  update: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid(),
        agentUserId: z.string().uuid(),
        name: z.string().min(1).max(100).optional(),
        role: z.enum(["admin", "editor", "viewer"]).optional(),
        description: z.string().optional(),
        capabilities: z.array(z.string()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Caller must be owner or admin
      const perm = await verifyPermission({
        db,
        userId: ctx.userId,
        workspace: { id: input.workspaceId },
        requiredPermission: "manage",
      });

      if (!perm.allowed) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: perm.reason || "Only workspace owners and admins can manage agent users",
        });
      }

      // Verify the target is actually an agent
      const [agent] = await db
        .select()
        .from(users)
        .where(and(eq(users.id, input.agentUserId), eq(users.userType, "agent")))
        .limit(1);

      if (!agent) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Agent user not found" });
      }

      // Update user record
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (input.name) updates.name = input.name;
      if (input.description !== undefined || input.capabilities !== undefined) {
        const existing = (agent.agentMetadata || {}) as Record<string, unknown>;
        updates.agentMetadata = {
          ...existing,
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.capabilities !== undefined ? { capabilities: input.capabilities } : {}),
        };
      }

      await db.update(users).set(updates).where(eq(users.id, input.agentUserId));

      // Update role if changed
      if (input.role) {
        await db
          .update(workspaceMembers)
          .set({ role: input.role })
          .where(
            and(
              eq(workspaceMembers.userId, input.agentUserId),
              eq(workspaceMembers.workspaceId, input.workspaceId)
            )
          );
      }

      auditLog({
        subjectType: "agent_user",
        action: "update",
        phase: "completed",
        subjectId: input.agentUserId,
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        data: { name: input.name, role: input.role },
      });

      return { status: "updated" as const };
    }),

  /**
   * Remove an AI agent user from a workspace (and delete the user record)
   */
  remove: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid(),
        agentUserId: z.string().uuid(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Caller must be owner or admin
      const perm = await verifyPermission({
        db,
        userId: ctx.userId,
        workspace: { id: input.workspaceId },
        requiredPermission: "manage",
      });

      if (!perm.allowed) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: perm.reason || "Only workspace owners and admins can manage agent users",
        });
      }

      // Verify the target is actually an agent
      const [agent] = await db
        .select()
        .from(users)
        .where(and(eq(users.id, input.agentUserId), eq(users.userType, "agent")))
        .limit(1);

      if (!agent) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Agent user not found" });
      }

      // Remove workspace membership
      await db
        .delete(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.userId, input.agentUserId),
            eq(workspaceMembers.workspaceId, input.workspaceId)
          )
        );

      // Delete the agent user record (agents are workspace-scoped)
      await db.delete(users).where(eq(users.id, input.agentUserId));

      auditLog({
        subjectType: "agent_user",
        action: "delete",
        phase: "completed",
        subjectId: input.agentUserId,
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        data: { agentType: agent.agentMetadata?.agentType },
      });

      return { status: "removed" as const };
    }),
});
