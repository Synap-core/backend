/**
 * Agent Users Router - AI Agent User Management
 *
 * AI agents are first-class users with workspace memberships and role-based permissions.
 * Workspace owners/admins can create, list, update, and remove agent users.
 */

import { z } from "zod";
import { router, protectedProcedure, podAdminProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { db, eq, and, inArray, drizzleSql } from "@synap/database";
import { userVisibleWhere } from "../utils/user-visible-where.js";
import { ScopeFilterShape, resolveScope } from "../utils/scope-filter.js";
import type { Lens } from "../access/context.js";
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

/**
 * Floor-first agent-user fetch shared by `list` and `listAll`.
 *
 * Floor = (every agent that is a member of a workspace the caller can see —
 * `userVisibleWhere` is the security boundary) UNION (pod-wide agents — agent
 * users with NO membership row anywhere, which belong to the whole pod and so
 * surface in every lens state). The workspace lens only NARROWS the
 * membership-tied half; pod-wide agents are ALWAYS included, except when the
 * lens is `null` (= pod-wide only). The lens can never widen past the floor.
 */
async function queryAgentUsers(ctx: { userId: string }, workspaceLens: Lens) {
  // Membership-tied agents — the caller's accessible agents. `userVisibleWhere`
  // is the structural floor (only workspaces the caller can see); the lens
  // narrows within it. `null` lens = no tied rows (pod-wide only).
  const tiedConditions = [
    eq(users.userType, "agent"),
    userVisibleWhere(workspaceMembers.workspaceId, ctx.userId),
  ];

  let includeTied = true;
  if (workspaceLens === null) {
    includeTied = false;
  } else if (Array.isArray(workspaceLens)) {
    // Empty array = no narrow (the floor) — never silently match zero rows.
    if (workspaceLens.length > 0) {
      tiedConditions.push(inArray(workspaceMembers.workspaceId, workspaceLens));
    }
  } else if (typeof workspaceLens === "string") {
    tiedConditions.push(eq(workspaceMembers.workspaceId, workspaceLens));
  }

  const tied = includeTied
    ? await db
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
        .where(and(...tiedConditions))
    : [];

  // Pod-wide agents — agent users with NO workspace membership anywhere. These
  // shared helpers (e.g. a pod-level Twin) belong to the whole pod and appear
  // in every workspace; their role/joinedAt are null (no membership row).
  const podWideRows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      agentMetadata: users.agentMetadata,
    })
    .from(users)
    .where(
      and(
        eq(users.userType, "agent"),
        drizzleSql`NOT EXISTS (SELECT 1 FROM ${workspaceMembers} WHERE ${workspaceMembers.userId} = ${users.id})`
      )
    );

  const podWide = podWideRows.map((r) => ({
    ...r,
    role: null as string | null,
    joinedAt: null as Date | null,
  }));

  return [...tied, ...podWide];
}

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
          requiredPermission: "read",
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
        // Dual-write: mirror agent-identity fields to real columns
        agentType: resolvedAgentType,
        agentTemplate: agentMetadata.agentTemplate ?? null,
        createdByUserId: ctx.userId,
        isPersonalAgent: false,
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
   * THE one door for agent users (collapses the old list/listAll split).
   *
   * Floor = the caller's accessible agents (members of any workspace the caller
   * can see, via `userVisibleWhere`) UNION pod-wide agents (no membership row —
   * pod-level helpers that appear everywhere). The workspace lens then NARROWS
   * the membership-tied half; pod-wide agents are always included:
   *   - no `workspaceId` (and no active-ws header) → ALL my agents + pod-wide
   *   - active-ws header / a `workspaceId` → that workspace's agents + pod-wide
   *   - `workspaceId: null` → pod-wide agents only
   *   - `workspaceId: [a, b]` → those workspaces' agents (union) + pod-wide
   * No project axis (agents aren't project-scoped). This replaces the old
   * upfront membership gate with `userVisibleWhere` as the structural floor —
   * a stale/forged workspace id can only narrow, never widen access.
   */
  list: protectedProcedure
    .input(z.object({ workspaceId: ScopeFilterShape.workspaceId }))
    .query(async ({ input, ctx }) => {
      const { workspaceLens } = resolveScope(ctx, input);
      return queryAgentUsers(ctx, workspaceLens);
    }),

  /**
   * @deprecated Use `list` (the canonical scope-aware door) instead. Thin alias
   * kept for existing call sites: same logic with NO workspace lens, so it reads
   * the user floor — every accessible agent across all the caller's workspaces
   * PLUS pod-wide agents. NOTE: this now ALSO includes pod-wide agents (the old
   * listAll omitted them), per the "agents are pod-wide actors" decision.
   */
  listAll: protectedProcedure.query(async ({ ctx }) => {
    return queryAgentUsers(ctx, undefined);
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
        if ("denied" in perm) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: perm.reason ?? "Denied",
          });
        }
        if (!perm.granted) {
          return {
            status: "proposed" as const,
            proposalId: perm.proposalId,
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

      // Find every agent user created by this userId using the promoted column.
      const owned = await db
        .select({
          id: users.id,
          agentMetadata: users.agentMetadata,
        })
        .from(users)
        .where(
          and(
            eq(users.userType, "agent"),
            eq(users.createdByUserId, input.userId)
          )
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
