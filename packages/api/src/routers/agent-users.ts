/**
 * Agent Users Router - AI Agent User Management
 *
 * AI agents are first-class users with workspace memberships and role-based permissions.
 * Workspace owners/admins can create, list, update, and remove agent users.
 */

import { z } from "zod";
import { router, protectedProcedure, podAdminProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { db, eq, and, inArray } from "@synap/database";
import { userVisibleWhere } from "../utils/user-visible-where.js";
import {
  users,
  workspaceMembers,
  apiKeys,
  workspaces,
} from "@synap/database/schema";
import type { WorkspaceSettings } from "@synap/database/schema";
import { verifyPermission } from "@synap/database";
import { randomUUID } from "crypto";
import { auditLog } from "../utils/audit-log.js";
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import type { AgentMetadata } from "@synap/database/schema";

export const agentUsersRouter = router({
  /**
   * Create an AI agent user and add it to a workspace
   */
  create: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid(),
        agentType: z.string().min(1).max(50).optional(),
        name: z.string().min(1).max(100),
        role: z.enum(["admin", "editor", "viewer"]).optional(),
        description: z.string().optional(),
        capabilities: z.array(z.string()).optional(),
        template: z.enum(["twin", "assistant", "custom"]).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (input.template === "twin") {
        // Any workspace member can request their own twin.
        // Admins: always allowed. Members: requires allowSelfServiceTwin governance setting.
        const memberPerm = await verifyPermission({
          db,
          userId: ctx.userId,
          workspace: { id: input.workspaceId },
          requiredPermission: "member",
        });
        if (!memberPerm.allowed) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "You must be a workspace member to create an agent.",
          });
        }

        const adminPerm = await verifyPermission({
          db,
          userId: ctx.userId,
          workspace: { id: input.workspaceId },
          requiredPermission: "manage",
        });

        if (!adminPerm.allowed) {
          const [ws] = await db
            .select({ settings: workspaces.settings })
            .from(workspaces)
            .where(eq(workspaces.id, input.workspaceId))
            .limit(1);
          const governance = (ws?.settings as WorkspaceSettings | undefined)
            ?.aiGovernance;
          if (!governance?.allowSelfServiceTwin) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message:
                "Self-service twin creation is disabled. Ask a workspace admin to enable it in workspace governance settings (aiGovernance.allowSelfServiceTwin).",
            });
          }
        }
      } else {
        // assistant / custom: only admins
        const perm = await verifyPermission({
          db,
          userId: ctx.userId,
          workspace: { id: input.workspaceId },
          requiredPermission: "manage",
        });
        if (!perm.allowed) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message:
              perm.reason ||
              "Only workspace owners and admins can manage agent users",
          });
        }
      }

      const agentId = randomUUID();
      const shortId = agentId.slice(0, 8);

      // Build metadata and role based on template
      let resolvedRole: "admin" | "editor" | "viewer" = input.role ?? "editor";
      const agentMetadata: AgentMetadata = {
        agentType: input.agentType ?? "custom",
        description: input.description,
        createdByUserId: ctx.userId,
        capabilities: input.capabilities,
      };

      if (input.template === "twin") {
        agentMetadata.agentTemplate = "twin";
        agentMetadata.agentType = input.agentType ?? "twin";
        agentMetadata.writesRequireProposal = false;
        agentMetadata.isPersonalAgent = false;

        // Inherit the creator's current role in this workspace
        const [creatorMembership] = await db
          .select({ role: workspaceMembers.role })
          .from(workspaceMembers)
          .where(
            and(
              eq(workspaceMembers.userId, ctx.userId),
              eq(workspaceMembers.workspaceId, input.workspaceId)
            )
          )
          .limit(1);

        if (creatorMembership) {
          resolvedRole = creatorMembership.role as
            | "admin"
            | "editor"
            | "viewer";
        }
      } else if (input.template === "assistant") {
        agentMetadata.agentTemplate = "assistant";
        agentMetadata.agentType = input.agentType ?? "assistant";
        agentMetadata.writesRequireProposal = true;
        resolvedRole = "editor";
      } else if (input.template === "custom") {
        agentMetadata.agentTemplate = "custom";
        agentMetadata.agentType = input.agentType ?? "custom";
      }

      const resolvedAgentType = agentMetadata.agentType;
      const email = `agent-${resolvedAgentType}-${shortId}@synap.agent`;

      // Create user record
      await db.insert(users).values({
        id: agentId,
        email,
        name: input.name,
        emailVerified: true,
        userType: "agent",
        agentMetadata,
        timezone: "UTC",
        locale: "en",
      });

      // Add to workspace with resolved role
      await db.insert(workspaceMembers).values({
        workspaceId: input.workspaceId,
        userId: agentId,
        role: resolvedRole,
        invitedBy: ctx.userId,
      });

      auditLog({
        subjectType: "agent_user",
        action: "create",
        phase: "completed",
        subjectId: agentId,
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        data: {
          agentType: resolvedAgentType,
          name: input.name,
          role: resolvedRole,
          template: input.template,
        },
      });

      return {
        id: agentId,
        email,
        name: input.name,
        agentType: resolvedAgentType,
        role: resolvedRole,
        template: input.template,
      };
    }),

  /**
   * List AI agent users in a workspace
   */
  list: protectedProcedure
    .input(z.object({ workspaceId: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      // Gate on workspace membership — otherwise any authenticated user could
      // enumerate the agents of any workspace by guessing its id.
      const perm = await verifyPermission({
        db,
        userId: ctx.userId,
        workspace: { id: input.workspaceId },
        requiredPermission: "read",
      });
      if (!perm.allowed) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            perm.reason ?? "You must be a workspace member to view its agents",
        });
      }

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
   * List AI agent users across ALL workspaces the caller belongs to.
   *
   * Same output shape as `list` — consumers can swap variants freely.
   * Returns every agent user that is a member of any workspace the caller
   * is also a member of (pod-wide agents have no workspace membership row
   * and are therefore not surfaced here by design — add to a workspace first).
   */
  listAll: protectedProcedure.query(async ({ ctx }) => {
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
      .innerJoin(workspaceMembers, eq(workspaceMembers.userId, users.id))
      .where(
        and(
          eq(users.userType, "agent"),
          userVisibleWhere(workspaceMembers.workspaceId, ctx.userId)
        )
      );

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
        writesRequireProposal: z.boolean().optional(),
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
          message:
            perm.reason ||
            "Only workspace owners and admins can manage agent users",
        });
      }

      // Verify the target is actually an agent
      const [agent] = await db
        .select()
        .from(users)
        .where(
          and(eq(users.id, input.agentUserId), eq(users.userType, "agent"))
        )
        .limit(1);

      if (!agent) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Agent user not found",
        });
      }

      // Capabilities are security-sensitive: changing them always goes through
      // the proposal flow (agent.updateCapabilities is in ADMIN_ACTIONS).
      if (input.capabilities !== undefined) {
        const perm = await checkPermissionOrPropose({
          userId: ctx.userId,
          workspaceId: input.workspaceId,
          subjectType: "agent",
          action: "updateCapabilities",
          data: {
            agentUserId: input.agentUserId,
            capabilities: input.capabilities,
          },
        });
        if ("denied" in perm && perm.denied) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: perm.reason ?? "Denied",
          });
        }
        if (!perm.granted) {
          return {
            status: "proposed" as const,
            proposalId: (perm as { proposalId: string }).proposalId,
          };
        }
      }

      // Update user record
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (input.name) updates.name = input.name;
      if (
        input.description !== undefined ||
        input.capabilities !== undefined ||
        input.writesRequireProposal !== undefined
      ) {
        const existing = (agent.agentMetadata || {}) as Record<string, unknown>;
        updates.agentMetadata = {
          ...existing,
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
          ...(input.capabilities !== undefined
            ? { capabilities: input.capabilities }
            : {}),
          ...(input.writesRequireProposal !== undefined
            ? { writesRequireProposal: input.writesRequireProposal }
            : {}),
        };
      }

      await db
        .update(users)
        .set(updates)
        .where(eq(users.id, input.agentUserId));

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
        data: {
          name: input.name,
          role: input.role,
          writesRequireProposal: input.writesRequireProposal,
        },
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
          message:
            perm.reason ||
            "Only workspace owners and admins can manage agent users",
        });
      }

      // Verify the target is actually an agent
      const [agent] = await db
        .select()
        .from(users)
        .where(
          and(eq(users.id, input.agentUserId), eq(users.userType, "agent"))
        )
        .limit(1);

      if (!agent) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Agent user not found",
        });
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

  /**
   * Pod-admin: remove every agent_user row owned by the given userId.
   *
   * "Owned" means rows whose `agentMetadata.createdByUserId` equals the given
   * userId. Idempotent — running with no matches returns `removedCount: 0`.
   * Cascade: also soft-revokes every API key owned by each removed agent
   * (mirrors `apiKeys.adminRevokeAllForUser` inline so a single call cleans
   * up agents + their hub keys atomically). Admins cannot remove their own
   * agent rows via this endpoint to prevent self-lockout.
   */
  removeByUserId: podAdminProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        reason: z.string().max(500).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (input.userId === ctx.userId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "You cannot remove your own agent users via this admin endpoint.",
        });
      }

      // Find every agent user created by this userId. agentMetadata is a typed
      // JSONB column — filter all `userType='agent'` rows then match in-memory
      // (agent populations are tiny, so portability beats a raw JSON path).
      const agentRows = await db
        .select({
          id: users.id,
          agentMetadata: users.agentMetadata,
        })
        .from(users)
        .where(eq(users.userType, "agent"));

      const owned = agentRows.filter(
        (row) =>
          (row.agentMetadata as Record<string, unknown> | null)
            ?.createdByUserId === input.userId
      );

      if (owned.length === 0) {
        return { removedCount: 0, revokedKeyCount: 0 };
      }

      const ownedIds = owned.map((r) => r.id);
      const revokeReason =
        input.reason ?? "Cascade revoke: agent user removed by pod admin";

      // Cascade: revoke every active API key owned by these agents in one shot.
      const revokedKeys = await db
        .update(apiKeys)
        .set({
          isActive: false,
          revokedAt: new Date(),
          revokedBy: ctx.userId,
          revokedReason: revokeReason,
        })
        .where(
          and(inArray(apiKeys.userId, ownedIds), eq(apiKeys.isActive, true))
        )
        .returning({ id: apiKeys.id });

      // Remove workspace memberships for every owned agent.
      await db
        .delete(workspaceMembers)
        .where(inArray(workspaceMembers.userId, ownedIds));

      // Delete the agent user rows.
      await db.delete(users).where(inArray(users.id, ownedIds));

      auditLog({
        subjectType: "agent_user",
        action: "delete",
        phase: "completed",
        subjectId: input.userId,
        userId: ctx.userId,
        data: {
          targetUserId: input.userId,
          removedCount: ownedIds.length,
          revokedKeyCount: revokedKeys.length,
          reason: input.reason,
          bulk: true,
        },
      });

      return {
        removedCount: ownedIds.length,
        revokedKeyCount: revokedKeys.length,
      };
    }),
});
