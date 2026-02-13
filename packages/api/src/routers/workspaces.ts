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
  intelligenceServices,
} from "@synap/database";
import { TRPCError } from "@trpc/server";
import { randomBytes } from "crypto";
import { WorkspaceMemberEvents } from "../lib/event-helpers.js";
import { emitRequestEvent } from "../utils/emit-event.js";

/**
 * Workspace CRUD operations
 */
export const workspacesRouter = router({
  /**
   * Create a new workspace
   */
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        description: z.string().optional(),
        settings: z.record(z.string(), z.unknown()).optional(),
        type: z.enum(["personal", "team", "enterprise"]).default("personal"),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { randomUUID } = await import("crypto");
      const workspaceId = randomUUID();

      await emitRequestEvent({
        subjectType: "workspace",
        action: "create",
        subjectId: workspaceId,
        data: {
          id: workspaceId,
          name: input.name,
          description: input.description,
          type: input.type,
          userId: ctx.userId,
          settings: input.settings,
        },
        userId: ctx.userId,
      });

      return {
        status: "requested",
        message: "Workspace creation requested. It will be created shortly.",
        workspaceId,
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
          eq(workspaceMembers.userId, ctx.userId)
        ),
      });

      if (!membership) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }

      // Ensure default whiteboard exists (for existing workspaces created before this feature)
      // This is a one-time operation per workspace
      // Use static import for better type safety (database package is always available)
      const { ensureDefaultWhiteboard } = await import("@synap/database");
      const whiteboardResult = await ensureDefaultWhiteboard(
        input.id,
        ctx.userId
      );

      // Log for debugging
      console.log(
        `[workspaces.get] ensureDefaultWhiteboard result:`,
        whiteboardResult.status,
        whiteboardResult.message,
        whiteboardResult.whiteboardId
      );

      // If whiteboard creation failed, log error but don't fail the workspace fetch
      // Frontend will handle missing whiteboard gracefully
      if (whiteboardResult.status === "error") {
        console.error(
          `[workspaces.get] Failed to ensure default whiteboard for workspace ${input.id}:`,
          whiteboardResult.message,
          whiteboardResult.error
        );
        // ⚠️ Note: We still return the workspace, but without mainWhiteboardId
        // Frontend should handle this case and show appropriate error/retry UI
      }

      // If whiteboard was just created, refetch workspace to get updated settings
      if (whiteboardResult.status === "created") {
        const updatedWorkspace = await db.query.workspaces.findFirst({
          where: eq(workspaces.id, input.id),
        });
        if (updatedWorkspace) {
          console.log(
            `[workspaces.get] Whiteboard created, returning updated workspace with mainWhiteboardId:`,
            (updatedWorkspace.settings as any)?.mainWhiteboardId
          );
          return { ...updatedWorkspace, role: membership.role };
        }
      }

      // Return workspace (may or may not have mainWhiteboardId depending on whiteboard creation status)
      // Frontend should check for mainWhiteboardId and handle missing whiteboard case
      return { ...workspace, role: membership.role };
    }),

  /**
   * Update workspace
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().min(1).max(100).optional(),
        description: z.string().optional(),
        settings: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      await emitRequestEvent({
        subjectType: "workspace",
        action: "update",
        subjectId: input.id,
        data: {
          id: input.id,
          name: input.name,
          description: input.description,
          settings: input.settings,
          userId: ctx.userId,
        },
        userId: ctx.userId,
      });

      return {
        status: "requested",
        message: "Workspace update requested",
      };
    }),

  /**
   * Set intelligence service for workspace (owner/admin only)
   */
  setIntelligenceService: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid(),
        serviceId: z.string().nullable(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, input.workspaceId),
          eq(workspaceMembers.userId, ctx.userId)
        ),
      });

      if (!membership) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Access denied",
        });
      }

      if (membership.role !== "owner" && membership.role !== "admin") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "Only workspace owner or admin can change intelligence service",
        });
      }

      const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, input.workspaceId),
      });

      if (!workspace) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Workspace not found",
        });
      }

      if (input.serviceId && input.serviceId !== "default") {
        const service = await db.query.intelligenceServices.findFirst({
          where: and(
            eq(intelligenceServices.serviceId, input.serviceId),
            eq(intelligenceServices.status, "active")
          ),
        });
        if (!service) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Intelligence service not found or not active",
          });
        }
      }

      const currentSettings = (workspace.settings || {}) as Record<
        string,
        unknown
      >;
      const mergedSettings = {
        ...currentSettings,
        intelligenceServiceId: input.serviceId ?? undefined,
      };

      await emitRequestEvent({
        subjectType: "workspace",
        action: "update",
        subjectId: input.workspaceId,
        data: {
          id: input.workspaceId,
          name: workspace.name,
          settings: mergedSettings,
          userId: ctx.userId,
        },
        userId: ctx.userId,
      });

      return {
        status: "requested",
        message: "Intelligence service update requested",
      };
    }),

  /**
   * Delete workspace
   */
  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      await emitRequestEvent({
        subjectType: "workspace",
        action: "delete",
        subjectId: input.id,
        data: {
          id: input.id,
          userId: ctx.userId,
        },
        userId: ctx.userId,
      });

      return {
        status: "requested",
        message:
          "Workspace deletion requested. Only the owner can approve this.",
      };
    }),

  /**
   * Add member to workspace
   * Event-driven: emits workspaceMembers.add.requested
   */
  addMember: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid(),
        userId: z.string(),
        role: z.enum(["owner", "editor", "viewer"]),
      })
    )
    .mutation(async ({ input, ctx }) => {
      await emitRequestEvent({
        subjectType: "workspaceMember",
        action: "add",
        subjectId: `${input.workspaceId}-${input.userId}`,
        data: {
          workspaceId: input.workspaceId,
          targetUserId: input.userId,
          role: input.role,
          invitedBy: ctx.userId,
        },
        userId: ctx.userId,
        workspaceId: input.workspaceId,
      });

      return {
        status: "requested",
        message: "Member addition requested",
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
          eq(workspaceMembers.userId, ctx.userId)
        ),
      });

      if (!membership) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }

      return await db.query.workspaceMembers.findMany({
        where: eq(workspaceMembers.workspaceId, input.workspaceId),
        orderBy: [desc(workspaceMembers.joinedAt)],
        with: { user: true },
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
      })
    )
    .mutation(async ({ input, ctx }) => {
      await emitRequestEvent({
        subjectType: "workspaceMember",
        action: "remove",
        subjectId: `${input.workspaceId}-${input.userId}`,
        data: {
          workspaceId: input.workspaceId,
          targetUserId: input.userId,
        },
        userId: ctx.userId,
        workspaceId: input.workspaceId,
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
      })
    )
    .mutation(async ({ input, ctx }) => {
      await emitRequestEvent({
        subjectType: "workspaceMember",
        action: "updateRole",
        subjectId: `${input.workspaceId}-${input.userId}`,
        data: {
          workspaceId: input.workspaceId,
          targetUserId: input.userId,
          newRole: input.role,
        },
        userId: ctx.userId,
        workspaceId: input.workspaceId,
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
      z.object({
        workspaceId: z.string().uuid(),
        email: z.string().email(),
        role: z.enum(["admin", "editor", "viewer"]),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Check user is owner/admin
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, input.workspaceId),
          eq(workspaceMembers.userId, ctx.userId)
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
          eq(workspaceMembers.userId, ctx.userId)
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

      await emitRequestEvent({
        subjectType: "workspaceMember",
        action: "add",
        subjectId: `${invite.workspaceId}-${ctx.userId}`,
        data: {
          workspaceId: invite.workspaceId,
          userId: ctx.userId,
          role: invite.role,
          invitedBy: invite.invitedBy,
          inviteId: invite.id,
        },
        userId: ctx.userId,
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
          eq(workspaceMembers.userId, ctx.userId)
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
