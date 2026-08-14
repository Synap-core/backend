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
import {
  db,
  eq,
  and,
  or,
  isNull,
  isNotNull,
  gt,
  desc,
  inArray,
  ProposalStatus,
} from "@synap/database";
import {
  governanceRules,
  workspaceMembers,
  workspaces,
  users,
  proposals,
} from "@synap/database/schema";
import { userVisibleWhere } from "../utils/user-visible-where.js";
import {
  DEFAULT_AUTO_APPROVE,
  DESTRUCTIVE_ACTIONS,
  ADMIN_ACTIONS,
} from "@synap/governance-policy";

const EDITOR_ROLES = ["editor", "admin", "owner"];

/** A `governanceRules` row shaped for the wire, with the agent's display label resolved. */
type GovernanceRuleRow = typeof governanceRules.$inferSelect;

/**
 * Map raw rule rows to the wire DTO used by `list` / `listAll`, resolving each
 * agent-principal rule's display label in ONE batched lookup. Shared so the two
 * listing doors never drift on shape.
 */
async function mapRulesWithAgentLabels(rows: GovernanceRuleRow[]) {
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

  return rows.map((r) => ({
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
  }));
}

/** Active-rule predicate: not revoked, not expired. Shared by every read door. */
function activeRulePredicate() {
  return and(
    isNull(governanceRules.revokedAt),
    or(
      isNull(governanceRules.expiresAt),
      gt(governanceRules.expiresAt, new Date())
    )
  );
}

/**
 * READ-visibility gate for a workspace lens on the preview doors: the caller
 * must be able to SEE the workspace (member / owner / pod-visible), or be a pod
 * admin. Mirrors `userVisibleWhere`'s floor so a preview can never reveal rules
 * for a workspace the caller has no access to.
 */
async function assertWorkspaceVisible(
  userId: string,
  workspaceId: string
): Promise<void> {
  if (await isPodAdmin(userId)) return;
  const [row] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.id, workspaceId),
        userVisibleWhere(workspaces.id, userId)
      )
    )
    .limit(1);
  if (!row) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You do not have access to this workspace",
    });
  }
}

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
        where: and(activeRulePredicate(), scopePredicate),
        orderBy: [desc(governanceRules.createdAt)],
      });

      return { rules: await mapRulesWithAgentLabels(rows) };
    }),

  /**
   * List active rules across EVERY workspace the caller can see (pod ∪ all
   * visible workspaces), not just one. Mirrors the `.list`/`.listAll` convention
   * (backend-rules.md): floored by `userVisibleWhere` on `workspace_id` so
   * pod-scope rules (NULL workspace → global) and workspace-scope rules for the
   * caller's workspaces are returned, and no rule outside the caller's
   * visibility ever leaks. Powers the Adjuncts facet's "an agent's overrides
   * across every workspace" view. Newest first.
   */
  listAll: protectedProcedure.query(async ({ ctx }) => {
    const rows = await db.query.governanceRules.findMany({
      where: and(
        activeRulePredicate(),
        userVisibleWhere(governanceRules.workspaceId, ctx.userId)
      ),
      orderBy: [desc(governanceRules.createdAt)],
    });

    return { rules: await mapRulesWithAgentLabels(rows) };
  }),

  /**
   * Side-effect-free "Test policy" preview: would a given `(agent, action,
   * subject, profile?)` write auto-apply or propose, and WHICH rule (if any)
   * decided rung 2.8? Wraps `dryRunAgentGovernanceDecision` (the same pure
   * resolver enforcement runs — it reads the rules store, never writes). Gated
   * on workspace visibility so a caller can only preview within workspaces they
   * can see.
   */
  dryRun: protectedProcedure
    .input(
      z.object({
        agentUserId: z.string().min(1),
        action: z.string().min(1),
        subjectType: z.string().min(1).optional(),
        profileSlug: z.string().min(1).optional(),
        door: z.enum(["chat", "automation"]).optional(),
        workspaceId: z.string().uuid().optional(),
        channelId: z.string().uuid().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const workspaceId = input.workspaceId ?? ctx.workspaceId ?? undefined;
      if (workspaceId) {
        await assertWorkspaceVisible(ctx.userId, workspaceId);
      }

      const { dryRunAgentGovernanceDecision } =
        await import("@synap/database/agent-governance");
      const result = await dryRunAgentGovernanceDecision({
        db,
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId,
        subjectType: input.subjectType ?? "",
        action: input.action,
        profileSlug: input.profileSlug,
        door: input.door ?? "chat",
        channelId: input.channelId,
      });

      // Enrich the rung-2.8 winner into a full chip the editor can open.
      let winningRule:
        Awaited<ReturnType<typeof mapRulesWithAgentLabels>>[number] | null =
        null;
      if (result.winningRule) {
        const row = await db.query.governanceRules.findFirst({
          where: eq(governanceRules.id, result.winningRule.ruleId),
        });
        if (row) {
          winningRule = (await mapRulesWithAgentLabels([row]))[0] ?? null;
        }
      }

      return {
        outcome: result.outcome,
        rung: result.rung,
        reason: result.reason,
        winningRule,
      };
    }),

  /**
   * "Would-have-caught-N": for a DRAFT rule (pre-`create`), how many recent
   * historical proposals would its target MATCH, and of those, how many would
   * the draft's verdict CHANGE? Powers the Calibration UI's retro-impact number
   * next to the dry-run verdict.
   *
   * Pure read. Scans the most-recent agent-authored proposals the caller can see
   * (`userVisibleWhere`, capped at 500 — the same window + floor the agent
   * scorecard uses), reconstructs each into the exact tuple the live rung-2.8
   * resolver matched (`targetType`→subject, `proposalType`→action,
   * `data.profileSlug`→profile), and tests it with `draftRuleMatchesWrite` — the
   * SAME `scoreRuleTarget` matcher `resolveGovernanceRule` ranks with, so the
   * preview can't lie about what the rule targets.
   *
   * `wouldFlip` compares the draft `verdict` against each matched proposal's
   * RECORDED outcome (`auto_approved` → currently "auto"; every other status →
   * routed to review). HONEST SCOPE: this is over the SAMPLED window, not
   * lifetime, and it does NOT re-run the floors (destructive/admin/scope always
   * force review). So a `verdict:"propose"` draft's count is exact (a rule can
   * always pin an auto-approve to review), but a `verdict:"auto"` draft's count
   * is an UPPER BOUND — a floored review row is counted as a flip though a floor
   * would still hold it. The `scope` string states this.
   */
  retroImpact: protectedProcedure
    .input(
      z.object({
        principalKind: z.enum(["any", "agent"]),
        agentUserId: z.string().min(1).optional(),
        scopeKind: z.enum(["pod", "workspace"]),
        workspaceId: z.string().uuid().optional(),
        targetKind: z.enum(["action", "profile", "capability"]),
        targetPattern: z.string().min(1),
        targetProfile: z.string().min(1).optional(),
        verdict: z.enum(["auto", "propose"]),
        /** Cap the scan window (defaults to, and is clamped to, 500). */
        window: z.number().int().min(1).max(500).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      if (input.scopeKind === "workspace" && input.workspaceId) {
        await assertWorkspaceVisible(ctx.userId, input.workspaceId);
      }

      const SCAN_LIMIT = 500;
      const limit = Math.min(input.window ?? SCAN_LIMIT, SCAN_LIMIT);

      // USER floor + agent-only: rung 2.8 governs AGENT writes, so a human-filed
      // proposal (agentUserId NULL) was never subject to a rule — exclude it.
      const rows = await db
        .select({
          targetType: proposals.targetType,
          proposalType: proposals.proposalType,
          data: proposals.data,
          status: proposals.status,
          agentUserId: proposals.agentUserId,
          workspaceId: proposals.workspaceId,
        })
        .from(proposals)
        .where(
          and(
            isNotNull(proposals.agentUserId),
            userVisibleWhere(proposals.workspaceId, ctx.userId)
          )
        )
        .orderBy(desc(proposals.createdAt))
        .limit(limit);

      const { draftRuleMatchesWrite } =
        await import("@synap/database/agent-governance");

      const draft = {
        principalKind: input.principalKind,
        agentUserId: input.agentUserId,
        scopeKind: input.scopeKind,
        workspaceId: input.workspaceId,
        targetKind: input.targetKind,
        targetPattern: input.targetPattern,
        targetProfile: input.targetProfile,
        verdict: input.verdict,
      };

      let matched = 0;
      let wouldFlip = 0;
      for (const row of rows) {
        const data = (row.data ?? {}) as Record<string, unknown>;
        const profileSlug =
          typeof data.profileSlug === "string" ? data.profileSlug : null;
        if (
          !draftRuleMatchesWrite(draft, {
            subjectType: row.targetType,
            action: row.proposalType,
            profileSlug,
            agentUserId: row.agentUserId,
            workspaceId: row.workspaceId,
          })
        ) {
          continue;
        }
        matched++;
        const currentOutcome =
          row.status === ProposalStatus.AUTO_APPROVED ? "auto" : "propose";
        if (currentOutcome !== input.verdict) wouldFlip++;
      }

      return {
        matched,
        wouldFlip,
        sampled: rows.length,
        scope:
          `matched over the last ${rows.length} agent proposal(s) visible to you ` +
          `(newest first, capped at ${SCAN_LIMIT}) — not lifetime. ` +
          (input.verdict === "auto"
            ? "wouldFlip is an UPPER BOUND: floors (destructive/admin/scope) are not re-evaluated, so a floored review row is still counted."
            : "wouldFlip is exact: a rule can always pin an auto-approve to review."),
      };
    }),

  /**
   * The read-only PLATFORM FLOOR, for display alongside user-authored rules.
   * Sources the REAL engine constants from `@synap/governance-policy` (imported,
   * never copied) so the editor can never drift from what `decideAgentPolicy`
   * actually enforces:
   *   - `autoApproveFor` — the DEFAULT_AUTO_APPROVE whitelist (rung 8 floor).
   *   - `alwaysPropose`  — the hard floors that always route to a proposal
   *     regardless of any rule: ADMIN (rung 2), DESTRUCTIVE (rung 2.5), and the
   *     forcePropose scope/identity floor (rung 2.1, applied dynamically — not a
   *     fixed action list). Every entry is read-only (not user-editable).
   */
  platformDefaults: protectedProcedure.query(async () => {
    return {
      autoApproveFor: {
        key: "default-auto-approve" as const,
        label: "Default auto-approve whitelist",
        rung: "8",
        editable: false as const,
        actions: DEFAULT_AUTO_APPROVE,
      },
      alwaysPropose: [
        {
          key: "admin" as const,
          label: "Administrative actions",
          rung: "2",
          editable: false as const,
          actions: ADMIN_ACTIONS,
        },
        {
          key: "destructive" as const,
          label: "Destructive actions (delete / archive / purge / merge)",
          rung: "2.5",
          editable: false as const,
          actions: DESTRUCTIVE_ACTIONS,
        },
        {
          key: "force-propose" as const,
          label: "Scope / identity changes",
          rung: "2.1",
          editable: false as const,
          actions: [] as readonly string[],
          note: "Applied dynamically when a write alters a record's scope or identity (e.g. promote-to-global, change of profile kind) — not a fixed action list.",
        },
      ],
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
