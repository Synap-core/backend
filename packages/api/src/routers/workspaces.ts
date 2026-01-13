/**
 * Workspaces Router - Multi-user workspace management
 *
 * Handles:
 * - Workspace CRUD
 * - Member management
 * - Invitation system
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import {
  db,
  eq,
  and,
  desc,
  workspaces,
  workspaceMembers,
  workspaceInvites,
  insertWorkspaceSchema,
  insertWorkspaceInviteSchema,
} from "@synap/database";
import { TRPCError } from "@trpc/server";
import { randomBytes } from "crypto";
import { WorkspaceMemberEvents } from "../lib/event-helpers.js";

/**
 * Workspace CRUD operations
 */
export const workspacesRouter = router({
  /**
   * Create a new workspace
   */
  create: protectedProcedure
    .input(
      insertWorkspaceSchema
        .pick({
          name: true,
          description: true,
          settings: true,
        })
        .extend({
          name: z.string().min(1).max(100),
          type: z.enum(["personal", "team", "enterprise"]).default("personal"),
        }),
    )
    .mutation(async ({ input, ctx }) => {
      // ✅ Publish .requested event - worker will create workspace
      const { inngest } = await import("@synap/jobs");

      await inngest.send({
        name: "workspaces.create.requested",
        data: {
          name: input.name,
          description: input.description,
          type: input.type,
          userId: ctx.userId,
        },
        user: { id: ctx.userId },
      });

      return {
        status: "requested",
        message: "Workspace creation requested. It will be created shortly.",
      };
    }),

  /**
   * List user's workspaces
   */
  list: protectedProcedure.query(async ({ ctx }) => {
    const memberships = await db.query.workspaceMembers.findMany({
      where: eq(workspaceMembers.userId, ctx.userId),
      with: {
        workspace: true,
      },
    });

    return memberships.map((m) => {
      const workspace = m.workspace!;
      return {
        ...workspace,
        role: m.role,
        joinedAt: m.joinedAt,
      };
    });
  }),

  /**
   * Get workspace details
   */
  get: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, input.id),
      });

      if (!workspace) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Workspace not found",
        });
      }

      // Check user has access
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, input.id),
          eq(workspaceMembers.userId, ctx.userId),
        ),
      });

      if (!membership) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }

      return { ...workspace, role: membership.role };
    }),

  /**
   * Update workspace
   */
  update: protectedProcedure
    .input(
      insertWorkspaceSchema
        .pick({
          name: true,
          description: true,
          settings: true,
        })
        .partial()
        .extend({
          id: z.string().uuid(),
          name: z.string().min(1).max(100).optional(),
        }),
    )
    .mutation(async ({ input, ctx }) => {
      // ✅ Publish .requested event - permission validator will check permissions
      const { inngest } = await import("@synap/jobs");

      await inngest.send({
        name: "workspaces.update.requested",
        data: {
          workspaceId: input.id,
          name: input.name,
          description: input.description,
          settings: input.settings,
          userId: ctx.userId,
        },
        user: { id: ctx.userId },
      });

      return {
        status: "requested",
        message: "Workspace update requested",
      };
    }),

  /**
   * Delete workspace
   */
  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      // ✅ Publish .requested event - permission validator enforces owner-only
      const { inngest } = await import("@synap/jobs");

      await inngest.send({
        name: "workspaces.delete.requested",
        data: {
          workspaceId: input.id,
          userId: ctx.userId,
        },
        user: { id: ctx.userId },
      });

      return {
        status: "requested",
        message:
          "Workspace deletion requested. Only the owner can approve this.",
      };
    }),

  /**
   * List workspace members
   */
  listMembers: protectedProcedure
    .input(z.object({ workspaceId: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      // Check user has access to workspace
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, input.workspaceId),
          eq(workspaceMembers.userId, ctx.userId),
        ),
      });

      if (!membership) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }

      return await db.query.workspaceMembers.findMany({
        where: eq(workspaceMembers.workspaceId, input.workspaceId),
        orderBy: [desc(workspaceMembers.joinedAt)],
      });
    }),

  /**
   * Remove member from workspace
   */
  removeMember: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid(),
        userId: z.string(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // ✅ Publish .requested event
      const { inngest } = await import("@synap/jobs");

      await inngest.send({
        name: "workspaceMembers.remove.requested",
        data: {
          workspaceId: input.workspaceId,
          targetUserId: input.userId,
          userId: ctx.userId,
        },
        user: { id: ctx.userId },
      });

      return {
        status: "requested",
        message: "Member removal requested",
      };
    }),

  /**
   * Update member role
   */
  updateMemberRole: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid(),
        userId: z.string(),
        role: z.enum(["admin", "editor", "viewer"]),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // ✅ Publish .requested event
      const { inngest } = await import("@synap/jobs");

      await inngest.send({
        name: "workspaceMembers.updateRole.requested",
        data: {
          workspaceId: input.workspaceId,
          targetUserId: input.userId,
          newRole: input.role,
          userId: ctx.userId,
        },
        user: { id: ctx.userId },
      });

      return {
        status: "requested",
        message: "Role update requested",
      };
    }),

  /**
   * Create invitation
   */
  createInvite: protectedProcedure
    .input(
      insertWorkspaceInviteSchema
        .pick({
          workspaceId: true,
          email: true,
          role: true,
        })
        .extend({
          role: z.enum(["admin", "editor", "viewer"]),
        }),
    )
    .mutation(async ({ input, ctx }) => {
      // Check user is owner/admin
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, input.workspaceId),
          eq(workspaceMembers.userId, ctx.userId),
        ),
      });

      if (!membership || !["owner", "admin"].includes(membership.role)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only owners/admins can invite",
        });
      }

      // Log requested event
      await WorkspaceMemberEvents.inviteRequested(ctx.userId, {
        ...input,
        role: input.role as any,
      });

      // Generate token
      const token = randomBytes(32).toString("hex");

      // Create invite
      const [invite] = await db
        .insert(workspaceInvites)
        .values({
          workspaceId: input.workspaceId,
          email: input.email,
          role: input.role,
          token,
          invitedBy: ctx.userId,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
        } as any)
        .returning();

      // Log validated event (invite created)
      await WorkspaceMemberEvents.inviteValidated(ctx.userId, {
        id: invite.id,
        workspaceId: invite.workspaceId,
        userId: invite.email, // Email as placeholder until accepted
        role: invite.role,
      });

      // TODO: Send email via Inngest job
      // await inngest.send({ name: 'workspace/invite', data: { inviteId: invite.id } });

      return invite;
    }),

  /**
   * List pending invites
   */
  listInvites: protectedProcedure
    .input(z.object({ workspaceId: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      // Check user has access
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, input.workspaceId),
          eq(workspaceMembers.userId, ctx.userId),
        ),
      });

      if (!membership) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }

      return await db.query.workspaceInvites.findMany({
        where: eq(workspaceInvites.workspaceId, input.workspaceId),
        orderBy: [desc(workspaceInvites.createdAt)],
      });
    }),

  /**
   * Accept invitation
   */
  acceptInvite: protectedProcedure
    .input(z.object({ token: z.string() }))
    .mutation(async ({ input, ctx }) => {
      // Verify invite exists and is valid
      const invite = await db.query.workspaceInvites.findFirst({
        where: eq(workspaceInvites.token, input.token),
      });

      if (!invite) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Invite not found" });
      }

      if (invite.expiresAt < new Date()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Invite expired" });
      }

      // ✅ Publish .requested event
      const { inngest } = await import("@synap/jobs");

      await inngest.send({
        name: "workspaceMembers.add.requested",
        data: {
          workspaceId: invite.workspaceId,
          targetUserId: ctx.userId,
          role: invite.role,
          invitedBy: invite.invitedBy,
          inviteId: invite.id,
          userId: ctx.userId,
        },
        user: { id: ctx.userId },
      });

      return {
        status: "requested",
        workspaceId: invite.workspaceId,
        message: "Invite acceptance requested",
      };
    }),

  /**
   * Revoke invitation
   */
  revokeInvite: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const invite = await db.query.workspaceInvites.findFirst({
        where: eq(workspaceInvites.id, input.id),
      });

      if (!invite) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Invite not found" });
      }

      // Check user is owner/admin
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, invite.workspaceId),
          eq(workspaceMembers.userId, ctx.userId),
        ),
      });

      if (!membership || !["owner", "admin"].includes(membership.role)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only owners/admins can revoke invites",
        });
      }

      await db
        .delete(workspaceInvites)
        .where(eq(workspaceInvites.id, input.id));

      return { success: true };
    }),
});
