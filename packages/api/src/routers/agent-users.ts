/**
 * Agent Users Router - AI Agent User Management
 *
 * AI agents are first-class users with workspace memberships and role-based permissions.
 * Workspace owners/admins can create, list, update, and remove agent users.
 */

import { z } from "zod";
import {
  router,
  protectedProcedure,
  podAdminProcedure,
  assertPodAdmin,
} from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { db, eq, and, inArray, isNull, drizzleSql } from "@synap/database";
import { revokeApiKeys } from "@synap/database/api-key-revocation";
import { isPodAdmin } from "../utils/workspace-role.js";
import { userVisibleWhere } from "../utils/user-visible-where.js";
import { ScopeFilterShape, resolveScope } from "../utils/scope-filter.js";
import type { Lens } from "../access/context.js";
import {
  users,
  workspaceMembers,
  apiKeys,
  workspaces,
} from "@synap/database/schema";
import type {
  WorkspaceSettings,
  AgentCreatedVia,
} from "@synap/database/schema";
import { verifyPermission } from "@synap/database";
import { randomUUID } from "crypto";
import { auditLog } from "../utils/audit-log.js";
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import type { AgentMetadata } from "@synap/database/schema";
import {
  agentsOperatedBy,
  withAgentPresence,
} from "../services/agent-presence.js";
import { toPodAdminOrigin } from "../utils/pod-admin-origin.js";
import {
  applyAgentPosture,
  readAgentGovernance,
} from "@synap/database/agent-governance";
import { readReversibleDefault } from "@synap/database";
import {
  AGENT_WRITE_MODE_LINE,
  resolveAgentDirection,
  resolveAgentWriteMode,
  type AgentDirection,
  type AgentOrigin,
} from "@synap-core/types/agents";

/**
 * Coverage floor: the values the `users.created_via` column accepts
 * (`AgentCreatedVia`, `@synap/database`) and the origins the direction rule
 * classifies (`AGENT_ORIGINS`, `@synap-core/types/agents`) are the SAME set.
 * A writer that stamps a new origin must widen the column type, which breaks
 * this line until the origin is added to `AGENT_ORIGINS` — which in turn
 * breaks the build until `AGENT_DIRECTION_BY_ORIGIN` classifies it.
 */
type _OriginsAgree = [AgentCreatedVia] extends [AgentOrigin]
  ? [AgentOrigin] extends [AgentCreatedVia]
    ? true
    : never
  : never;
const _originsAgree: _OriginsAgree = true;
void _originsAgree;

/**
 * Floor-first agent-user fetch backing `list`.
 *
 * Floor = (every agent that is a member of a workspace the caller can see —
 * `userVisibleWhere` is the security boundary) UNION (pod-wide agents — agent
 * users with NO membership row anywhere, which belong to the whole pod and so
 * surface in every lens state). The workspace lens only NARROWS the
 * membership-tied half; pod-wide agents are ALWAYS included, except when the
 * lens is `null` (= pod-wide only). The lens can never widen past the floor.
 */
/**
 * The caller's agent roster — the ONE visibility floor for "which agents can
 * this person reach" (`agentUsers.list`, and `captures.giveToAgent`'s pick).
 */
export async function queryAgentUsers(
  ctx: { userId: string },
  workspaceLens: Lens
) {
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
          createdVia: users.createdVia,
          isPersonalAgent: users.isPersonalAgent,
          createdByUserId: users.createdByUserId,
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
      createdVia: users.createdVia,
      isPersonalAgent: users.isPersonalAgent,
      createdByUserId: users.createdByUserId,
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

  // An agent that is a member of several visible workspaces joins once per
  // membership; the roster is one row per AGENT (the first membership wins).
  const seen = new Set<string>();
  const unique = tied.filter((r) => !seen.has(r.id) && !!seen.add(r.id));
  return [...unique, ...podWide];
}

/**
 * Where an agent came from, from the ONE column that records it
 * (`users.created_via`, migration 0225 — backfilled for the pod's own agents by
 * 0285), plus `is_personal_agent` for twins.
 *
 * `builtIn` = the pod made it for itself (the twin, the capture and form agents
 * — `system` — or an Intelligence Service persona — `intelligence-service`)
 * AND it has never held a hub key. Origin alone is not enough: the IS registry
 * (`intelligence-registry.ts`) and surface-agent provisioning mint a
 * `hub_inbound` key for their agents, and an agent that holds (or held) a key
 * is one the key-based mark CAN describe — hiding it as "Built-in" would hide a
 * connected agent. Only a key-less pod agent is one a key-based mark would lie
 * about ("Waiting for first call" forever). `cli` / `ui` are agents a person
 * brought or made; a NULL `created_via` is never claimed as built-in unless it
 * is a twin.
 */
export function withAgentOrigin<
  T extends {
    createdVia: string | null;
    isPersonalAgent: boolean | null;
    activeKeys: number;
    pendingKeys: number;
    revokedKeys: number;
  },
>(
  row: T
): T & { origin: string | null; builtIn: boolean; direction: AgentDirection } {
  // `direction` is the ONE whose-agent rule (`resolveAgentDirection`): the
  // pod's own (`house` — twin, system agents, IS personas, keyed or not) vs one
  // a person brought (`external`). `podMade` below is the same partition, read
  // off it so the two can never disagree.
  const direction = resolveAgentDirection({
    origin: row.createdVia,
    isPersonalAgent: row.isPersonalAgent,
  });
  const podMade = direction === "house";
  const everKeyed = row.activeKeys + row.pendingKeys + row.revokedKeys > 0;
  return {
    ...row,
    origin: row.createdVia,
    builtIn: podMade && !everKeyed,
    direction,
  };
}

/**
 * What the VIEWER may do on one roster row, decided here so no surface offers
 * a verb the pod will refuse:
 *  - `viewerCanDisconnect` — the same gate `disconnect` applies (the agent's
 *    owner, or a pod admin);
 *  - `approveUrl` — the ONE approval door for its pending keys
 *    (`/approve-agents?keys=`, the page `synap init` opens), for that same
 *    viewer; `null` when nothing awaits approval.
 * `pendingKeyIds` stays server-side: the URL is the door.
 */
export function withViewerVerbs<
  T extends { createdByUserId: string | null; pendingKeyIds: string[] },
>(
  row: T,
  viewer: { userId: string; isPodAdmin: boolean; podAdminOrigin: string | null }
): Omit<T, "pendingKeyIds"> & {
  viewerCanDisconnect: boolean;
  approveUrl: string | null;
} {
  const { pendingKeyIds, ...rest } = row;
  const viewerCanDisconnect =
    viewer.isPodAdmin ||
    (!!row.createdByUserId && row.createdByUserId === viewer.userId);
  const approveUrl =
    viewerCanDisconnect && viewer.podAdminOrigin && pendingKeyIds.length > 0
      ? `${viewer.podAdminOrigin}/approve-agents?keys=${pendingKeyIds.map(encodeURIComponent).join(",")}`
      : null;
  return { ...rest, viewerCanDisconnect, approveUrl };
}

export const agentUsersRouter = router({
  /**
   * Create an AI agent user and add it to a workspace
   */
  create: protectedProcedure
    .input(
      z.object({
        // Required for a workspace agent; omit for a pod-wide agent (no
        // membership row — visible in every workspace). Guarded in the handler.
        workspaceId: z.string().uuid().optional(),
        // Opt-in: mint a pod-wide agent-user (no workspace membership, governed
        // as its own principal). Pod-admin only. Mutually exclusive with a twin.
        podWide: z.boolean().optional(),
        agentType: z.string().min(1).max(50).optional(),
        name: z.string().min(1).max(100),
        role: z.enum(["admin", "editor", "viewer"]).optional(),
        description: z.string().optional(),
        capabilities: z.array(z.string()).optional(),
        template: z.enum(["twin", "assistant", "custom"]).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const podWide = input.podWide === true;

      // ── Scope shape guards ────────────────────────────────────────────────
      if (podWide && input.workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "A pod-wide agent has no workspace — omit workspaceId (or omit podWide to create a workspace agent).",
        });
      }
      if (!podWide && !input.workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "workspaceId is required unless podWide is set.",
        });
      }
      if (podWide && input.template === "twin") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "A twin is workspace-scoped (it inherits your membership role) and cannot be pod-wide.",
        });
      }

      // ── Authorization ─────────────────────────────────────────────────────
      // Non-pod-wide branches are guaranteed a workspaceId by the guard above.
      if (podWide) {
        // Pod-wide agents are visible in every workspace — a pod-level action.
        await assertPodAdmin(ctx.userId);
      } else if (input.template === "twin") {
        // Any workspace member can request their own twin.
        // Admins: always allowed. Members: requires allowSelfServiceTwin governance setting.
        const memberPerm = await verifyPermission({
          db,
          userId: ctx.userId,
          workspace: { id: input.workspaceId! },
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
          workspace: { id: input.workspaceId! },
          requiredPermission: "manage",
        });

        if (!adminPerm.allowed) {
          const [ws] = await db
            .select({ settings: workspaces.settings })
            .from(workspaces)
            .where(eq(workspaces.id, input.workspaceId!))
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
          workspace: { id: input.workspaceId! },
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
              eq(workspaceMembers.workspaceId, input.workspaceId!)
            )
          )
          .limit(1);

        if (creatorMembership) {
          resolvedRole = creatorMembership.role as
            "admin" | "editor" | "viewer";
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
        // Provenance: this is the interactive/CLI create door. Default 'ui'; a
        // CLI caller may override once the CLI threads it (0225_users_created_via).
        createdVia: "ui",
        timezone: "UTC",
        locale: "en",
      });

      // Add to workspace with resolved role — pod-wide agents get NO membership
      // row (that absence is exactly what marks them pod-wide in `list`).
      if (!podWide) {
        await db.insert(workspaceMembers).values({
          workspaceId: input.workspaceId!,
          userId: agentId,
          role: resolvedRole,
          invitedBy: ctx.userId,
        });
      }

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
          // Pod-wide agents have no membership role.
          role: podWide ? null : resolvedRole,
          template: input.template,
        },
      });

      return {
        id: agentId,
        email,
        name: input.name,
        agentType: resolvedAgentType,
        // Pod-wide agents have no membership → no workspace role.
        role: podWide ? null : resolvedRole,
        template: input.template,
        podWide,
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
      // + `lastSeenAt` / `host` / `activeKeys` / `pendingKeys` / `revokedKeys`
      // (V1 G3) — the connected signal Settings › Agents and the entry
      // surfaces read — then origin (needs the key counts) and viewer verbs.
      const rows = await withAgentPresence(
        await queryAgentUsers(ctx, workspaceLens)
      );
      const publicOrigin =
        process.env.PUBLIC_URL ||
        (ctx.req ? new URL(ctx.req.url).origin : null);
      const viewer = {
        userId: ctx.userId,
        isPodAdmin: await isPodAdmin(ctx.userId),
        podAdminOrigin: publicOrigin ? toPodAdminOrigin(publicOrigin) : null,
      };
      // `operatedByViewer`: this agent acts on the viewer's behalf (one of its
      // keys is linked to them), so it can see and pick up the viewer's work.
      // The ONE rule `captures.giveToAgent` enforces — a picker filters on it.
      const operated = await agentsOperatedBy(
        ctx.userId,
        rows.map((r) => r.id)
      );
      return rows.map((r) => ({
        ...withViewerVerbs(withAgentOrigin(r), viewer),
        operatedByViewer: operated.has(r.id),
      }));
    }),

  /**
   * How this agent's writes land, from the EFFECTIVE decision inputs — its own
   * override (`readAgentGovernance`, the same reader as the Hub
   * `GET /agent-users/:id/governance`) and the pod default — never the raw
   * `writesRequireProposal` flag. `line` is the one sentence every surface shows.
   */
  governance: protectedProcedure
    .input(z.object({ agentUserId: z.string().uuid() }))
    .query(async ({ input }) => {
      const state = await readAgentGovernance({
        db,
        agentUserId: input.agentUserId,
      });
      if (!state) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Agent user not found",
        });
      }
      const podDefault = await readReversibleDefault(db);
      const writeMode = resolveAgentWriteMode({
        posture: state.posture,
        podDefaultEnabled: podDefault.enabled,
        writesRequireProposal: state.writesRequireProposal,
      });
      return {
        writeMode,
        line: AGENT_WRITE_MODE_LINE[writeMode],
        /** The switch: ON iff this agent has the ask-first override. */
        askFirst: state.posture === "ask-first",
        podDefaultEnabled: podDefault.enabled,
      };
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
      if (input.description !== undefined || input.capabilities !== undefined) {
        const existing = (agent.agentMetadata || {}) as Record<string, unknown>;
        updates.agentMetadata = {
          ...existing,
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
          ...(input.capabilities !== undefined
            ? { capabilities: input.capabilities }
            : {}),
        };
      }

      await db
        .update(users)
        .set(updates)
        .where(eq(users.id, input.agentUserId));

      // "Require approval for writes" — NOT the raw rung-5 flag any more (the
      // pod default at rung 2.8 outranks it). ON = this agent's `ask-first`
      // override (agent-scoped `propose` rules, THE posture writer); OFF =
      // clear the override and follow the pod default. One store, one door.
      if (input.writesRequireProposal !== undefined) {
        await applyAgentPosture({
          db,
          agentUserId: input.agentUserId,
          posture: input.writesRequireProposal ? "ask-first" : null,
          createdBy: ctx.userId,
        });
      }

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
   * DISCONNECT an agent: revoke every hub key it holds (active AND pending),
   * in one door. The agent stays — listed, with its history and governance —
   * and re-running `synap init` mints it a fresh key.
   *
   * WHO: the agent's owner (`users.created_by_user_id`, the person the agent
   * acts for) or a pod admin — decided on the LOADED agent row, never on input.
   * A PERSON's act: an agent key is refused (agents never disconnect agents),
   * so it is not an AI mutation and does not go through the proposal gate.
   * `apiKeys.revoke` refuses agent keys (the agent user owns them) and
   * `apiKeys.adminRevokeAllForUser` is admin-only — this is the owner's door.
   */
  disconnect: protectedProcedure
    .input(z.object({ agentUserId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      if (ctx.agentUserId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "Only a person can disconnect an agent — an agent key cannot.",
        });
      }
      const callerId = ctx.userId;

      const [agent] = await db
        .select({ id: users.id, createdByUserId: users.createdByUserId })
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
      const isOwner =
        !!agent.createdByUserId && agent.createdByUserId === callerId;
      if (!isOwner && !(await isPodAdmin(callerId))) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only the agent's owner or a pod admin can disconnect it",
        });
      }

      const revoked = await revokeApiKeys(db, {
        where: and(eq(apiKeys.userId, agent.id), isNull(apiKeys.revokedAt)),
        revokedBy: callerId,
        reason: isOwner
          ? "Disconnected by its owner"
          : "Disconnected by a pod admin",
      });
      // `revokeApiKeys` (the ONE revoke door) drops the verification cache
      // `/mcp` validates from, so the keys stop working NOW, not in 30s.

      // Activity: the same event shape `apiKeys.adminRevokeAllForUser` writes
      // for a bulk revoke, subject = the agent.
      await auditLog({
        subjectType: "apiKey",
        action: "delete",
        phase: "completed",
        subjectId: agent.id,
        userId: callerId,
        data: {
          agentUserId: agent.id,
          targetUserId: agent.id,
          revokedCount: revoked.length,
          disconnected: true,
          bulk: true,
          by: isOwner ? "owner" : "pod_admin",
        },
      });

      return { revokedCount: revoked.length };
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
      const revokedKeys = await revokeApiKeys(db, {
        where: and(
          inArray(apiKeys.userId, ownedIds),
          eq(apiKeys.isActive, true)
        ),
        revokedBy: ctx.userId,
        reason: revokeReason,
      });

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
