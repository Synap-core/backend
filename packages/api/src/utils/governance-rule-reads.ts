/**
 * Shared READ machinery for `governance_rules`.
 *
 * ONE active-rule predicate, ONE pod∪workspace scope predicate, and ONE
 * agent-label resolver, consumed by BOTH read surfaces:
 *   - `routers/governance-rules.ts` (`list` / `listAll` — the Rules editor)
 *   - `utils/permission-check.ts` (`getEffectiveGovernance` — the honest
 *     introspection surface behind `synap_governance` and the Hub REST
 *     `GET /workspaces/:id/governance`)
 *
 * WHY THIS FILE EXISTS: a second, hand-rolled rules query is exactly the defect
 * class this module prevents. `getEffectiveGovernance` deliberately reports only
 * `principal_kind = "any"` rules as the workspace BASELINE — which meant an
 * agent-scoped `verdict:"auto"` rule resolving at rung 2.8 (above rung 8) was
 * enforced but INVISIBLE from inside the product. Surfacing those rules requires
 * a listing read; it must share this predicate with the editor so the two can
 * never drift.
 *
 * These are READS ONLY. Nothing here participates in a governance DECISION —
 * the enforcement path is `resolveGovernanceRule` (@synap/database), untouched.
 */

import { db, eq, and, or, isNull, gt, inArray } from "@synap/database";
import { governanceRules, users } from "@synap/database/schema";

/** A raw `governance_rules` row. */
export type GovernanceRuleRow = typeof governanceRules.$inferSelect;

/**
 * Active-rule predicate: not revoked, not expired. Mirrors the enforcement
 * resolver's active predicate (`resolveGovernanceRule`) exactly.
 */
export function activeRulePredicate() {
  return and(
    isNull(governanceRules.revokedAt),
    or(
      isNull(governanceRules.expiresAt),
      gt(governanceRules.expiresAt, new Date())
    )
  );
}

/**
 * Scope lens: pod-scope rules (global) ∪ workspace-scope rules for THIS
 * workspace. With no workspace in hand, only pod-scope rules are eligible —
 * the same branch `resolveGovernanceRule` takes.
 */
export function podOrWorkspaceScopePredicate(
  workspaceId: string | undefined | null
) {
  return workspaceId
    ? or(
        eq(governanceRules.scopeKind, "pod"),
        and(
          eq(governanceRules.scopeKind, "workspace"),
          eq(governanceRules.workspaceId, workspaceId)
        )
      )
    : eq(governanceRules.scopeKind, "pod");
}

/**
 * Resolve agent display labels for a set of agent user ids in ONE batched
 * lookup. Returns id → label (falls back to the id itself).
 */
export async function resolveAgentLabels(
  agentUserIds: readonly (string | null | undefined)[]
): Promise<Map<string, string>> {
  const ids = Array.from(
    new Set(agentUserIds.filter((id): id is string => !!id))
  );
  const labels = new Map<string, string>();
  if (ids.length === 0) return labels;

  const agents = await db
    .select({ id: users.id, name: users.name, agentType: users.agentType })
    .from(users)
    .where(inArray(users.id, ids));
  for (const a of agents) {
    labels.set(a.id, a.name ?? a.agentType ?? a.id);
  }
  return labels;
}

/**
 * Map raw rule rows to the wire DTO used by `governanceRules.list` /
 * `.listAll`, resolving each agent-principal rule's display label in ONE
 * batched lookup. Shared so the two listing doors never drift on shape.
 */
export async function mapRulesWithAgentLabels(rows: GovernanceRuleRow[]) {
  const agentLabels = await resolveAgentLabels(
    rows.filter((r) => r.principalKind === "agent").map((r) => r.agentUserId)
  );

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

/**
 * How a rule came to exist — the whole diagnostic point of surfacing agent
 * overrides. A `source_proposal_id` means a human approved a widening (earned
 * lineage); a `system:*` author means a machine minted it (backfill / migration
 * of legacy JSONB) and NO human ever reviewed it; anything else is a real user
 * id from the Rules editor.
 */
export type RuleProvenance = "earned" | "machine" | "authored";

export function classifyRuleProvenance(rule: {
  createdBy: string;
  sourceProposalId: string | null;
}): RuleProvenance {
  if (rule.sourceProposalId) return "earned";
  if (rule.createdBy.startsWith("system:")) return "machine";
  return "authored";
}

/**
 * An agent-principal governance rule, shaped for the introspection surface.
 *
 * DELIBERATELY NOT MERGED into `effective.autoApproveFor`: that field means
 * "auto-approved for ANY principal in this workspace". An agent-scoped grant
 * applies to exactly ONE agent, so folding it in would misreport the workspace
 * baseline. Keeping the two structurally distinct is the point.
 */
export interface AgentGovernanceOverride {
  ruleId: string;
  agentUserId: string;
  /** Resolved display label (users.name → agentType → the id). */
  agentLabel: string;
  targetKind: "action" | "profile" | "capability";
  targetPattern: string;
  targetProfile: string | null;
  verdict: "auto" | "propose";
  scopeKind: "pod" | "workspace";
  workspaceId: string | null;
  /** Provenance — who/what minted this rule. */
  createdBy: string;
  sourceProposalId: string | null;
  provenance: RuleProvenance;
  createdAt: Date;
  expiresAt: Date | null;
}

/**
 * List the ACTIVE `principal_kind = "agent"` rules in the pod ∪ this-workspace
 * lens — the same lens `getEffectiveGovernance` already reads its `"any"`-
 * principal baseline through, so this widens NO visibility beyond the floor the
 * caller already passed. Agent labels resolved in one batched lookup.
 */
export async function listAgentGovernanceOverrides(
  workspaceId: string | undefined | null
): Promise<AgentGovernanceOverride[]> {
  const rows = await db
    .select({
      id: governanceRules.id,
      principalKind: governanceRules.principalKind,
      agentUserId: governanceRules.agentUserId,
      targetKind: governanceRules.targetKind,
      targetPattern: governanceRules.targetPattern,
      targetProfile: governanceRules.targetProfile,
      verdict: governanceRules.verdict,
      scopeKind: governanceRules.scopeKind,
      workspaceId: governanceRules.workspaceId,
      createdBy: governanceRules.createdBy,
      sourceProposalId: governanceRules.sourceProposalId,
      createdAt: governanceRules.createdAt,
      expiresAt: governanceRules.expiresAt,
    })
    .from(governanceRules)
    .where(
      and(
        activeRulePredicate(),
        eq(governanceRules.principalKind, "agent"),
        podOrWorkspaceScopePredicate(workspaceId)
      )
    );

  // Defence-in-depth (mirrors `resolveGovernanceRule`'s in-memory re-check):
  // the SQL above already floors on `principal_kind = "agent"`. A NULL
  // `agent_user_id` on an agent row cannot match any principal at enforcement
  // (`principalCondition` requires the id), so it is not an override of
  // anything — drop it rather than render a principal-less "agent override".
  const usable = rows.filter(
    (r): r is typeof r & { agentUserId: string } =>
      r.principalKind === "agent" && !!r.agentUserId
  );

  const labels = await resolveAgentLabels(usable.map((r) => r.agentUserId));

  return usable.map((r) => ({
    ruleId: r.id,
    agentUserId: r.agentUserId,
    agentLabel: labels.get(r.agentUserId) ?? r.agentUserId,
    targetKind: r.targetKind,
    targetPattern: r.targetPattern,
    targetProfile: r.targetProfile,
    verdict: r.verdict,
    scopeKind: r.scopeKind,
    workspaceId: r.workspaceId,
    createdBy: r.createdBy,
    sourceProposalId: r.sourceProposalId,
    provenance: classifyRuleProvenance(r),
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
  }));
}
