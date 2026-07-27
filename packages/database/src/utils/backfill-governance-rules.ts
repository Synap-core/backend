/**
 * Backfill: seed `governance_rules` (Phase A store) from every existing
 * `autoApproveFor` JSONB list — Governance Convergence Plan, Phase B.
 *
 * STANDALONE, ONE-SHOT, IDEMPOTENT. Call once at pod startup (NOT a pg-boss
 * registered job — this must run to completion BEFORE the Phase B reader flip
 * (`resolveAgentGovernanceDecision` consulting `governance_rules` instead of
 * the JSONB) starts serving writes, or a pod loses its autoApproveFor
 * mid-transition — see GOVERNANCE-CONVERGENCE-PLAN.md §3.
 *
 * Two sources, each converted to an ACTIVE `verdict: "auto"`, `target_kind:
 * "action"` row per list entry:
 *   - `workspaces.settings.aiGovernance.autoApproveFor` (string[])
 *     → `principal_kind: "any"`, `scope_kind: "workspace"`.
 *   - `users.agentMetadata.autoApproveFor` (string[], `userType: "agent"`)
 *     → `principal_kind: "agent"`, `scope_kind: "pod"`.
 *
 * IDEMPOTENT: re-running (every boot) is a no-op past the first successful
 * run — an already-ACTIVE row covering the same (principal, scope,
 * target_pattern) tuple is left alone, so calling this on every boot never
 * duplicates rows and never fights a later settings/agent-governance PATCH
 * (which mirrors into `governance_rules` via `syncAutoApproveRules`) or
 * `ensure-capture-agent.ts`'s own idempotent rule-seeding.
 */

import { and, eq, isNull } from "drizzle-orm";
import { users, type AgentMetadata } from "../schema/users.js";
import { workspaces, type WorkspaceSettings } from "../schema/workspaces.js";
import { governanceRules } from "../schema/governance-rules.js";

/** The injected Drizzle handle. Type-only reference — never loads the pg client. */
type DbHandle = typeof import("../client-pg.js").db;

/** `createdBy` stamp for every row this backfill inserts — distinguishes them
 *  in an audit query from operator-authored (PATCH) or widen-lane rows. */
const BACKFILL_CREATED_BY = "system:governance-backfill";

/** Active `target_kind: "action"` patterns already stored for a (principal, scope) tuple. */
async function existingActionPatterns(
  db: DbHandle,
  scopeMatch: NonNullable<ReturnType<typeof and>>
): Promise<Set<string>> {
  const rows = await db
    .select({ targetPattern: governanceRules.targetPattern })
    .from(governanceRules)
    .where(scopeMatch);
  return new Set(rows.map((r) => r.targetPattern));
}

export interface BackfillGovernanceRulesResult {
  workspaceRulesInserted: number;
  agentRulesInserted: number;
}

/**
 * Seed `governance_rules` from every workspace's + agent's existing
 * `autoApproveFor` JSONB list. Safe to call on every boot (idempotent).
 * Never throws for an individual malformed row — a workspace/agent whose
 * JSONB doesn't parse as `string[]` is skipped, not fatal to the run.
 */
export async function backfillGovernanceRules(
  db: DbHandle
): Promise<BackfillGovernanceRulesResult> {
  let workspaceRulesInserted = 0;
  let agentRulesInserted = 0;

  // 1. Workspace-level autoApproveFor → principal=any, scope=workspace.
  const wsRows = await db
    .select({ id: workspaces.id, settings: workspaces.settings })
    .from(workspaces);

  for (const ws of wsRows) {
    const settings = ws.settings as WorkspaceSettings | undefined;
    const list = settings?.aiGovernance?.autoApproveFor;
    if (!Array.isArray(list) || list.length === 0) continue;

    const existing = await existingActionPatterns(
      db,
      and(
        isNull(governanceRules.revokedAt),
        eq(governanceRules.principalKind, "any"),
        eq(governanceRules.scopeKind, "workspace"),
        eq(governanceRules.targetKind, "action"),
        eq(governanceRules.workspaceId, ws.id)
      )!
    );

    const toInsert = list.filter(
      (pattern): pattern is string =>
        typeof pattern === "string" &&
        pattern.length > 0 &&
        !existing.has(pattern)
    );
    if (toInsert.length === 0) continue;

    await db.insert(governanceRules).values(
      toInsert.map((targetPattern) => ({
        principalKind: "any" as const,
        scopeKind: "workspace" as const,
        workspaceId: ws.id,
        targetKind: "action" as const,
        targetPattern,
        verdict: "auto" as const,
        createdBy: BACKFILL_CREATED_BY,
      }))
    );
    workspaceRulesInserted += toInsert.length;
  }

  // 2. Per-agent autoApproveFor → principal=agent, scope=pod.
  const agentRows = await db
    .select({ id: users.id, agentMetadata: users.agentMetadata })
    .from(users)
    .where(eq(users.userType, "agent"));

  for (const agent of agentRows) {
    const meta = agent.agentMetadata as AgentMetadata | null;
    const list = meta?.autoApproveFor;
    if (!Array.isArray(list) || list.length === 0) continue;

    const existing = await existingActionPatterns(
      db,
      and(
        isNull(governanceRules.revokedAt),
        eq(governanceRules.principalKind, "agent"),
        eq(governanceRules.scopeKind, "pod"),
        eq(governanceRules.targetKind, "action"),
        eq(governanceRules.agentUserId, agent.id)
      )!
    );

    const toInsert = list.filter(
      (pattern): pattern is string =>
        typeof pattern === "string" &&
        pattern.length > 0 &&
        !existing.has(pattern)
    );
    if (toInsert.length === 0) continue;

    await db.insert(governanceRules).values(
      toInsert.map((targetPattern) => ({
        principalKind: "agent" as const,
        scopeKind: "pod" as const,
        agentUserId: agent.id,
        targetKind: "action" as const,
        targetPattern,
        verdict: "auto" as const,
        createdBy: BACKFILL_CREATED_BY,
      }))
    );
    agentRulesInserted += toInsert.length;
  }

  return { workspaceRulesInserted, agentRulesInserted };
}
