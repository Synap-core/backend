/**
 * Workspaces router — membership + invitation clusters (workspace-scoped
 * invites, pod invites, and the CP-invite public procedures). Extracted
 * verbatim from `workspaces.ts` during router-decomposition Wave 6 — no
 * logic changed. Composed back into `workspacesRouter` by the barrel so the
 * generated `workspaces:` type stays byte-identical.
 */

import { z } from "zod";
import { protectedProcedure, publicProcedure } from "../../trpc.js";
import {
  db,
  eq,
  and,
  desc,
  inArray,
  or,
  gt,
  workspaces,
  workspaceMembers,
  podMembers,
  invites,
  getDb,
  eventRepository,
  WorkspaceRepository,
  WorkspaceMemberRepository,
  drizzleSql,
  users,
  createWorkspaceFromDefinition,
  ensureTeamPersonForMember,
  detachTeamMemberFacet,
  backfillTeamPersonBridge as runBackfillTeamPersonBridge,
  type WorkspaceDefinitionInput,
} from "@synap/database";
import { verifyCpJwt } from "../../utils/jwks-client.js";
import { TRPCError } from "@trpc/server";
import { randomBytes } from "crypto";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import { materializePodAdminsIntoWorkspace } from "../../utils/workspace-role.js";
import { auditLog } from "../../utils/audit-log.js";
import { getBoss } from "@synap/events";
import { kratosAdmin } from "@synap/auth";
import { config } from "@synap-core/core";
import {
  ensureAgentThread,
  ensureWorkspaceGroupChannel,
  ensureProactiveFeedChannel,
  getAgentIdBySlug,
} from "../../utils/personal-channel.js";
import {
  materializeWorkspaceCore,
  type MaterializeCoreResult,
  ComposeBaseUnavailableError,
  DependencyResolutionError,
  ComposeBaseNotFoundError,
} from "../../services/workspace-materialization-service.js";
import {
  logger,
  notifyCpInviteSync,
  notifyCpInviteLifecycle,
} from "./helpers.js";

export const inviteProcedures = {
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
      // Shared singleton — a fresh EventRepository has no registered hooks, so
      // its emitCompleted() append would silently never reach the
      // realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
      const memberRepo = new WorkspaceMemberRepository(dbConn, eventRepo);

      const member = await memberRepo.add(
        {
          workspaceId: input.workspaceId,
          userId: input.userId,
          role: input.role,
        },
        ctx.userId
      );

      // Team roster → person bridge (best-effort; never blocks membership)
      void ensureTeamPersonForMember(dbConn, {
        memberUserId: input.userId,
        workspaceId: input.workspaceId,
        ownerUserId: ctx.userId,
      }).catch((err) => {
        logger.warn(
          { err, memberUserId: input.userId, workspaceId: input.workspaceId },
          "Failed to ensure team person for member"
        );
      });

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
      // Shared singleton — a fresh EventRepository has no registered hooks, so
      // its emitCompleted() append would silently never reach the
      // realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
      const memberRepo = new WorkspaceMemberRepository(dbConn, eventRepo);

      await memberRepo.remove(
        {
          workspaceId: input.workspaceId,
          userId: input.userId,
        },
        ctx.userId
      );

      // Team roster → person bridge: soft-detach team-member facet (best-effort)
      void detachTeamMemberFacet(dbConn, {
        memberUserId: input.userId,
        workspaceId: input.workspaceId,
        ownerUserId: ctx.userId,
      }).catch((err) => {
        logger.warn(
          {
            err,
            memberUserId: input.userId,
            workspaceId: input.workspaceId,
          },
          "Failed to detach team-member facet on member remove"
        );
      });

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
   * Backfill person entities + team-member facets for all human workspace members.
   * Owner/admin only. Idempotent (ensureTeamPersonForMember is safe to re-run).
   */
  backfillTeamPersonBridge: protectedProcedure
    .input(z.object({ workspaceId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, input.workspaceId),
          eq(workspaceMembers.userId, ctx.userId)
        ),
        columns: { role: true },
      });

      if (
        !membership ||
        (membership.role !== "owner" && membership.role !== "admin")
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "Backfilling the team-person bridge requires owner or admin access.",
        });
      }

      const dbConn = await getDb();
      return runBackfillTeamPersonBridge(dbConn, {
        workspaceId: input.workspaceId,
        ownerUserId: ctx.userId,
      });
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
      // Shared singleton — a fresh EventRepository has no registered hooks, so
      // its emitCompleted() append would silently never reach the
      // realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
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

      // 4. If this promotion made the target a pod admin (admin of the
      // `pod-admin` system workspace), materialize them into every EXISTING
      // pod_visible/pod_joinable workspace so their admin write reaches shared
      // surfaces. The materialization is idempotent + owner-first — re-running
      // for every pod-visible workspace adds only the newly-promoted admin (all
      // existing pod-admin rows no-op). GATED to the pod-admin workspace + admin
      // role; best-effort/non-fatal (fail-closed: a failure grants LESS, never
      // more — the 0217 backfill / next trigger reconciles).
      if (input.role === "admin") {
        try {
          const ws = await db.query.workspaces.findFirst({
            where: eq(workspaces.id, input.workspaceId),
            columns: { systemSlug: true },
          });
          if (ws?.systemSlug === "pod-admin") {
            const podVisible = await db.query.workspaces.findMany({
              where: drizzleSql`${workspaces.settings}->>'workspaceVisibility' IN ('pod_visible', 'pod_joinable')`,
              columns: { id: true, archivedAt: true },
            });
            for (const w of podVisible) {
              if (w.archivedAt != null) continue;
              await materializePodAdminsIntoWorkspace(w.id);
            }
          }
        } catch (err) {
          logger.warn(
            { err, workspaceId: input.workspaceId, userId: input.userId },
            "Failed to materialize newly-promoted pod admin into pod-visible workspaces (non-fatal)"
          );
        }
      }

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

      // If a stale account exists for this email (no workspace memberships),
      // clean it up so the new invite can be accepted without a Kratos 409.
      const staleUser = await db.query.users.findFirst({
        where: eq(users.email, input.email.trim().toLowerCase()),
        columns: { id: true },
      });
      if (staleUser) {
        const hasAnyMembership = await db.query.workspaceMembers.findFirst({
          where: eq(workspaceMembers.userId, staleUser.id),
          columns: { workspaceId: true },
        });
        if (!hasAnyMembership) {
          try {
            await kratosAdmin.deleteIdentity({ id: staleUser.id });
          } catch {
            // Identity may have already been removed — proceed with DB cleanup.
          }
          await db.delete(users).where(eq(users.id, staleUser.id));
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
        emailSent: !!cpUrl,
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
            eq(invites.workspaceId, input.workspaceId),
            gt(invites.expiresAt, new Date())
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
          where: and(
            eq(invites.type, "pod"),
            gt(invites.expiresAt, new Date())
          ),
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
      // Shared singleton — a fresh EventRepository has no registered hooks, so
      // its emitCompleted() append would silently never reach the
      // realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
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
        // Team roster → person bridge (best-effort; never blocks membership)
        void ensureTeamPersonForMember(dbConn, {
          memberUserId: ctx.userId,
          workspaceId: invite.workspaceId,
          ownerUserId: invite.invitedBy ?? ctx.userId,
        }).catch((err) => {
          logger.warn(
            {
              err,
              memberUserId: ctx.userId,
              workspaceId: invite.workspaceId,
            },
            "Failed to ensure team person for member on invite accept"
          );
        });
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
        // Pod invite. ADDITIVE (Membership → Visibility, Wave 1): record durable
        // pod-membership identity. The workspace fan-out below is KEPT — removing
        // it now would regress visibility before Wave 2's floor consults
        // pod_members. onConflictDoNothing: one row per user_id.
        await db
          .insert(podMembers)
          .values({
            userId: ctx.userId,
            podRole: "member",
            invitedBy: invite.invitedBy ?? null,
          })
          .onConflictDoNothing();
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
          // Team roster → person bridge (best-effort; never blocks membership)
          void ensureTeamPersonForMember(dbConn, {
            memberUserId: ctx.userId,
            workspaceId: ws.id,
            ownerUserId: invite.invitedBy ?? ctx.userId,
          }).catch((err) => {
            logger.warn(
              { err, memberUserId: ctx.userId, workspaceId: ws.id },
              "Failed to ensure team person for member on pod invite accept"
            );
          });
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
   * List ALL members across every workspace the caller has access to,
   * deduplicated by user. The operator's "pod-wide roster" view in
   * settings/members reads this — see Eve dashboard
   * `app/(os)/settings/members/page.tsx`.
   *
   * Permission model (intentionally permissive read):
   *   • Caller must be a member of at least one workspace.
   *   • Returned membership rows are restricted to workspaces the caller
   *     is also a member of — we never expose memberships from
   *     workspaces the caller can't see. (Conservative: this is the
   *     same surface listMembers already exposes per-workspace.)
   *
   * Shape:
   *   {
   *     id, email, name, avatarUrl,
   *     primaryRole: "owner" | "admin" | "editor" | "viewer",
   *     workspaceCount: number,
   *     workspaces: Array<{ id, name, role, joinedAt }>
   *   }
   *
   * `primaryRole` is the highest-precedence role across the user's
   * memberships in workspaces the caller can see. Order:
   *   owner > admin > editor > viewer
   */
  listPodMembers: protectedProcedure.query(async ({ ctx }) => {
    // 1. Find every workspace the caller belongs to.
    const myMemberships = await db.query.workspaceMembers.findMany({
      where: eq(workspaceMembers.userId, ctx.userId),
      columns: { workspaceId: true },
    });
    const accessibleWorkspaceIds = myMemberships.map((m) => m.workspaceId);
    if (accessibleWorkspaceIds.length === 0) return [];

    // 2. Pull every membership row for those workspaces, joined with
    //    user + workspace metadata for display.
    const rows = await db.query.workspaceMembers.findMany({
      where: inArray(workspaceMembers.workspaceId, accessibleWorkspaceIds),
      with: {
        user: {
          columns: {
            id: true,
            email: true,
            name: true,
            avatarUrl: true,
            userType: true,
          },
        },
        workspace: { columns: { id: true, name: true } },
      },
    });

    // 3. Deduplicate by userId. Compute the highest role across the
    //    user's memberships (operator's lens).
    const roleRank: Record<string, number> = {
      owner: 4,
      admin: 3,
      editor: 2,
      viewer: 1,
    };
    type WorkspaceRef = {
      id: string;
      name: string;
      role: string;
      joinedAt: Date;
    };
    const byUser = new Map<
      string,
      {
        id: string;
        email: string;
        name: string | null;
        avatarUrl: string | null;
        userType: string;
        primaryRole: string;
        workspaces: WorkspaceRef[];
      }
    >();
    for (const r of rows) {
      // Skip rows whose user row is missing (orphaned membership) and
      // skip non-human users (agents) — they show up in
      // workspace_members for governance reasons but the operator
      // roster is for human teammates.
      if (!r.user) continue;
      if (r.user.userType !== "human") continue;
      const existing = byUser.get(r.user.id);
      const wsRef: WorkspaceRef = {
        id: r.workspace?.id ?? r.workspaceId,
        name: r.workspace?.name ?? "",
        role: r.role,
        joinedAt: r.joinedAt,
      };
      if (!existing) {
        byUser.set(r.user.id, {
          id: r.user.id,
          email: r.user.email,
          name: r.user.name,
          avatarUrl: r.user.avatarUrl,
          userType: r.user.userType,
          primaryRole: r.role,
          workspaces: [wsRef],
        });
      } else {
        existing.workspaces.push(wsRef);
        if ((roleRank[r.role] ?? 0) > (roleRank[existing.primaryRole] ?? 0)) {
          existing.primaryRole = r.role;
        }
      }
    }

    // 4. Stable sort: operator first, then by primaryRole desc, then
    //    by name/email asc.
    const list = [...byUser.values()].map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      avatarUrl: u.avatarUrl,
      primaryRole: u.primaryRole as "owner" | "admin" | "editor" | "viewer",
      workspaceCount: u.workspaces.length,
      workspaces: u.workspaces,
    }));
    list.sort((a, b) => {
      if (a.id === ctx.userId) return -1;
      if (b.id === ctx.userId) return 1;
      const dr =
        (roleRank[b.primaryRole] ?? 0) - (roleRank[a.primaryRole] ?? 0);
      if (dr !== 0) return dr;
      const an = (a.name ?? a.email).toLowerCase();
      const bn = (b.name ?? b.email).toLowerCase();
      return an.localeCompare(bn);
    });
    return list;
  }),

  /**
   * List ALL pending invites across every workspace the caller can
   * manage, plus pod-level invites if the caller is a pod owner.
   *
   * Used by the Eve members page to show a single "Pending invites"
   * table. Returns invites with workspace name (when applicable) so
   * the UI doesn't need a second round-trip per row.
   *
   * Permission model:
   *   • Workspace invites: returned only for workspaces where caller
   *     is owner or admin (matches createInvite/revokeInvite gates).
   *   • Pod invites: returned only when the caller owns at least one
   *     workspace (matches the pod-invite gate elsewhere).
   */
  listAllInvites: protectedProcedure.query(async ({ ctx }) => {
    const myMemberships = await db.query.workspaceMembers.findMany({
      where: eq(workspaceMembers.userId, ctx.userId),
      columns: { workspaceId: true, role: true },
    });
    const manageableWorkspaceIds = myMemberships
      .filter((m) => m.role === "owner" || m.role === "admin")
      .map((m) => m.workspaceId);
    const isPodOwner = myMemberships.some((m) => m.role === "owner");

    // Query workspace invites for manageable workspaces + pod invites
    // for pod owners. Empty arrays bail early so we don't issue empty
    // IN-clause queries.
    const conditions = [];
    if (manageableWorkspaceIds.length > 0) {
      conditions.push(
        and(
          eq(invites.type, "workspace"),
          inArray(invites.workspaceId, manageableWorkspaceIds)
        )
      );
    }
    if (isPodOwner) {
      conditions.push(eq(invites.type, "pod"));
    }
    if (conditions.length === 0) return [];

    const rows = await db.query.invites.findMany({
      where: conditions.length === 1 ? conditions[0] : or(...conditions),
      with: { workspace: { columns: { id: true, name: true } } },
      orderBy: [desc(invites.createdAt)],
    });

    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      email: r.email,
      role: r.role,
      token: r.token,
      workspaceId: r.workspaceId,
      workspaceName: r.workspace?.name ?? null,
      invitedBy: r.invitedBy,
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
    }));
  }),

  /**
   * Remove a user from EVERY workspace the caller can manage.
   * Pod-wide eviction in a single call.
   *
   * Why this exists (vs. iterating removeMember from the UI):
   *   • One permission check vs. N round-trips.
   *   • One audit-log row summarising the eviction.
   *   • Atomic "no-op when not allowed" semantics — if the caller
   *     can't manage ANY of the target's workspaces we throw
   *     FORBIDDEN, instead of partial removal.
   *
   * Permission model:
   *   • Caller must be owner or admin of at least one workspace
   *     containing the target user.
   *   • Removal happens for every workspace where:
   *       (a) caller is owner|admin, AND
   *       (b) target is currently a member.
   *   • Caller cannot remove themselves (use a per-workspace
   *     leaveWorkspace procedure for that — out of scope here).
   *   • Removal is blocked when it would leave a workspace with zero
   *     owners (last-owner guard).
   */
  removeFromPod: protectedProcedure
    .input(z.object({ userId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      if (input.userId === ctx.userId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "You can't remove yourself from the pod.",
        });
      }

      // Fetch the caller's manageable workspaces and the target's
      // workspaces in parallel.
      const [myMemberships, targetMemberships] = await Promise.all([
        db.query.workspaceMembers.findMany({
          where: eq(workspaceMembers.userId, ctx.userId),
          columns: { workspaceId: true, role: true },
        }),
        db.query.workspaceMembers.findMany({
          where: eq(workspaceMembers.userId, input.userId),
          columns: { workspaceId: true, role: true },
        }),
      ]);

      const manageableWs = new Set(
        myMemberships
          .filter((m) => m.role === "owner" || m.role === "admin")
          .map((m) => m.workspaceId)
      );
      const targetWs = new Map(
        targetMemberships.map((m) => [m.workspaceId, m.role])
      );

      // Intersection: workspaces where caller can act AND target is
      // currently a member.
      const toRemove = [...targetWs.keys()].filter((wid) =>
        manageableWs.has(wid)
      );
      if (toRemove.length === 0) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "You don't have permission to remove this member from any workspace.",
        });
      }

      // Last-owner guard: if removing the target would leave any
      // workspace with zero owners, refuse the whole operation.
      // Cheaper to do it once with a single GROUP BY than one query
      // per workspace.
      for (const wid of toRemove) {
        if (targetWs.get(wid) !== "owner") continue;
        const owners = await db.query.workspaceMembers.findMany({
          where: and(
            eq(workspaceMembers.workspaceId, wid),
            eq(workspaceMembers.role, "owner")
          ),
          columns: { userId: true },
        });
        if (owners.length <= 1) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Cannot remove the last owner of a workspace. Promote another member first.",
          });
        }
      }

      // Execute removals — best-effort serial; we collect failures so
      // a single broken workspace doesn't abort the rest. Audit-log
      // covers each removal for forensics.
      const dbConn = await getDb();
      // Shared singleton — a fresh EventRepository has no registered hooks, so
      // its emitCompleted() append would silently never reach the
      // realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
      const memberRepo = new WorkspaceMemberRepository(dbConn, eventRepo);
      const removed: string[] = [];
      const errors: Array<{ workspaceId: string; error: string }> = [];
      for (const wid of toRemove) {
        try {
          await memberRepo.remove(
            { workspaceId: wid, userId: input.userId },
            ctx.userId
          );
          removed.push(wid);
          // Team roster → person bridge: soft-detach team-member facet (best-effort)
          void detachTeamMemberFacet(dbConn, {
            memberUserId: input.userId,
            workspaceId: wid,
            ownerUserId: ctx.userId,
          }).catch((err) => {
            logger.warn(
              {
                err,
                memberUserId: input.userId,
                workspaceId: wid,
              },
              "Failed to detach team-member facet on removeFromPod"
            );
          });
        } catch (err) {
          errors.push({
            workspaceId: wid,
            error: err instanceof Error ? err.message : "Unknown error",
          });
        }
      }

      // If user has no remaining memberships, clean up their pod identity
      // so the same email can be re-invited later.
      if (removed.length > 0) {
        const remainingMembership = await db.query.workspaceMembers.findFirst({
          where: eq(workspaceMembers.userId, input.userId),
          columns: { workspaceId: true },
        });
        if (!remainingMembership) {
          try {
            await kratosAdmin.deleteIdentity({ id: input.userId });
          } catch (err) {
            logger.warn(
              { err, userId: input.userId },
              "Failed to delete Kratos identity on pod removal — re-invite may not work"
            );
          }
          await db.delete(users).where(eq(users.id, input.userId));
        }
      }

      auditLog({
        subjectType: "workspaceMember",
        action: "removeFromPod",
        phase: "completed",
        subjectId: input.userId,
        userId: ctx.userId,
        data: {
          targetUserId: input.userId,
          removedFromWorkspaces: removed,
          errors,
        },
      });

      return {
        status: "removed" as const,
        removedFromWorkspaces: removed.length,
        totalWorkspaces: toRemove.length,
        errors,
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
            eq(workspaces.packageSlug, input.pluginId),
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
        const definition = input.definition as WorkspaceDefinitionInput;

        // Resolve template-composition dependencies + compose overlays through
        // the SAME shared core the in-app `createFromDefinition` door drives, so
        // a COMPOSED template (`dependencies[]` — e.g. openclaw's "the Arch"
        // enterprise overlays) provisioned via this M2M door resolves its deps
        // instead of materializing a rogue standalone. `deferCreate:true` keeps
        // THIS door's own create + workspace-init enqueue for the no-compose
        // case (the shared core never enqueues under `deferCreate`, so there is
        // NO double-enqueue). Only runs when deps are declared — a plain plugin
        // template skips it and behaves byte-for-byte as before.
        if ((definition as { dependencies?: unknown[] }).dependencies?.length) {
          let core: MaterializeCoreResult;
          try {
            core = await materializeWorkspaceCore({
              definition,
              userId: systemUserId,
              // The package's own identity for the cycle guard.
              selfSlug: input.pluginId,
              deferCreate: true,
            });
          } catch (err) {
            // A compose was requested but its base could not be resolved — do
            // NOT fall through to creating a rogue standalone overlay.
            if (err instanceof ComposeBaseUnavailableError) {
              const unresolved = err.dependencies.find(
                (d) => d.relation === "compose"
              );
              throw new TRPCError({
                code: "BAD_REQUEST",
                message:
                  unresolved?.message ??
                  "compose base not available — the base template must be installed on the pod first",
              });
            }
            if (err instanceof DependencyResolutionError) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: `Dependency resolution failed: ${err.message}`,
              });
            }
            if (err instanceof ComposeBaseNotFoundError) {
              throw new TRPCError({
                code: "NOT_FOUND",
                message: "compose base workspace not found",
              });
            }
            throw err;
          }
          if (core.status === "composed") {
            // A compose overlay layered onto its existing base — no new
            // workspace, so no workspace-init enqueue (the base already has its
            // defaults). Return the base's id.
            logger.info(
              {
                workspaceId: core.composeTargetWorkspaceId,
                pluginId: input.pluginId,
              },
              "Plugin workspace composed onto base (provisioning)"
            );
            return {
              status: "created" as const,
              workspaceId: core.composeTargetWorkspaceId,
            };
          }
          // status "resolved" — deps installed, no compose base. Fall through to
          // this door's own create + enqueue below.
        }

        const result = await createWorkspaceFromDefinition({
          definition,
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
      // Shared singleton — a fresh EventRepository has no registered hooks, so
      // its emitCompleted() append would silently never reach the
      // realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
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

      // The token already grants the holder permission to consume this
      // invite, so echoing the canonical email back is not a leak — the
      // invitee needs it to lock the signup form to the right address.
      // Anyone with the token can already see workspace name + role.
      if (invite.type === "workspace") {
        return {
          expired: false as const,
          type: "workspace" as const,
          workspaceName: invite.workspace?.name ?? "Unknown Workspace",
          inviterName,
          role: invite.role,
          email: invite.email,
          expiresAt: invite.expiresAt,
        };
      } else {
        return {
          expired: false as const,
          type: "pod" as const,
          inviterName,
          role: invite.role,
          email: invite.email,
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
      // Shared singleton — a fresh EventRepository has no registered hooks, so
      // its emitCompleted() append would silently never reach the
      // realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
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
        // Team roster → person bridge (best-effort; never blocks membership)
        void ensureTeamPersonForMember(dbConn, {
          memberUserId: podUser.id,
          workspaceId: invite.workspaceId,
          ownerUserId: invite.invitedBy ?? podUser.id,
        }).catch((err) => {
          logger.warn(
            {
              err,
              memberUserId: podUser.id,
              workspaceId: invite.workspaceId,
            },
            "Failed to ensure team person for member on CP invite accept"
          );
        });
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
        // Pod invite via CP proxy. ADDITIVE (Membership → Visibility, Wave 1):
        // record durable pod-membership identity. The workspace fan-out below is
        // KEPT — removing it now would regress visibility before Wave 2's floor
        // consults pod_members. onConflictDoNothing: one row per user_id.
        await db
          .insert(podMembers)
          .values({
            userId: podUser.id,
            podRole: "member",
            invitedBy: invite.invitedBy ?? null,
          })
          .onConflictDoNothing();
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
          // Team roster → person bridge (best-effort; never blocks membership)
          void ensureTeamPersonForMember(dbConn, {
            memberUserId: podUser.id,
            workspaceId: ws.id,
            ownerUserId: invite.invitedBy ?? podUser.id,
          }).catch((err) => {
            logger.warn(
              { err, memberUserId: podUser.id, workspaceId: ws.id },
              "Failed to ensure team person for member on CP pod invite accept"
            );
          });
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
};
