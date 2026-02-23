/**
 * Workspaces Router - Multi-user workspace management
 *
 * Handles:
 * - Workspace CRUD (synchronous)
 * - Member management (synchronous)
 * - Invitation system
 */

import { z } from "zod";
import { router, protectedProcedure, publicProcedure } from "../trpc.js";
import {
  db,
  eq,
  and,
  desc,
  workspaces,
  workspaceMembers,
  workspaceInvites,
  intelligenceServices,
  getDb,
  EventRepository,
  WorkspaceRepository,
  WorkspaceMemberRepository,
  sql,
  users,
} from "@synap/database";
import { TRPCError } from "@trpc/server";
import { randomBytes } from "crypto";
import { WorkspaceMemberEvents } from "../lib/event-helpers.js";
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import { auditLog } from "../utils/audit-log.js";
import { emitSideEffects, getBoss } from "@synap/jobs";
import { config } from "@synap-core/core";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "workspaces" });

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

      // 1. Permission check (no workspaceId yet → auto-granted for personal)
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        subjectType: "workspaces",
        action: "create",
        data: {
          id: workspaceId,
          name: input.name,
          description: input.description,
          type: input.type,
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("granted" in perm && !perm.granted) {
        return {
          status: "proposed" as const,
          proposalId: perm.proposalId,
          message: "Workspace creation requires approval.",
        };
      }

      // 2. Direct DB operation
      const dbConn = await getDb();
      const eventRepo = new EventRepository(sql);
      const workspaceRepo = new WorkspaceRepository(dbConn, eventRepo);

      const created = await workspaceRepo.create(
        {
          id: workspaceId,
          name: input.name,
          ownerId: ctx.userId,
          settings: input.settings || {},
        },
        ctx.userId
      );

      // 3. Audit log
      auditLog({
        subjectType: "workspaces",
        action: "create",
        phase: "completed",
        subjectId: workspaceId,
        userId: ctx.userId,
        data: {
          id: workspaceId,
          name: input.name,
          description: input.description,
          type: input.type,
        },
      });

      // 4. Side-effects
      emitSideEffects({
        subjectType: "workspace",
        action: "create",
        subjectId: workspaceId,
        userId: ctx.userId,
      });

      // 5. Enqueue workspace-init for default whiteboard/views/commands
      try {
        const boss = getBoss();
        await boss.send("workspace-init", {
          workspaceId,
          userId: ctx.userId,
        });
      } catch (err) {
        console.warn(
          "[workspaces.create] Failed to enqueue workspace-init (non-fatal):",
          err
        );
      }

      return {
        status: "created" as const,
        workspaceId: created.id,
        message: "Workspace created successfully.",
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

      // Ensure default workspace setup (for existing workspaces created before these features)
      // These are one-time operations per workspace - same pattern as whiteboard
      const {
        ensureDefaultWhiteboard,
        ensureDefaultViews,
        ensureDefaultCommands,
      } = await import("@synap/database");

      const whiteboardResult = await ensureDefaultWhiteboard(
        input.id,
        ctx.userId
      );
      console.log(
        `[workspaces.get] ensureDefaultWhiteboard:`,
        whiteboardResult.status,
        whiteboardResult.message
      );
      if (whiteboardResult.status === "error") {
        console.error(
          `[workspaces.get] Failed to ensure default whiteboard:`,
          whiteboardResult.message,
          whiteboardResult.error
        );
      }

      const viewsResult = await ensureDefaultViews(input.id, ctx.userId);
      console.log(
        `[workspaces.get] ensureDefaultViews:`,
        viewsResult.status,
        viewsResult.message
      );
      if (viewsResult.status === "error") {
        console.error(
          `[workspaces.get] Failed to ensure default views:`,
          viewsResult.message,
          viewsResult.error
        );
      }

      const commandsResult = await ensureDefaultCommands(input.id, ctx.userId);
      console.log(
        `[workspaces.get] ensureDefaultCommands:`,
        commandsResult.status,
        commandsResult.message
      );
      if (commandsResult.status === "error") {
        console.error(
          `[workspaces.get] Failed to ensure default commands:`,
          commandsResult.message,
          commandsResult.error
        );
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
      // 1. Permission check
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: input.id,
        subjectType: "workspaces",
        action: "update",
        data: {
          id: input.id,
          name: input.name,
          description: input.description,
          settings: input.settings,
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("granted" in perm && !perm.granted) {
        return {
          status: "proposed" as const,
          proposalId: perm.proposalId,
          message: "Workspace update requires approval.",
        };
      }

      // 2. Direct DB operation
      const dbConn = await getDb();
      const eventRepo = new EventRepository(sql);
      const workspaceRepo = new WorkspaceRepository(dbConn, eventRepo);

      await workspaceRepo.update(
        input.id,
        {
          name: input.name || undefined,
          settings: input.settings || undefined,
        },
        ctx.userId
      );

      // 3. Audit log
      auditLog({
        subjectType: "workspaces",
        action: "update",
        phase: "completed",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: input.id,
        data: {
          id: input.id,
          name: input.name,
          description: input.description,
          settings: input.settings,
        },
      });

      // 4. Side-effects
      emitSideEffects({
        subjectType: "workspace",
        action: "update",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: input.id,
      });

      return {
        status: "updated" as const,
        message: "Workspace updated successfully.",
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

      // 1. Permission check
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        subjectType: "workspaces",
        action: "update",
        data: {
          id: input.workspaceId,
          settings: mergedSettings,
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("granted" in perm && !perm.granted) {
        return {
          status: "proposed" as const,
          proposalId: perm.proposalId,
          message: "Intelligence service update requires approval.",
        };
      }

      // 2. Direct DB operation
      const dbConn = await getDb();
      const eventRepo = new EventRepository(sql);
      const workspaceRepo = new WorkspaceRepository(dbConn, eventRepo);

      await workspaceRepo.update(
        input.workspaceId,
        {
          name: workspace.name,
          settings: mergedSettings,
        },
        ctx.userId
      );

      // 3. Audit log
      auditLog({
        subjectType: "workspaces",
        action: "update",
        phase: "completed",
        subjectId: input.workspaceId,
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        data: {
          id: input.workspaceId,
          settings: mergedSettings,
        },
      });

      // 4. Side-effects
      emitSideEffects({
        subjectType: "workspace",
        action: "update",
        subjectId: input.workspaceId,
        userId: ctx.userId,
        workspaceId: input.workspaceId,
      });

      return {
        status: "updated" as const,
        message: "Intelligence service updated successfully.",
      };
    }),

  /**
   * Delete workspace
   */
  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      // 1. Permission check
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: input.id,
        subjectType: "workspaces",
        action: "delete",
        data: { id: input.id },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("granted" in perm && !perm.granted) {
        return {
          status: "proposed" as const,
          proposalId: perm.proposalId,
          message: "Workspace deletion requires approval.",
        };
      }

      // 2. Direct DB operation
      const dbConn = await getDb();
      const eventRepo = new EventRepository(sql);
      const workspaceRepo = new WorkspaceRepository(dbConn, eventRepo);

      await workspaceRepo.delete(input.id, ctx.userId);

      // 3. Audit log
      auditLog({
        subjectType: "workspaces",
        action: "delete",
        phase: "completed",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: input.id,
        data: { id: input.id },
      });

      // 4. Side-effects
      emitSideEffects({
        subjectType: "workspace",
        action: "delete",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: input.id,
      });

      return {
        status: "deleted" as const,
        message: "Workspace deleted successfully.",
      };
    }),

  /**
   * Add member to workspace
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
      // 1. Permission check
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        subjectType: "workspaceMember",
        action: "add",
        data: {
          workspaceId: input.workspaceId,
          targetUserId: input.userId,
          role: input.role,
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("granted" in perm && !perm.granted) {
        return {
          status: "proposed" as const,
          proposalId: perm.proposalId,
          message: "Member addition requires approval.",
        };
      }

      // 2. Direct DB operation
      const dbConn = await getDb();
      const eventRepo = new EventRepository(sql);
      const memberRepo = new WorkspaceMemberRepository(dbConn, eventRepo);

      const member = await memberRepo.add(
        {
          workspaceId: input.workspaceId,
          userId: input.userId,
          role: input.role,
        },
        ctx.userId
      );

      // 3. Audit log
      auditLog({
        subjectType: "workspaceMember",
        action: "add",
        phase: "completed",
        subjectId: member.id,
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        data: {
          workspaceId: input.workspaceId,
          targetUserId: input.userId,
          role: input.role,
          memberId: member.id,
        },
      });

      return {
        status: "added" as const,
        memberId: member.id,
        message: "Member added successfully.",
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
      // 1. Permission check
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        subjectType: "workspaceMember",
        action: "remove",
        data: {
          workspaceId: input.workspaceId,
          targetUserId: input.userId,
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("granted" in perm && !perm.granted) {
        return {
          status: "proposed" as const,
          proposalId: perm.proposalId,
          message: "Member removal requires approval.",
        };
      }

      // 2. Direct DB operation
      const dbConn = await getDb();
      const eventRepo = new EventRepository(sql);
      const memberRepo = new WorkspaceMemberRepository(dbConn, eventRepo);

      await memberRepo.remove(
        {
          workspaceId: input.workspaceId,
          userId: input.userId,
        },
        ctx.userId
      );

      // 3. Audit log
      auditLog({
        subjectType: "workspaceMember",
        action: "remove",
        phase: "completed",
        subjectId: `${input.workspaceId}-${input.userId}`,
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        data: {
          workspaceId: input.workspaceId,
          targetUserId: input.userId,
        },
      });

      return {
        status: "removed" as const,
        message: "Member removed successfully.",
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
      // 1. Permission check
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        subjectType: "workspaceMember",
        action: "updateRole",
        data: {
          workspaceId: input.workspaceId,
          targetUserId: input.userId,
          newRole: input.role,
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("granted" in perm && !perm.granted) {
        return {
          status: "proposed" as const,
          proposalId: perm.proposalId,
          message: "Role update requires approval.",
        };
      }

      // 2. Direct DB operation
      const dbConn = await getDb();
      const eventRepo = new EventRepository(sql);
      const memberRepo = new WorkspaceMemberRepository(dbConn, eventRepo);

      const member = await memberRepo.updateRole(
        {
          workspaceId: input.workspaceId,
          userId: input.userId,
          newRole: input.role as "owner" | "editor" | "viewer",
        },
        ctx.userId
      );

      // 3. Audit log
      auditLog({
        subjectType: "workspaceMember",
        action: "updateRole",
        phase: "completed",
        subjectId: member.id,
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        data: {
          workspaceId: input.workspaceId,
          targetUserId: input.userId,
          newRole: input.role,
          memberId: member.id,
        },
      });

      return {
        status: "updated" as const,
        message: "Member role updated successfully.",
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

      // Fire-and-forget email relay via Control Plane
      const cpUrl = config.server.controlPlaneUrl;
      const cpKey = config.server.controlPlaneInternalKey;
      if (cpUrl && cpKey) {
        const [workspace, inviter] = await Promise.all([
          db.query.workspaces.findFirst({
            where: eq(workspaces.id, input.workspaceId),
            columns: { name: true },
          }),
          db.query.users.findFirst({
            where: eq(users.id, ctx.userId),
            columns: { name: true },
          }),
        ]);
        const podSubdomain = (config.server as any).domain?.split(".")[0] ?? "";
        fetch(`${cpUrl}/internal/workspace-invite-email`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Key": cpKey,
          },
          body: JSON.stringify({
            podSubdomain,
            email: input.email,
            inviterName: inviter?.name ?? "A teammate",
            workspaceName: workspace?.name ?? "Synap Workspace",
            inviteToken: token,
          }),
        }).catch((err) =>
          logger.warn(
            { err },
            "[createInvite] Failed to relay invite email to CP"
          )
        );
      }

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

      // Direct DB operation — add member and delete invite
      const dbConn = await getDb();
      const eventRepo = new EventRepository(sql);
      const memberRepo = new WorkspaceMemberRepository(dbConn, eventRepo);

      const member = await memberRepo.add(
        {
          workspaceId: invite.workspaceId,
          userId: ctx.userId,
          role: invite.role as "owner" | "editor" | "viewer",
          inviteId: invite.id,
        },
        ctx.userId
      );

      // Audit log
      auditLog({
        subjectType: "workspaceMember",
        action: "add",
        phase: "completed",
        subjectId: member.id,
        userId: ctx.userId,
        workspaceId: invite.workspaceId,
        data: {
          workspaceId: invite.workspaceId,
          userId: ctx.userId,
          role: invite.role,
          invitedBy: invite.invitedBy,
          inviteId: invite.id,
          memberId: member.id,
        },
      });

      return {
        status: "accepted" as const,
        workspaceId: invite.workspaceId,
        message: "Invite accepted successfully.",
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

  /**
   * Seed a plugin workspace (provisioning-level auth via token header)
   *
   * Called by the control plane during pod provisioning to auto-create
   * a workspace for an enabled plugin (e.g., ZeroClaw).
   */
  seedPlugin: publicProcedure
    .input(z.object({ pluginId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      // Authenticate via provisioning token
      const providedToken = ctx.req.headers.get("X-Provisioning-Token");
      const expectedToken = process.env.PROVISIONING_TOKEN;

      if (!expectedToken || !providedToken || providedToken !== expectedToken) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Valid provisioning token required",
        });
      }

      // Plugin workspace configs (hardcoded — mirrors plugin-templates.ts)
      const pluginConfigs: Record<
        string,
        {
          name: string;
          description: string;
          profiles: Array<{
            slug: string;
            displayName: string;
            icon: string;
            color: string;
            description: string;
            properties: Array<{
              slug: string;
              label: string;
              valueType: string;
              inputType?: string;
              enumValues?: string[];
            }>;
          }>;
          views: Array<{
            name: string;
            type: string;
            scopeProfileSlug: string;
            config?: Record<string, unknown>;
          }>;
          bentoLayout: Array<{
            widgetType: string;
            pos: { x: number; y: number; w: number; h: number };
            config?: Record<string, unknown>;
          }>;
          layoutConfig: {
            pinnedApps: string[];
            sidebarApps: string[];
            defaultView: string;
          };
        }
      > = {
        zeroclaw: {
          name: "ZeroClaw Agent",
          description:
            "Autonomous agent workspace for ZeroClaw security operations.",
          profiles: [
            {
              slug: "agent-run",
              displayName: "Agent Run",
              icon: "play",
              color: "#EF4444",
              description: "A single execution run of the ZeroClaw agent.",
              properties: [
                {
                  slug: "status",
                  label: "Status",
                  valueType: "string",
                  inputType: "select",
                  enumValues: ["Queued", "Running", "Completed", "Failed"],
                },
                {
                  slug: "started-at",
                  label: "Started At",
                  valueType: "date",
                },
                {
                  slug: "completed-at",
                  label: "Completed At",
                  valueType: "date",
                },
                { slug: "target", label: "Target", valueType: "string" },
                {
                  slug: "findings-count",
                  label: "Findings",
                  valueType: "number",
                },
              ],
            },
            {
              slug: "agent-task",
              displayName: "Agent Task",
              icon: "list-checks",
              color: "#F59E0B",
              description: "An individual task within an agent run.",
              properties: [
                {
                  slug: "status",
                  label: "Status",
                  valueType: "string",
                  inputType: "select",
                  enumValues: ["Pending", "In Progress", "Done", "Skipped"],
                },
                {
                  slug: "task-type",
                  label: "Type",
                  valueType: "string",
                  inputType: "select",
                  enumValues: ["Scan", "Analyze", "Report", "Remediate"],
                },
                {
                  slug: "severity",
                  label: "Severity",
                  valueType: "string",
                  inputType: "select",
                  enumValues: ["Info", "Low", "Medium", "High", "Critical"],
                },
                {
                  slug: "description",
                  label: "Description",
                  valueType: "string",
                },
              ],
            },
            {
              slug: "finding",
              displayName: "Finding",
              icon: "shield-alert",
              color: "#DC2626",
              description:
                "A security finding or vulnerability detected by the agent.",
              properties: [
                {
                  slug: "severity",
                  label: "Severity",
                  valueType: "string",
                  inputType: "select",
                  enumValues: ["Info", "Low", "Medium", "High", "Critical"],
                },
                {
                  slug: "status",
                  label: "Status",
                  valueType: "string",
                  inputType: "select",
                  enumValues: [
                    "Open",
                    "In Review",
                    "Resolved",
                    "False Positive",
                  ],
                },
                {
                  slug: "category",
                  label: "Category",
                  valueType: "string",
                },
                {
                  slug: "affected-asset",
                  label: "Affected Asset",
                  valueType: "string",
                },
              ],
            },
          ],
          views: [
            {
              name: "Agent Runs",
              type: "table",
              scopeProfileSlug: "agent-run",
            },
            {
              name: "Findings Board",
              type: "kanban",
              scopeProfileSlug: "finding",
              config: { groupByField: "severity" },
            },
            {
              name: "All Tasks",
              type: "table",
              scopeProfileSlug: "agent-task",
            },
          ],
          bentoLayout: [
            {
              widgetType: "stats-overview",
              pos: { x: 0, y: 0, w: 12, h: 2 },
              config: { title: "ZeroClaw Overview" },
            },
            {
              widgetType: "entity-list",
              pos: { x: 0, y: 2, w: 6, h: 4 },
              config: { profileSlug: "agent-run", title: "Recent Runs" },
            },
            {
              widgetType: "entity-list",
              pos: { x: 6, y: 2, w: 6, h: 4 },
              config: { profileSlug: "finding", title: "Open Findings" },
            },
          ],
          layoutConfig: {
            pinnedApps: ["home", "data", "views", "intelligence"],
            sidebarApps: ["home", "data", "views", "intelligence"],
            defaultView: "home",
          },
        },
      };

      const pluginConfig = pluginConfigs[input.pluginId];
      if (!pluginConfig) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Unknown plugin: ${input.pluginId}`,
        });
      }

      const { randomUUID } = await import("crypto");
      const workspaceId = randomUUID();

      // 1. Create workspace
      const dbConn = await getDb();
      const eventRepo = new EventRepository(sql);
      const workspaceRepo = new WorkspaceRepository(dbConn, eventRepo);

      // Use a system user ID for provisioning-created workspaces
      const systemUserId = "00000000-0000-0000-0000-000000000000";

      await workspaceRepo.create(
        {
          id: workspaceId,
          name: pluginConfig.name,
          ownerId: systemUserId,
          settings: { layout: pluginConfig.layoutConfig },
        },
        systemUserId
      );

      logger.info(
        { workspaceId, pluginId: input.pluginId },
        "Plugin workspace seeded"
      );

      return {
        status: "created" as const,
        workspaceId,
      };
    }),

  /**
   * Preview invitation details (public — no auth required)
   * Used by the accept-invite page before the user is logged in.
   */
  previewInvite: publicProcedure
    .input(z.object({ token: z.string() }))
    .query(async ({ input }) => {
      const invite = await db.query.workspaceInvites.findFirst({
        where: eq(workspaceInvites.token, input.token),
        with: { workspace: { columns: { name: true } } },
      });
      if (!invite) return null;
      if (invite.expiresAt < new Date()) return { expired: true as const };
      return {
        expired: false as const,
        workspaceName: invite.workspace?.name ?? "Unknown Workspace",
        role: invite.role,
        expiresAt: invite.expiresAt,
      };
    }),
});
