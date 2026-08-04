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
 * DIFF-ONLY (Convergence Plan D2): `DEFAULT_AUTO_APPROVE` is the CODE FLOOR
 * (decideAgentPolicy rung 8), not rows to seed. Only GENUINE widenings — action
 * patterns the floor does NOT already cover (`filterUncoveredActions`) — become
 * an ACTIVE `verdict: "auto"`, `target_kind: "action"` row. A floor-equal
 * pattern (e.g. `entity.create`, `search.*`) is NEVER inserted: it would restate
 * rung 8 and change no enforcement outcome — pure flood.
 *   - `workspaces.settings.aiGovernance.autoApproveFor` (string[])
 *     → `principal_kind: "any"`, `scope_kind: "workspace"`.
 *   - `users.agentMetadata.autoApproveFor` (string[], `userType: "agent"`)
 *     → `principal_kind: "agent"`, `scope_kind: "pod"`.
 *
 * ONE-TIME CLEANUP: also REVOKES (soft, `revoked_at = now()`) existing ACTIVE
 * backfill-authored (`created_by = "system:governance-backfill"`) action rows
 * whose pattern is floor-covered — the ~27-per-agent flood a prior full-seed
 * backfill left behind. Never touches proposal-lineage rows
 * (`source_proposal_id` set) or genuine widenings.
 *
 * IDEMPOTENT + non-resurrecting: re-running (every boot) is a no-op past the
 * first converged run. The insert guard checks for ANY existing row (ACTIVE
 * OR revoked) for the (principal, scope, target_pattern) tuple, so a genuine
 * widening a user later REVOKED via the rules editor is never re-seeded, and
 * this never fights a later settings/agent-governance PATCH (which mirrors into
 * `governance_rules` via `syncAutoApproveRules`, itself now diff-only) or
 * `ensure-capture-agent.ts`'s own idempotent rule-seeding.
 */

import { and, eq, inArray, isNull } from "drizzle-orm";
import { users, type AgentMetadata } from "../schema/users.js";
import { workspaces, type WorkspaceSettings } from "../schema/workspaces.js";
import { governanceRules } from "../schema/governance-rules.js";
import {
  filterUncoveredActions,
  isFloorCoveredAction,
} from "./floor-covered-actions.js";

/** The injected Drizzle handle. Type-only reference — never loads the pg client. */
type DbHandle = typeof import("../client-pg.js").db;

/** `createdBy` stamp for every row this backfill inserts — distinguishes them
 *  in an audit query from operator-authored (PATCH) or widen-lane rows. */
const BACKFILL_CREATED_BY = "system:governance-backfill";

/** `createdBy` stamp of the capture-agent seeder (`ensure-capture-agent.ts`'s
 *  `GOVERNANCE_RULES_CREATED_BY`). It is the SECOND system seeder that inserted
 *  floor-covered action rows before its own diff-only filter landed, so the
 *  one-time cleanup below must revoke its rows too. Keep this string in sync with
 *  that module. Scoped to the two SYSTEM seeders only — never dropped to "any
 *  createdBy", because a user may legitimately author a floor-covered rule via
 *  the rules editor (createdBy = their id) and that must NOT be auto-revoked. */
const CAPTURE_CREATED_BY = "system:ensure-capture-agent";

/**
 * `target_kind: "action"` patterns EVER stored for a (principal, scope) tuple —
 * ACTIVE OR revoked. Used as the insert guard: a widening that already has a row
 * (active, or one the user revoked) is never (re-)inserted, so a user-revoked
 * genuine widening is never resurrected. The `scopeMatch` therefore deliberately
 * does NOT filter on `revoked_at`.
 */
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

/**
 * ONE-TIME CLEANUP (idempotent): soft-revoke every ACTIVE backfill-authored
 * action row whose pattern is floor-covered — the redundant flood a prior
 * full-seed backfill inserted (one row per DEFAULT_AUTO_APPROVE-covered pattern,
 * per agent/workspace). Scoped to the TWO system seeders
 * (`created_by IN {"system:governance-backfill", "system:ensure-capture-agent"}`)
 * and `source_proposal_id IS NULL` so proposal-lineage rows and human/PATCH-
 * authored rows (createdBy = a real user id) are untouched. Floor-coverage can't
 * be expressed in SQL, so we fetch the candidate rows and filter in JS via
 * `isFloorCoveredAction`. Re-running finds no active floor-covered seeder rows
 * → no-op.
 */
async function revokeFloorCoveredBackfillRows(db: DbHandle): Promise<number> {
  const rows = await db
    .select({
      id: governanceRules.id,
      targetPattern: governanceRules.targetPattern,
    })
    .from(governanceRules)
    .where(
      and(
        isNull(governanceRules.revokedAt),
        isNull(governanceRules.sourceProposalId),
        inArray(governanceRules.createdBy, [
          BACKFILL_CREATED_BY,
          CAPTURE_CREATED_BY,
        ]),
        eq(governanceRules.targetKind, "action")
      )!
    );

  const staleIds = rows
    .filter((r) => isFloorCoveredAction(r.targetPattern))
    .map((r) => r.id);
  if (staleIds.length === 0) return 0;

  await db
    .update(governanceRules)
    .set({ revokedAt: new Date() })
    .where(inArray(governanceRules.id, staleIds));
  return staleIds.length;
}

export interface BackfillGovernanceRulesResult {
  workspaceRulesInserted: number;
  agentRulesInserted: number;
  /** Redundant floor-covered backfill rows soft-revoked by the cleanup. */
  floorCoveredRevoked: number;
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

  // 0. Cleanup: revoke the redundant floor-covered flood a prior full-seed
  //    backfill left behind (idempotent — no-op once converged).
  const floorCoveredRevoked = await revokeFloorCoveredBackfillRows(db);

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
        eq(governanceRules.principalKind, "any"),
        eq(governanceRules.scopeKind, "workspace"),
        eq(governanceRules.targetKind, "action"),
        eq(governanceRules.workspaceId, ws.id)
      )!
    );

    // Diff-only: drop floor-covered patterns (they restate rung 8), then drop
    // any that already have a row (active or revoked — no resurrection).
    // `filterUncoveredActions` already drops non-string/empty entries — no
    // redundant caller-side pre-filter (S8).
    const toInsert = filterUncoveredActions(list).filter(
      (pattern) => !existing.has(pattern)
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
        eq(governanceRules.principalKind, "agent"),
        eq(governanceRules.scopeKind, "pod"),
        eq(governanceRules.targetKind, "action"),
        eq(governanceRules.agentUserId, agent.id)
      )!
    );

    // Diff-only: drop floor-covered patterns (they restate rung 8), then drop
    // any that already have a row (active or revoked — no resurrection).
    // `filterUncoveredActions` already drops non-string/empty entries — no
    // redundant caller-side pre-filter (S8).
    const toInsert = filterUncoveredActions(list).filter(
      (pattern) => !existing.has(pattern)
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

  return { workspaceRulesInserted, agentRulesInserted, floorCoveredRevoked };
}
