/**
 * Governance Rules Router
 *
 * CRUD over `governance_rules` (Governance Convergence Plan, Phase A schema —
 * see GOVERNANCE-CONVERGENCE-PLAN.md). This is the "always approve for X" door:
 * approving a proposal can additionally widen governance by inserting ONE
 * revocable, audited rule instead of hand-editing `workspaces.settings` or
 * `agentMetadata` JSONB. The resolver that *consumes* these rows (rung 2.8 in
 * `decideAgentPolicy`) is a separate wave — this router only stores/lists/revokes.
 *
 * The five "always approve for X" granularities the UI offers map to `create`
 * inputs as:
 *   - this capability  -> targetKind: "capability", targetPattern: <capabilityId>
 *   - this action type -> targetKind: "action", targetPattern: <exact action or glob>
 *   - this profile     -> targetKind: "profile", targetPattern: "*", targetProfile: <slug>
 *   - this agent        -> principalKind: "agent", agentUserId: <id>
 *   - globally          -> principalKind: "any", scopeKind: "pod", targetPattern: "*"
 * (principal and target are orthogonal axes — e.g. "this agent" + "this profile"
 * both narrow the same rule.)
 *
 * Gating (creating/revoking a rule WIDENS or narrows governance, so it is
 * itself gated, same as any other governance-affecting write):
 *   - scopeKind "pod"       -> pod-admin only (assertPodAdmin)
 *   - scopeKind "workspace" -> editor/admin/owner membership in that workspace
 *   - principalKind "agent" -> caller must own the agent (users.createdByUserId)
 *                              or be pod-admin; otherwise FORBIDDEN
 * `verdict` is never "deny" at the schema level (enforced by the DB enum) —
 * denial stays a CBAC/floor concern, never a user-authored rule.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { assertPodAdmin } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { db, eq, and, or, isNull, gt, desc, inArray } from "@synap/database";
import {
  governanceRules,
  workspaceMembers,
  users,
} from "@synap/database/schema";

const EDITOR_ROLES = ["editor", "admin", "owner"];

async function isPodAdmin(userId: string): Promise<boolean> {
  try {
    await assertPodAdmin(userId);
    return true;
  } catch {
    return false;
  }
}

async function assertWorkspaceEditor(
  userId: string,
  workspaceId: string
): Promise<void> {
  const membership = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.userId, userId)
    ),
    columns: { role: true },
  });

  if (!membership || !EDITOR_ROLES.includes(membership.role)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Editor role or higher required for this workspace",
    });
  }
}

/**
 * Shared gate for both `create` and `revoke` — a rule's authority to
 * exist/be-undone is determined by its scope + principal, never by who is
 * asking. Throws FORBIDDEN when the caller isn't allowed.
 */
async function assertCanManageRule(
  userId: string,
  rule: {
    scopeKind: "workspace" | "pod";
    workspaceId?: string | null;
    principalKind: "agent" | "any";
    agentUserId?: string | null;
  }
): Promise<void> {
  const podAdmin = await isPodAdmin(userId);

  if (rule.scopeKind === "pod") {
    if (!podAdmin) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Pod admin required for pod-scope (global) governance rules",
      });
    }
  } else {
    if (!rule.workspaceId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "workspaceId is required for workspace-scope rules",
      });
    }
    if (!podAdmin) {
      await assertWorkspaceEditor(userId, rule.workspaceId);
    }
  }

  if (rule.principalKind === "agent") {
    if (!rule.agentUserId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "agentUserId is required for agent-scoped rules",
      });
    }
    if (!podAdmin) {
      const agent = await db.query.users.findFirst({
        where: and(eq(users.id, rule.agentUserId), eq(users.userType, "agent")),
        columns: { createdByUserId: true },
      });
      if (!agent) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "agentUserId must be an existing agent user",
        });
      }
      if (agent.createdByUserId !== userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You do not own this agent — cannot manage its rules",
        });
      }
    }
  }
}

const CreateInputSchema = z
  .object({
    principalKind: z.enum(["agent", "any"]),
    agentUserId: z.string().min(1).optional(),
    scopeKind: z.enum(["workspace", "pod"]),
    workspaceId: z.string().uuid().optional(),
    targetKind: z.enum(["action", "profile", "capability"]),
    targetPattern: z.string().min(1),
    targetProfile: z.string().min(1).optional(),
    verdict: z.enum(["auto", "propose"]),
    sourceProposalId: z.string().uuid().optional(),
    expiresAt: z.coerce.date().optional(),
  })
  .refine((v) => v.principalKind !== "agent" || !!v.agentUserId, {
    message: "agentUserId is required when principalKind is 'agent'",
    path: ["agentUserId"],
  })
  .refine((v) => v.scopeKind !== "workspace" || !!v.workspaceId, {
    message: "workspaceId is required when scopeKind is 'workspace'",
    path: ["workspaceId"],
  })
  .refine((v) => v.targetKind !== "profile" || !!v.targetProfile, {
    message: "targetProfile is required when targetKind is 'profile'",
    path: ["targetProfile"],
  });

export const governanceRulesRouter = router({
  /**
   * List active rules (not revoked, not expired) visible to the caller:
   * pod-scope rules (visible to everyone — they're global) plus workspace-scope
   * rules for the workspace the caller passes (defaults to ctx.workspaceId).
   * Newest first.
   */
  list: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const workspaceId = input.workspaceId ?? ctx.workspaceId ?? undefined;

      const activePredicate = and(
        isNull(governanceRules.revokedAt),
        or(
          isNull(governanceRules.expiresAt),
          gt(governanceRules.expiresAt, new Date())
        )
      );

      const scopePredicate = workspaceId
        ? or(
            eq(governanceRules.scopeKind, "pod"),
            and(
              eq(governanceRules.scopeKind, "workspace"),
              eq(governanceRules.workspaceId, workspaceId)
            )
          )
        : eq(governanceRules.scopeKind, "pod");

      const rows = await db.query.governanceRules.findMany({
        where: and(activePredicate, scopePredicate),
        orderBy: [desc(governanceRules.createdAt)],
      });

      const agentIds = Array.from(
        new Set(
          rows
            .filter((r) => r.principalKind === "agent" && r.agentUserId)
            .map((r) => r.agentUserId as string)
        )
      );

      const agentLabels = new Map<string, string>();
      if (agentIds.length > 0) {
        const agents = await db
          .select({
            id: users.id,
            name: users.name,
            agentType: users.agentType,
          })
          .from(users)
          .where(inArray(users.id, agentIds));
        for (const a of agents) {
          agentLabels.set(a.id, a.name ?? a.agentType ?? a.id);
        }
      }

      return {
        rules: rows.map((r) => ({
          id: r.id,
          principalKind: r.principalKind,
          agentUserId: r.agentUserId,
          agentLabel: r.agentUserId
            ? (agentLabels.get(r.agentUserId) ?? r.agentUserId)
            : null,
          scopeKind: r.scopeKind,
          workspaceId: r.workspaceId,
          targetKind: r.targetKind,
          targetPattern: r.targetPattern,
          targetProfile: r.targetProfile,
          verdict: r.verdict,
          createdAt: r.createdAt,
          createdBy: r.createdBy,
          sourceProposalId: r.sourceProposalId,
          expiresAt: r.expiresAt,
        })),
      };
    }),

  /**
   * Create one rule — the "always approve for X" door. See file header for
   * how the five granularities map to inputs.
   */
  create: protectedProcedure
    .input(CreateInputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertCanManageRule(ctx.userId, input);

      const [rule] = await db
        .insert(governanceRules)
        .values({
          principalKind: input.principalKind,
          agentUserId:
            input.principalKind === "agent" ? input.agentUserId : null,
          scopeKind: input.scopeKind,
          workspaceId:
            input.scopeKind === "workspace" ? input.workspaceId : null,
          targetKind: input.targetKind,
          targetPattern: input.targetPattern,
          targetProfile:
            input.targetKind === "profile" ? input.targetProfile : null,
          verdict: input.verdict,
          sourceProposalId: input.sourceProposalId ?? null,
          createdBy: ctx.userId,
          expiresAt: input.expiresAt ?? null,
        })
        .returning();

      return { rule };
    }),

  /**
   * Revoke a rule (soft — sets revokedAt). Gated identically to `create`:
   * whoever could have created this rule may undo it.
   */
  revoke: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await db.query.governanceRules.findFirst({
        where: eq(governanceRules.id, input.id),
      });

      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Rule not found" });
      }
      if (existing.revokedAt) {
        return { rule: existing };
      }

      await assertCanManageRule(ctx.userId, existing);

      const [rule] = await db
        .update(governanceRules)
        .set({ revokedAt: new Date() })
        .where(eq(governanceRules.id, input.id))
        .returning();

      return { rule };
    }),
});
