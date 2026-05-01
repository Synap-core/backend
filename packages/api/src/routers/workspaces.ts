/**
 * Workspaces Router - Multi-user workspace management
 *
 * Handles:
 * - Workspace CRUD (synchronous)
 * - Member management (synchronous)
 * - Invitation system
 */

import { z } from "zod";
import {
  router,
  protectedProcedure,
  publicProcedure,
  podAdminProcedure,
} from "../trpc.js";
import {
  db,
  eq,
  and,
  desc,
  workspaces,
  workspaceMembers,
  invites,
  intelligenceServices,
  getDb,
  EventRepository,
  WorkspaceRepository,
  WorkspaceMemberRepository,
  DocumentRepository,
  EntityRepository,
  drizzleSql,
  sql,
  users,
  createWorkspaceFromDefinition,
  type WorkspaceDefinitionInput,
} from "@synap/database";
import { verifyCpJwt } from "../utils/jwks-client.js";
import type {
  WorkspaceSettings,
  McpServerConfig,
} from "@synap/database/schema";
import { TRPCError } from "@trpc/server";
import { randomBytes } from "crypto";
// import { WorkspaceMemberEvents } from "../lib/event-helpers.js"; // unused — reserved for future member event hooks
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import { auditLog } from "../utils/audit-log.js";
import { assertPackageTierAccess } from "../utils/tier-check.js";
import { emitSideEffects, getBoss } from "@synap/events";
import { config, createLogger } from "@synap-core/core";
import {
  ensureAgentThread,
  ensureWorkspaceGroupChannel,
  ensureProactiveFeedChannel,
  getAgentIdBySlug,
} from "../utils/personal-channel.js";
import { emitChatEvent } from "../utils/chat-realtime-broadcast.js";

const logger = createLogger({ module: "workspaces" });

async function notifyCpInviteSync(input: {
  type: "workspace" | "pod";
  inviteToken: string;
  email: string;
  role: string;
  workspaceId?: string | null;
  workspaceName?: string | null;
  invitedByUserId?: string | null;
  expiresAt: Date;
}) {
  const cpUrl = config.server.controlPlaneUrl;
  const internalKey = process.env.SYNAP_POD_INTERNAL_KEY;
  const podSubdomain =
    process.env.POD_SUBDOMAIN ?? process.env.SERVER_DOMAIN ?? "";
  if (!cpUrl || !internalKey || !podSubdomain) return;
  const backendOrigin =
    process.env.PUBLIC_BACKEND_URL || process.env.SYNAP_INSTANCE_URL;
  const body = {
    podSubdomain,
    inviteToken: input.inviteToken,
    type: input.type,
    workspaceId: input.workspaceId ?? null,
    workspaceName: input.workspaceName ?? null,
    email: input.email,
    role: input.role,
    invitedByUserId: input.invitedByUserId ?? null,
    backendOrigin,
    expiresAt: input.expiresAt.toISOString(),
  };
  fetch(`${cpUrl}/internal/invites/sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Key": internalKey,
    },
    body: JSON.stringify(body),
  }).catch((err) =>
    logger.warn({ err }, "Failed to sync invite to control plane")
  );
}

async function notifyCpInviteLifecycle(input: {
  inviteToken: string;
  event: "accepted" | "rejected" | "revoked" | "expired";
  actorEmail?: string;
  actorUserId?: string;
  reason?: string;
}) {
  const cpUrl = config.server.controlPlaneUrl;
  const internalKey = process.env.SYNAP_POD_INTERNAL_KEY;
  const podSubdomain =
    process.env.POD_SUBDOMAIN ?? process.env.SERVER_DOMAIN ?? "";
  if (!cpUrl || !internalKey || !podSubdomain) return;
  const body = {
    podSubdomain,
    inviteToken: input.inviteToken,
    event: input.event,
    actorEmail: input.actorEmail,
    actorUserId: input.actorUserId,
    reason: input.reason,
  };
  fetch(`${cpUrl}/internal/invites/lifecycle`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Key": internalKey,
    },
    body: JSON.stringify(body),
  }).catch((err) =>
    logger.warn({ err }, "Failed to sync invite lifecycle to control plane")
  );
}

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
        name: z.string().trim().min(1).max(100),
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

      // 2. Tier check for package-based workspaces
      const packageSlug = input.settings?.packageSlug as string | undefined;
      if (packageSlug) {
        await assertPackageTierAccess(ctx.userId, packageSlug);
      }

      // 3. Direct DB operation
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

      // 2b. Auto-add creator as owner member
      const memberRepo = new WorkspaceMemberRepository(dbConn, eventRepo);
      await memberRepo.add(
        {
          workspaceId,
          userId: ctx.userId,
          role: "owner",
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
        const templateName = input.settings?.templateName as string | undefined;
        const packageSlug = input.settings?.packageSlug as string | undefined;
        await boss.send("workspace-init", {
          workspaceId,
          userId: ctx.userId,
          templateName,
          packageSlug,
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
        ensureDefaultRelationDefs,
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

      // Skip default views for template workspaces — template defines its own views
      const isTemplateWorkspace = !!(
        workspace.settings as Record<string, unknown> | null
      )?.templateName;
      if (!isTemplateWorkspace) {
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

      const relDefsResult = await ensureDefaultRelationDefs(
        input.id,
        ctx.userId
      );
      console.log(
        `[workspaces.get] ensureDefaultRelationDefs:`,
        relDefsResult.status,
        relDefsResult.message
      );
      if (relDefsResult.status === "error") {
        console.error(
          `[workspaces.get] Failed to ensure default relation defs:`,
          relDefsResult.message,
          relDefsResult.error
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
            (updatedWorkspace.settings as Record<string, unknown> | null)
              ?.mainWhiteboardId
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
        name: z.string().trim().min(1).max(100).optional(),
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

      // 1. Permission check
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        subjectType: "workspaces",
        action: "update",
        data: { id: input.workspaceId },
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

      // 2. Atomic settings patch — no read needed
      const dbConn = await getDb();
      const eventRepo = new EventRepository(sql);
      const workspaceRepo = new WorkspaceRepository(dbConn, eventRepo);

      await workspaceRepo.mergeSettings(
        input.workspaceId,
        { intelligenceServiceId: input.serviceId ?? undefined },
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
          intelligenceServiceId: input.serviceId,
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
   * Admin: get any workspace by ID (pod-admin only, no membership required)
   */
  adminGet: podAdminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input }) => {
      const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, input.id),
      });

      if (!workspace) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Workspace not found",
        });
      }

      const memberCount = await db
        .select({ count: drizzleSql<number>`count(*)::int` })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, input.id));

      return {
        ...workspace,
        memberCount: memberCount[0]?.count ?? 0,
        // Admins have no role in the workspace (they're managing it externally)
        role: "admin" as const,
      };
    }),

  /**
   * Admin: list ALL workspaces on the pod (pod-admin only)
   */
  adminListAll: podAdminProcedure.query(async () => {
    const allWorkspaces = await db.query.workspaces.findMany({
      orderBy: [desc(workspaces.createdAt)],
    });

    const counts = await db
      .select({
        workspaceId: workspaceMembers.workspaceId,
        count: drizzleSql<number>`count(*)::int`,
      })
      .from(workspaceMembers)
      .groupBy(workspaceMembers.workspaceId);

    const countMap = new Map(counts.map((c) => [c.workspaceId, c.count]));

    return allWorkspaces.map((ws) => ({
      ...ws,
      memberCount: countMap.get(ws.id) ?? 0,
    }));
  }),

  /**
   * Admin: force-delete any workspace (pod-admin only)
   *
   * Blocked for system workspaces (systemSlug set in settings).
   * Requires the caller to pass the workspace name for confirmation
   * (verified server-side to prevent accidental bulk deletions).
   */
  adminDelete: podAdminProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid(),
        confirmName: z.string(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, input.workspaceId),
        columns: { id: true, name: true, settings: true },
      });

      if (!workspace) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Workspace not found",
        });
      }

      const settings = (workspace.settings ?? {}) as Record<string, unknown>;
      if (settings.systemSlug) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "System workspaces cannot be deleted from the admin panel.",
        });
      }

      if (workspace.name !== input.confirmName) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Workspace name does not match. Deletion cancelled.",
        });
      }

      const dbConn = await getDb();
      const eventRepo = new EventRepository(sql);
      const workspaceRepo = new WorkspaceRepository(dbConn, eventRepo);

      await workspaceRepo.delete(input.workspaceId, ctx.userId);

      auditLog({
        subjectType: "workspaces",
        action: "admin_delete",
        phase: "completed",
        subjectId: input.workspaceId,
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        data: {
          id: input.workspaceId,
          name: workspace.name,
          adminForced: true,
        },
      });

      logger.warn(
        { workspaceId: input.workspaceId, deletedBy: ctx.userId },
        "Admin force-deleted workspace"
      );

      return { status: "deleted" as const, message: "Workspace deleted." };
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

      // 4. Auto-provision per-agent thread + workspace group + proactive feed for new member (idempotent)
      getAgentIdBySlug("orchestrator")
        .then(async (orchestratorId) => {
          if (orchestratorId) {
            await ensureAgentThread(input.userId, orchestratorId);
          }
        })
        .catch((err) => {
          logger.warn(
            { err },
            "Failed to provision orchestrator thread on workspace join"
          );
        });
      ensureWorkspaceGroupChannel(input.userId, input.workspaceId).catch(
        (err) => {
          logger.warn(
            { err },
            "Failed to provision workspace group channel on workspace join"
          );
        }
      );
      ensureProactiveFeedChannel(input.userId, input.workspaceId).catch(
        (err) => {
          logger.warn(
            { err },
            "Failed to provision proactive feed channel on workspace join"
          );
        }
      );

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
   * Create an invite (workspace or pod-level).
   * - type='workspace': requires workspaceId, adds invitee to that workspace only.
   * - type='pod': no workspaceId required, adds invitee to ALL workspaces on accept.
   */
  createInvite: protectedProcedure
    .input(
      z.discriminatedUnion("type", [
        z.object({
          type: z.literal("workspace"),
          workspaceId: z.string().uuid(),
          email: z.string().email(),
          role: z.enum(["admin", "editor", "viewer"]),
        }),
        z.object({
          type: z.literal("pod"),
          email: z.string().email(),
          role: z.enum(["admin", "editor", "viewer"]).default("viewer"),
        }),
      ])
    )
    .mutation(async ({ input, ctx }) => {
      if (input.type === "workspace") {
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
      } else {
        // Pod invite — must be an owner of at least one workspace
        const ownerMembership = await db.query.workspaceMembers.findFirst({
          where: and(
            eq(workspaceMembers.userId, ctx.userId),
            eq(workspaceMembers.role, "owner")
          ),
        });
        if (!ownerMembership) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Only pod owners can send pod invites",
          });
        }
      }

      const token = randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      const [invite] = await db
        .insert(invites)
        .values({
          type: input.type,
          workspaceId: input.type === "workspace" ? input.workspaceId : null,
          email: input.email,
          role: input.role,
          token,
          invitedBy: ctx.userId,
          expiresAt,
        })
        .returning();

      let workspaceNameForSync: string | null = null;
      if (input.type === "workspace") {
        const ws = await db.query.workspaces.findFirst({
          where: eq(workspaces.id, input.workspaceId),
          columns: { name: true },
        });
        workspaceNameForSync = ws?.name ?? "Synap Workspace";
      }

      // Notify CP to send invite email (fire-and-forget)
      const cpUrl = config.server.controlPlaneUrl;
      if (cpUrl) {
        const inviter = await db.query.users.findFirst({
          where: eq(users.id, ctx.userId),
          columns: { name: true },
        });
        const inviterName = inviter?.name ?? "A Synap user";

        const podSubdomain =
          process.env.POD_SUBDOMAIN ?? process.env.SERVER_DOMAIN ?? "";
        const body: Record<string, string> = {
          type: input.type,
          email: input.email,
          inviterName,
          role: input.role,
          inviteToken: invite.token,
          podSubdomain,
          clientHint: "auto",
        };
        const backendOrigin =
          process.env.PUBLIC_BACKEND_URL || process.env.SYNAP_INSTANCE_URL;
        if (backendOrigin) {
          body.backendOrigin = backendOrigin;
        }
        if (workspaceNameForSync) {
          body.workspaceName = workspaceNameForSync;
        }

        const internalKey = process.env.SYNAP_POD_INTERNAL_KEY;
        fetch(`${cpUrl}/internal/invite-email`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(internalKey ? { "X-Internal-Key": internalKey } : {}),
          },
          body: JSON.stringify(body),
        }).catch((err) =>
          logger.warn({ err }, "Failed to send invite email (non-fatal)")
        );
      }

      void notifyCpInviteSync({
        type: input.type,
        inviteToken: invite.token,
        email: input.email,
        role: input.role,
        workspaceId: input.type === "workspace" ? input.workspaceId : null,
        workspaceName: workspaceNameForSync,
        invitedByUserId: ctx.userId,
        expiresAt: invite.expiresAt,
      });

      return {
        id: invite.id,
        token: invite.token,
        expiresAt: invite.expiresAt,
      };
    }),

  /**
   * List invites addressed to the current user email (recipient inbox).
   */
  listMyInvites: protectedProcedure.query(async ({ ctx }) => {
    const me = await db.query.users.findFirst({
      where: eq(users.id, ctx.userId),
      columns: { email: true },
    });
    if (!me?.email) return [];
    return db.query.invites.findMany({
      where: eq(invites.email, me.email.toLowerCase()),
      with: { workspace: { columns: { name: true } } },
      orderBy: [desc(invites.createdAt)],
    });
  }),

  /**
   * List pending invites. Pass workspaceId to list workspace invites,
   * omit it (or pass type='pod') to list pod invites (owner only).
   */
  listInvites: protectedProcedure
    .input(
      z.object({
        type: z.enum(["workspace", "pod"]),
        workspaceId: z.string().uuid().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      if (input.type === "workspace") {
        if (!input.workspaceId)
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "workspaceId required for workspace invites",
          });
        const membership = await db.query.workspaceMembers.findFirst({
          where: and(
            eq(workspaceMembers.workspaceId, input.workspaceId),
            eq(workspaceMembers.userId, ctx.userId)
          ),
        });
        if (!membership)
          throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });

        return db.query.invites.findMany({
          where: and(
            eq(invites.type, "workspace"),
            eq(invites.workspaceId, input.workspaceId)
          ),
          orderBy: [desc(invites.createdAt)],
        });
      } else {
        const ownerMembership = await db.query.workspaceMembers.findFirst({
          where: and(
            eq(workspaceMembers.userId, ctx.userId),
            eq(workspaceMembers.role, "owner")
          ),
        });
        if (!ownerMembership) throw new TRPCError({ code: "FORBIDDEN" });

        return db.query.invites.findMany({
          where: eq(invites.type, "pod"),
          orderBy: [desc(invites.createdAt)],
        });
      }
    }),

  /**
   * Accept invitation (workspace or pod). Works for both types.
   */
  acceptInvite: protectedProcedure
    .input(z.object({ token: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const invite = await db.query.invites.findFirst({
        where: eq(invites.token, input.token),
      });
      if (!invite)
        throw new TRPCError({ code: "NOT_FOUND", message: "Invite not found" });
      if (invite.expiresAt < new Date())
        throw new TRPCError({ code: "BAD_REQUEST", message: "Invite expired" });
      const me = await db.query.users.findFirst({
        where: eq(users.id, ctx.userId),
        columns: { email: true },
      });
      if (
        me?.email &&
        invite.email &&
        me.email.toLowerCase() !== invite.email.toLowerCase()
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "This invite is addressed to another email",
        });
      }

      const dbConn = await getDb();
      const eventRepo = new EventRepository(sql);
      const memberRepo = new WorkspaceMemberRepository(dbConn, eventRepo);

      if (invite.type === "workspace") {
        if (!invite.workspaceId)
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const member = await memberRepo.add(
          {
            workspaceId: invite.workspaceId,
            userId: ctx.userId,
            role: invite.role as "owner" | "editor" | "viewer",
            inviteId: invite.id,
          },
          ctx.userId
        );
        auditLog({
          subjectType: "workspaceMember",
          action: "add",
          phase: "completed",
          subjectId: member.id,
          userId: ctx.userId,
          workspaceId: invite.workspaceId,
          data: {
            role: invite.role,
            invitedBy: invite.invitedBy,
            inviteId: invite.id,
          },
        });
        await db.delete(invites).where(eq(invites.id, invite.id));
        void notifyCpInviteLifecycle({
          inviteToken: invite.token,
          event: "accepted",
          actorEmail: me?.email ?? undefined,
          actorUserId: ctx.userId,
        });
        return {
          status: "accepted" as const,
          type: "workspace" as const,
          workspaceId: invite.workspaceId,
        };
      } else {
        // Pod invite — add to all workspaces
        const allWorkspaces = await db.query.workspaces.findMany();
        for (const ws of allWorkspaces) {
          const alreadyMember = await db.query.workspaceMembers.findFirst({
            where: and(
              eq(workspaceMembers.workspaceId, ws.id),
              eq(workspaceMembers.userId, ctx.userId)
            ),
          });
          if (alreadyMember) continue;
          await memberRepo.add(
            {
              workspaceId: ws.id,
              userId: ctx.userId,
              role: invite.role as "owner" | "editor" | "viewer",
            },
            ctx.userId
          );
        }
        await db.delete(invites).where(eq(invites.id, invite.id));
        void notifyCpInviteLifecycle({
          inviteToken: invite.token,
          event: "accepted",
          actorEmail: me?.email ?? undefined,
          actorUserId: ctx.userId,
        });
        return {
          status: "accepted" as const,
          type: "pod" as const,
          workspacesJoined: allWorkspaces.length,
        };
      }
    }),

  /**
   * Revoke an invite (workspace or pod).
   */
  revokeInvite: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const invite = await db.query.invites.findFirst({
        where: eq(invites.id, input.id),
      });
      if (!invite)
        throw new TRPCError({ code: "NOT_FOUND", message: "Invite not found" });

      if (invite.type === "workspace" && invite.workspaceId) {
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
      } else {
        const ownerMembership = await db.query.workspaceMembers.findFirst({
          where: and(
            eq(workspaceMembers.userId, ctx.userId),
            eq(workspaceMembers.role, "owner")
          ),
        });
        if (!ownerMembership) throw new TRPCError({ code: "FORBIDDEN" });
      }

      await db.delete(invites).where(eq(invites.id, input.id));
      void notifyCpInviteLifecycle({
        inviteToken: invite.token,
        event: "revoked",
        actorUserId: ctx.userId,
      });
      return { success: true };
    }),

  /**
   * Create a complete workspace from a PackageDefinition in a single call.
   *
   * Server-side equivalent of the frontend's 9-step useCreateWorkspaceFromProposal.
   * Preferred path for template-based workspace creation (packages from registry).
   */
  createFromDefinition: protectedProcedure
    .input(
      z.object({
        definition: z
          .object({
            workspaceName: z.string().optional(),
            description: z.string().optional(),
            profiles: z
              .array(
                z.object({
                  slug: z.string(),
                  displayName: z.string(),
                  // Proposal format: direct fields
                  icon: z.string().optional(),
                  color: z.string().optional(),
                  description: z.string().optional(),
                  scope: z.string().optional(),
                  semanticSlug: z.string().nullable().optional(),
                  // Proposal format: flat property list
                  properties: z
                    .array(
                      z.object({
                        slug: z.string(),
                        label: z.string().optional(),
                        valueType: z.string(),
                        inputType: z.string().optional(),
                        placeholder: z.string().optional(),
                        enumValues: z.array(z.string()).optional(),
                        constraints: z
                          .record(z.string(), z.unknown())
                          .optional(),
                        // entity_id properties: which profile this field links to
                        targetProfileSlug: z.string().optional(),
                      })
                    )
                    .optional(),
                  // Registry format: nested uiHints (alternative to direct fields)
                  uiHints: z
                    .object({
                      icon: z.string().optional(),
                      color: z.string().optional(),
                      description: z.string().optional(),
                    })
                    .optional(),
                  // Registry format: propertyDefs with nested uiHints (alternative to properties[])
                  propertyDefs: z
                    .array(
                      z.object({
                        slug: z.string(),
                        valueType: z.string(),
                        required: z.boolean().optional(),
                        constraints: z
                          .object({
                            enum: z.array(z.string()).optional(),
                          })
                          .passthrough()
                          .optional(),
                        uiHints: z
                          .object({
                            label: z.string().optional(),
                            inputType: z.string().optional(),
                            placeholder: z.string().optional(),
                          })
                          .optional(),
                      })
                    )
                    .optional(),
                })
              )
              .optional(),
            views: z
              .array(
                z.object({
                  // Accept both "name" (proposal format) and "displayName" (registry format)
                  name: z.string().optional(),
                  displayName: z.string().optional(),
                  slug: z.string().optional(),
                  type: z.string(),
                  scopeProfileSlug: z.string().optional(),
                  scopeProfileSlugs: z.array(z.string()).optional(),
                  config: z.record(z.string(), z.unknown()).optional(),
                  // View configuration fields (merged into config during processing)
                  groupBy: z.string().optional(),
                  sortBy: z.string().optional(),
                  sortOrder: z.enum(["asc", "desc"]).optional(),
                  filterBy: z.record(z.string(), z.unknown()).optional(),
                  description: z.string().optional(),
                  defaultView: z.boolean().optional(),
                  hierarchyEdges: z
                    .array(
                      z.object({
                        parent: z.string(),
                        child: z.string(),
                        via: z.string().optional(),
                      })
                    )
                    .optional(),
                  startField: z.string().optional(),
                  endField: z.string().optional(),
                  colorBy: z.string().optional(),
                })
              )
              .optional(),
            /** Override the default "Home" name for the workspace home bento view */
            bentoViewName: z.string().optional(),
            bentoLayout: z
              .array(
                z.object({
                  widgetType: z.string(),
                  pos: z.object({
                    x: z.number(),
                    y: z.number(),
                    w: z.number(),
                    h: z.number(),
                  }),
                  config: z.record(z.string(), z.unknown()).optional(),
                })
              )
              .optional(),
            bentoViewBlocks: z
              .array(
                z.object({
                  kind: z.literal("view").default("view"),
                  viewName: z.string(),
                  pos: z.object({
                    x: z.number(),
                    y: z.number(),
                    w: z.number(),
                    h: z.number(),
                  }),
                  overrides: z.record(z.string(), z.unknown()).optional(),
                })
              )
              .optional(),
            suggestedEntities: z
              .array(
                z.object({
                  profileSlug: z.string(),
                  title: z.string(),
                  properties: z.record(z.string(), z.unknown()).optional(),
                  content: z.string().optional(),
                })
              )
              .optional(),
            /** Alias for suggestedEntities (used by some template authors). Normalized server-side. */
            seedEntities: z
              .array(
                z.object({
                  profileSlug: z.string(),
                  title: z.string(),
                  properties: z.record(z.string(), z.unknown()).optional(),
                  content: z.string().optional(),
                })
              )
              .optional(),
            suggestedRelations: z
              .array(
                z.object({
                  sourceRef: z.string(),
                  targetRef: z.string(),
                  type: z.string(),
                  metadata: z.record(z.string(), z.unknown()).optional(),
                })
              )
              .optional(),
            displayTemplates: z
              .array(
                z.object({
                  name: z.string(),
                  description: z.string().optional(),
                  entityType: z.string().optional(),
                  targetType: z.string().optional(),
                  isDefault: z.boolean().optional(),
                  config: z.record(z.string(), z.unknown()),
                })
              )
              .optional(),
            layoutConfig: z
              .object({
                pinnedApps: z.array(z.string()).optional(),
                /** Browser: which app to open by default (e.g. 'intelligence' for chat-first) */
                defaultApp: z.string().optional(),
                defaultView: z.string().optional(),
                theme: z.string().optional(),
                sidebarItems: z
                  .array(
                    z.object({
                      // "profile" = navigate to profile bento view (new)
                      // "external" = third-party URL (legacy)
                      kind: z.enum(["app", "view", "profile", "external"]),
                      appId: z.string().optional(),
                      viewName: z.string().optional(),
                      profileSlug: z.string().optional(),
                      url: z.string().optional(),
                      label: z.string().optional(),
                      icon: z.string().optional(),
                    })
                  )
                  .optional(),
              })
              .optional(),
            /** Per-profile default entity bento layout; stored in workspace.settings */
            profileEntityBentoTemplates: z
              .record(
                z.string(),
                z.object({ blocks: z.array(z.record(z.string(), z.unknown())) })
              )
              .optional(),
            entityLinks: z
              .array(
                z.object({
                  sourceProfileSlug: z.string(),
                  targetProfileSlug: z.string(),
                  type: z.string(),
                  label: z.string().optional(),
                })
              )
              .optional(),
          })
          .passthrough(),
        packageSlug: z.string().optional(),
        packageVersion: z.string().optional(),
        /** ID of the template from the control plane registry (stored in workspace settings). */
        templateId: z.string().optional(),
        /** Human-readable name of the template (for workspace-init + settings). */
        templateName: z.string().optional(),
        workspaceName: z.string().optional(),
        workspaceType: z
          .enum(["personal", "agent", "project", "operational"])
          .optional(),
        linkedAgentId: z.string().optional(),
        /**
         * Optional: populate an existing workspace instead of creating a new one.
         * Used by the chat-first onboarding flow where a minimal workspace is
         * created first, then the AI proposes a definition to populate it.
         */
        workspaceId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Enforce tier access before creating. Self-hosted pods (no CP configured)
      // are always allowed. Throws FORBIDDEN if tier is insufficient.
      if (input.packageSlug) {
        await assertPackageTierAccess(ctx.userId, input.packageSlug);
      }

      // Idempotency: if the user already has a workspace with this packageSlug, return it.
      // "pending" workspaces (creation in progress) are returned as-is so the client can
      // subscribe to progress events. "failed" workspaces are returned with status "failed"
      // so the client can offer a retry button.
      // Prevents duplicate workspaces when the browser re-triggers onboarding on reconnect.
      if (input.packageSlug) {
        const existingMembership = await db.query.workspaceMembers.findFirst({
          where: and(
            eq(workspaceMembers.userId, ctx.userId),
            drizzleSql`EXISTS (
              SELECT 1 FROM workspaces w
              WHERE w.id = ${workspaceMembers.workspaceId}
                AND w.settings->>'packageSlug' = ${input.packageSlug}
            )`
          ),
          with: { workspace: true },
        });
        if (existingMembership?.workspace) {
          const ws = existingMembership.workspace;
          const wsSettings = ws.settings as WorkspaceSettings | null;
          const provStatus = wsSettings?.provisioningStatus;

          if (provStatus === "failed") {
            // Automatically resume from where the previous attempt failed.
            logger.warn(
              {
                userId: ctx.userId,
                packageSlug: input.packageSlug,
                workspaceId: ws.id,
                failedStep: wsSettings?.failedStep,
                completedSteps: wsSettings?.completedSteps,
              },
              "createFromDefinition: resuming failed workspace"
            );
            emitChatEvent({
              event: "workspace:creation_progress",
              data: {
                step: "resume",
                pct: 5,
                label: `Resuming from step '${wsSettings?.failedStep ?? "unknown"}'`,
                status: "progress",
              },
              userId: ctx.userId,
            });
            // Fall through to createWorkspaceFromDefinition with resumeFrom set
            const resumeResult = await createWorkspaceFromDefinition({
              definition: input.definition,
              userId: ctx.userId,
              packageSlug: input.packageSlug,
              packageVersion: input.packageVersion,
              templateId: input.templateId,
              templateName: input.templateName,
              workspaceName: input.workspaceName,
              createdBy: "user",
              workspaceType: input.workspaceType,
              linkedAgentId: input.linkedAgentId,
              resumeFrom: {
                workspaceId: ws.id,
                completedSteps: wsSettings?.completedSteps ?? [],
              },
              onProgress: (step, pct, label) => {
                emitChatEvent({
                  event: "workspace:creation_progress",
                  data: { step, pct, label, status: "progress" },
                  userId: ctx.userId,
                });
              },
            });
            return {
              status: "created" as const,
              workspaceId: resumeResult.workspaceId,
              profileIds: resumeResult.profileIds,
              viewIds: resumeResult.viewIds,
            };
          }

          logger.info(
            {
              userId: ctx.userId,
              packageSlug: input.packageSlug,
              workspaceId: ws.id,
              provisioningStatus: provStatus,
            },
            "createFromDefinition: returning existing workspace (idempotent)"
          );
          return {
            status:
              provStatus === "active"
                ? ("created" as const)
                : ("pending" as const),
            workspaceId: ws.id,
          };
        }
      }

      let result: Awaited<ReturnType<typeof createWorkspaceFromDefinition>>;
      try {
        result = await createWorkspaceFromDefinition({
          definition: input.definition,
          userId: ctx.userId,
          packageSlug: input.packageSlug,
          packageVersion: input.packageVersion,
          templateId: input.templateId,
          templateName: input.templateName,
          workspaceName: input.workspaceName,
          createdBy: "user",
          workspaceType: input.workspaceType,
          linkedAgentId: input.linkedAgentId,
          // When workspaceId is provided, populate the existing workspace
          // instead of creating a new one (chat-first onboarding flow).
          // "workspace" is in completedSteps to skip the CREATE step.
          ...(input.workspaceId
            ? {
                resumeFrom: {
                  workspaceId: input.workspaceId,
                  completedSteps: ["workspace"],
                },
              }
            : {}),
          onProgress: (step, pct, label) => {
            emitChatEvent({
              event: "workspace:creation_progress",
              data: { step, pct, label, status: "progress" },
              userId: ctx.userId,
            });
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Extract step name from structured error message ("...at step 'X': ...")
        const stepMatch = message.match(/at step '([^']+)'/);
        const failedStep = stepMatch?.[1];
        logger.error(
          {
            err,
            userId: ctx.userId,
            packageSlug: input.packageSlug,
            failedStep,
          },
          "createFromDefinition failed"
        );
        // Emit error progress event so the frontend loading state can show
        // what went wrong instead of spinning indefinitely.
        emitChatEvent({
          event: "workspace:creation_progress",
          data: {
            step: failedStep ?? "error",
            pct: 0,
            label: failedStep
              ? `Failed at step '${failedStep}': ${message}`
              : `Creation failed: ${message}`,
            status: "error",
          },
          userId: ctx.userId,
        });
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: failedStep
            ? `Workspace creation failed at step '${failedStep}': ${message}`
            : `Workspace creation failed: ${message}`,
        });
      }

      // Create documents for entities with content
      // (storage lives in the API layer, not the database package)
      const entitiesWithContent = (input.definition.suggestedEntities ?? [])
        .map((entity, idx) => ({ entity, entityId: result.entityIds[idx] }))
        .filter(
          (e): e is typeof e & { entity: { content: string } } =>
            !!e.entity.content && !!e.entityId
        );

      if (entitiesWithContent.length > 0) {
        const { storage } = await import("@synap/storage");

        const database = await getDb();
        const evRepo = new EventRepository(sql);
        const docRepo = new DocumentRepository(database, evRepo);
        const entRepo = new EntityRepository(database, evRepo);

        for (const { entity, entityId } of entitiesWithContent) {
          try {
            const key = storage.buildPath(ctx.userId, "entity", entityId, "md");
            const metadata = await storage.upload(key, entity.content, {
              contentType: "text/markdown",
            });

            const doc = await docRepo.create(
              {
                title: entity.title,
                type: "markdown",
                storageUrl: metadata.url,
                storageKey: metadata.path,
                size: metadata.size,
                mimeType: "text/markdown",
                userId: ctx.userId,
                workspaceId: result.workspaceId,
              },
              ctx.userId
            );

            // Link entity → document (single direction — no backlink needed)
            await entRepo.update(entityId, { documentId: doc.id }, ctx.userId);
          } catch (err) {
            logger.warn(
              { err, entityId, title: entity.title },
              "Failed to create document for seed entity (non-fatal)"
            );
          }
        }
      }

      // Enqueue workspace-init for default whiteboard/commands
      // (skips default views when packageSlug is set)
      try {
        const boss = getBoss();
        await boss.send("workspace-init", {
          workspaceId: result.workspaceId,
          userId: ctx.userId,
          packageSlug: input.packageSlug,
        });
      } catch (err) {
        logger.warn(
          { err, workspaceId: result.workspaceId },
          "Failed to enqueue workspace-init (non-fatal)"
        );
      }

      auditLog({
        subjectType: "workspaces",
        action: "create",
        phase: "completed",
        subjectId: result.workspaceId,
        userId: ctx.userId,
        data: {
          id: result.workspaceId,
          packageSlug: input.packageSlug,
          createdBy: "user",
        },
      });

      emitSideEffects({
        subjectType: "workspace",
        action: "create",
        subjectId: result.workspaceId,
        userId: ctx.userId,
      });

      return {
        status: "created" as const,
        workspaceId: result.workspaceId,
        profileIds: result.profileIds,
        viewIds: result.viewIds,
        entityIds: result.entityIds,
      };
    }),

  /**
   * Seed a plugin workspace (provisioning-level auth via token header)
   *
   * Called by the control plane during pod provisioning to auto-create
   * a workspace for an enabled plugin (e.g., agent-os).
   */
  seedPlugin: publicProcedure
    .input(
      z.object({
        pluginId: z.string(),
        definition: z.unknown().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Authenticate via provisioning token
      const providedToken = ctx.req?.headers.get("X-Provisioning-Token");
      const expectedToken = process.env.PROVISIONING_TOKEN;

      if (!expectedToken || !providedToken || providedToken !== expectedToken) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Valid provisioning token required",
        });
      }

      const systemUserId = "00000000-0000-0000-0000-000000000000";

      // Idempotency: if a provisioned workspace with this pluginId already exists, return it.
      // Prevents duplicate workspaces when provisioning retries or the CP re-calls seedPlugin.
      const existingPluginWorkspace = await db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(
          and(
            drizzleSql`${workspaces.settings}->>'packageSlug' = ${input.pluginId}`,
            drizzleSql`${workspaces.settings}->>'createdBy' = 'provisioning'`
          )
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);

      if (existingPluginWorkspace) {
        logger.info(
          { workspaceId: existingPluginWorkspace.id, pluginId: input.pluginId },
          "seedPlugin: returning existing provisioned workspace (idempotent)"
        );
        return {
          status: "existing" as const,
          workspaceId: existingPluginWorkspace.id,
        };
      }

      // Generic path: use definition from control plane registry
      if (input.definition) {
        const result = await createWorkspaceFromDefinition({
          definition: input.definition as WorkspaceDefinitionInput,
          userId: systemUserId,
          packageSlug: input.pluginId,
          createdBy: "provisioning",
        });

        // Enqueue workspace-init (whiteboard + commands, skips default views)
        try {
          const boss = getBoss();
          await boss.send("workspace-init", {
            workspaceId: result.workspaceId,
            userId: systemUserId,
            packageSlug: input.pluginId,
          });
        } catch (err) {
          logger.warn(
            { err, workspaceId: result.workspaceId },
            "Failed to enqueue workspace-init (non-fatal)"
          );
        }

        logger.info(
          { workspaceId: result.workspaceId, pluginId: input.pluginId },
          "Plugin workspace seeded via definition"
        );

        return {
          status: "created" as const,
          workspaceId: result.workspaceId,
        };
      }

      // Legacy fallback: hardcoded zeroclaw config (backward compat)
      if (input.pluginId !== "zeroclaw") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Unknown plugin: ${input.pluginId}. Pass a definition for generic plugins.`,
        });
      }

      const { randomUUID } = await import("crypto");
      const workspaceId = randomUUID();

      const dbConn = await getDb();
      const eventRepo = new EventRepository(sql);
      const workspaceRepo = new WorkspaceRepository(dbConn, eventRepo);

      await workspaceRepo.create(
        {
          id: workspaceId,
          name: "Agent OS",
          ownerId: systemUserId,
          settings: {
            layout: {
              pinnedApps: ["home", "data", "views", "intelligence"],
              defaultView: "home",
            },
            createdBy: "provisioning",
            provisionedAt: new Date().toISOString(),
            provisioningStatus: "active",
            packageSlug: "zeroclaw",
          },
        },
        systemUserId
      );

      logger.info(
        { workspaceId, pluginId: input.pluginId },
        "Plugin workspace seeded (legacy)"
      );

      return {
        status: "created" as const,
        workspaceId,
      };
    }),

  /**
   * Preview invite details (public — no auth required).
   * Returns type so the landing page can adapt its UI.
   */
  previewInvite: publicProcedure
    .input(z.object({ token: z.string() }))
    .query(async ({ input }) => {
      const invite = await db.query.invites.findFirst({
        where: eq(invites.token, input.token),
        with: { workspace: { columns: { name: true } } },
      });
      if (!invite) return null;
      if (invite.expiresAt < new Date()) return { expired: true as const };

      const inviter = await db.query.users.findFirst({
        where: eq(users.id, invite.invitedBy),
        columns: { name: true, email: true },
      });
      const inviterName = inviter?.name ?? inviter?.email ?? "A Synap user";

      if (invite.type === "workspace") {
        return {
          expired: false as const,
          type: "workspace" as const,
          workspaceName: invite.workspace?.name ?? "Unknown Workspace",
          inviterName,
          role: invite.role,
          expiresAt: invite.expiresAt,
        };
      } else {
        return {
          expired: false as const,
          type: "pod" as const,
          inviterName,
          role: invite.role,
          expiresAt: invite.expiresAt,
        };
      }
    }),

  /**
   * Accept an invite via the CP API proxy (no Kratos session needed).
   * The CP signs a short-lived JWT containing the invitee's email.
   * The pod looks up the local user by email and accepts on their behalf.
   * Works for both workspace and pod invites.
   */
  acceptInviteViaCp: publicProcedure
    .input(z.object({ token: z.string(), cpToken: z.string() }))
    .mutation(async ({ input }) => {
      const cpUrl = config.server.controlPlaneUrl;
      const payload = await verifyCpJwt<{
        sub: string;
        email: string;
        type: string;
      }>(input.cpToken, cpUrl);
      if (!payload || payload.type !== "invite-accept") {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Invalid CP token",
        });
      }

      const podUser = await db.query.users.findFirst({
        where: eq(users.email, payload.email),
      });
      if (!podUser) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message:
            "No pod account found for this email. Please sign in to this pod first.",
        });
      }

      const invite = await db.query.invites.findFirst({
        where: eq(invites.token, input.token),
      });
      if (!invite)
        throw new TRPCError({ code: "NOT_FOUND", message: "Invite not found" });
      if (invite.expiresAt < new Date())
        throw new TRPCError({ code: "BAD_REQUEST", message: "Invite expired" });
      if (
        invite.email &&
        payload.email &&
        invite.email.toLowerCase() !== payload.email.toLowerCase()
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Invite email does not match CP principal",
        });
      }

      const dbConn = await getDb();
      const eventRepo = new EventRepository(sql);
      const memberRepo = new WorkspaceMemberRepository(dbConn, eventRepo);

      if (invite.type === "workspace") {
        if (!invite.workspaceId)
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const member = await memberRepo.add(
          {
            workspaceId: invite.workspaceId,
            userId: podUser.id,
            role: invite.role as "owner" | "editor" | "viewer",
            inviteId: invite.id,
          },
          podUser.id
        );
        auditLog({
          subjectType: "workspaceMember",
          action: "add",
          phase: "completed",
          subjectId: member.id,
          userId: podUser.id,
          workspaceId: invite.workspaceId,
          data: { source: "cp-proxy", email: payload.email },
        });
        await db.delete(invites).where(eq(invites.id, invite.id));
        void notifyCpInviteLifecycle({
          inviteToken: invite.token,
          event: "accepted",
          actorEmail: payload.email,
          actorUserId: podUser.id,
        });
        return {
          status: "accepted" as const,
          type: "workspace" as const,
          workspaceId: invite.workspaceId,
        };
      } else {
        const allWorkspaces = await db.query.workspaces.findMany();
        for (const ws of allWorkspaces) {
          const alreadyMember = await db.query.workspaceMembers.findFirst({
            where: and(
              eq(workspaceMembers.workspaceId, ws.id),
              eq(workspaceMembers.userId, podUser.id)
            ),
          });
          if (alreadyMember) continue;
          await memberRepo.add(
            {
              workspaceId: ws.id,
              userId: podUser.id,
              role: invite.role as "owner" | "editor" | "viewer",
            },
            podUser.id
          );
        }
        await db.delete(invites).where(eq(invites.id, invite.id));
        void notifyCpInviteLifecycle({
          inviteToken: invite.token,
          event: "accepted",
          actorEmail: payload.email,
          actorUserId: podUser.id,
        });
        return {
          status: "accepted" as const,
          type: "pod" as const,
          workspacesJoined: allWorkspaces.length,
        };
      }
    }),

  /**
   * Reject invite via CP proxy token when no pod session exists in browser context.
   */
  rejectInviteViaCp: publicProcedure
    .input(
      z.object({
        token: z.string(),
        cpToken: z.string(),
        reason: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const cpUrl = config.server.controlPlaneUrl;
      const payload = await verifyCpJwt<{
        sub: string;
        email: string;
        type: string;
      }>(input.cpToken, cpUrl);
      if (!payload || payload.type !== "invite-accept") {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Invalid CP token",
        });
      }

      const invite = await db.query.invites.findFirst({
        where: eq(invites.token, input.token),
      });
      if (!invite) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Invite not found" });
      }
      if (invite.email.toLowerCase() !== payload.email.toLowerCase()) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Invite is not addressed to CP principal email",
        });
      }

      await db.delete(invites).where(eq(invites.id, invite.id));
      void notifyCpInviteLifecycle({
        inviteToken: invite.token,
        event: "rejected",
        actorEmail: payload.email,
        actorUserId: payload.sub,
        reason: input.reason,
      });
      return { success: true };
    }),

  /**
   * Reject an invite addressed to the current user (recipient decline).
   */
  rejectInvite: protectedProcedure
    .input(z.object({ id: z.string().uuid(), reason: z.string().optional() }))
    .mutation(async ({ input, ctx }) => {
      const me = await db.query.users.findFirst({
        where: eq(users.id, ctx.userId),
        columns: { email: true },
      });
      if (!me?.email) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "No email found for current user",
        });
      }
      const invite = await db.query.invites.findFirst({
        where: eq(invites.id, input.id),
      });
      if (!invite) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Invite not found" });
      }
      if (invite.email.toLowerCase() !== me.email.toLowerCase()) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Invite is not addressed to current user",
        });
      }
      await db.delete(invites).where(eq(invites.id, input.id));
      void notifyCpInviteLifecycle({
        inviteToken: invite.token,
        event: "rejected",
        actorEmail: me.email,
        actorUserId: ctx.userId,
        reason: input.reason,
      });
      auditLog({
        subjectType: "invite",
        action: "delete",
        phase: "completed",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: invite.workspaceId ?? undefined,
        data: {
          type: invite.type,
          reason: input.reason ?? null,
          disposition: "rejected_by_recipient",
        },
      });
      return { success: true };
    }),

  /**
   * Get workspace-level MCP server configurations.
   * These are user-added MCP servers applied to all AI requests in this workspace.
   */
  getMcpServers: protectedProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ input, ctx }) => {
      // Verify member access
      const member = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, input.workspaceId),
          eq(workspaceMembers.userId, ctx.userId)
        ),
      });
      if (!member) throw new TRPCError({ code: "FORBIDDEN" });

      const ws = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, input.workspaceId),
        columns: { settings: true },
      });
      return ((ws?.settings as WorkspaceSettings)?.mcpServers ??
        []) as McpServerConfig[];
    }),

  /**
   * Update workspace-level MCP server configurations.
   * Replaces the entire mcpServers array. Requires editor+ role.
   */
  updateMcpServers: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        servers: z.array(
          z.object({
            id: z.string().min(1),
            name: z.string().min(1),
            transport: z.enum(["stdio", "http"]),
            command: z.string().optional(),
            args: z.array(z.string()).optional(),
            url: z.string().url().optional(),
            env: z.record(z.string(), z.string()).optional(),
            enabled: z.boolean().optional().default(true),
          })
        ),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Require editor+ role
      const member = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, input.workspaceId),
          eq(workspaceMembers.userId, ctx.userId)
        ),
      });
      if (!member) throw new TRPCError({ code: "FORBIDDEN" });
      if (!["editor", "admin", "owner"].includes(member.role ?? "")) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Editor role required to manage MCP servers",
        });
      }

      // Merge mcpServers into JSONB settings (preserves other settings fields)
      await db
        .update(workspaces)
        .set({
          settings: drizzleSql`settings || ${JSON.stringify({ mcpServers: input.servers })}::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(workspaces.id, input.workspaceId));

      return { count: input.servers.length };
    }),
});
