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
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 🔴 TRUE ONE-SHOT — WHY THE CONVERGED MARKER EXISTS. DO NOT REMOVE IT.
 * ────────────────────────────────────────────────────────────────────────────
 * The insert guard above makes a re-run idempotent only against a FROZEN floor.
 * It is NOT idempotent against a MOVING one, and that made the governance floor
 * one-way: widenable, never tightenable.
 *
 * The mechanism (verified live, 2026-08-15): `filterUncoveredActions` diffs each
 * agent's STALE `users.agentMetadata.autoApproveFor` JSONB against the LIVE
 * `DEFAULT_AUTO_APPROVE`. REMOVING an action from that code floor therefore
 * makes the action "uncovered" — so the very next boot re-granted it as a
 * permanent ACTIVE `principal_kind:"agent"` / `scope_kind:"pod"` /
 * `verdict:"auto"` rule, which resolves at rung 2.8 — ABOVE the rung-8 floor the
 * commit had just tightened. Commit `d2e4a549` removed `profile.create`,
 * `profile.update`, `property_def.create` and `property_def.update` from the
 * floor; its first boot minted rules that handed all four straight back, per
 * agent, automatically. The tightening commit was undone by the boot hook.
 *
 * The fix: the legacy JSONB is read EXACTLY ONCE per pod. After the first
 * successful, COMPLETE run the pod is stamped
 * `pod_settings.settings.governanceRulesBackfill.convergedAt` and every later
 * boot returns `{ skipped: true }` without touching the JSONB — so a later floor
 * tightening stays tightened. Never re-enable the unconditional re-read, and
 * never "refresh" the marker: the JSONB is a frozen legacy artifact, not a live
 * source, and any diff of it against a moving floor re-opens this hole.
 *
 * Atomicity: the whole run — the cleanup, both seeding passes and the marker
 * write — happens in ONE transaction guarded by a pg advisory xact lock. A crash
 * or throw mid-run rolls back the rules AND the marker together, so a partial
 * run can never mark the pod converged and silently skip forever; the next boot
 * retries from a clean slate. Two boots racing serialize on the lock: the loser
 * observes the winner's committed marker and skips, so no rule is double-inserted.
 */

import { and, eq, inArray, isNull, sql as drizzleSql } from "drizzle-orm";
import { users, type AgentMetadata } from "../schema/users.js";
import { workspaces, type WorkspaceSettings } from "../schema/workspaces.js";
import { governanceRules } from "../schema/governance-rules.js";
import {
  podSettings,
  type GovernanceBackfillMarker,
} from "../schema/pod-settings.js";
import {
  filterUncoveredActions,
  isFloorCoveredAction,
} from "./floor-covered-actions.js";

/** The injected Drizzle handle. Type-only reference — never loads the pg client. */
type DbHandle = typeof import("../client-pg.js").db;

/**
 * The transaction handle every step of the backfill runs on. Derived from
 * `DbHandle` so it can never drift from the real client's transaction callback.
 */
type Tx = Parameters<Parameters<DbHandle["transaction"]>[0]>[0];

/**
 * Advisory-lock key serializing concurrent boots of this backfill. Taken as an
 * `xact` lock so it is released by COMMIT/ROLLBACK — a crashed boot can never
 * wedge the next one (same pattern as `user-provisioning.ts`'s owner bootstrap).
 */
const BACKFILL_LOCK_KEY = "synap:governance-rules-backfill";

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
  db: Tx,
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
async function revokeFloorCoveredBackfillRows(db: Tx): Promise<number> {
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

/**
 * Has this pod already completed a full backfill? Reads the converged marker off
 * the singleton `pod_settings` row (`.orderBy(createdAt).limit(1)` — the
 * established singleton read, see `catalog-sync-stamps.ts`). A pod with no
 * `pod_settings` row at all has never converged.
 */
async function isConverged(db: Tx): Promise<boolean> {
  const [row] = await db
    .select({ settings: podSettings.settings })
    .from(podSettings)
    .orderBy(podSettings.createdAt)
    .limit(1);
  return (
    typeof row?.settings?.governanceRulesBackfill?.convergedAt === "string"
  );
}

/**
 * Stamp the pod converged. Called LAST, inside the same transaction as the rows
 * — so it commits if and only if the complete run committed. `jsonb_set` merges
 * just this key, never clobbering sibling `pod_settings.settings` keys.
 */
async function markConverged(db: Tx): Promise<void> {
  const marker: GovernanceBackfillMarker = {
    convergedAt: new Date().toISOString(),
  };
  const [existing] = await db
    .select({ id: podSettings.id })
    .from(podSettings)
    .orderBy(podSettings.createdAt)
    .limit(1);

  if (existing) {
    await db
      .update(podSettings)
      .set({
        settings: drizzleSql`jsonb_set(
          coalesce(${podSettings.settings}, '{}'::jsonb),
          '{governanceRulesBackfill}',
          ${JSON.stringify(marker)}::jsonb,
          true
        )`,
        updatedAt: new Date(),
      })
      .where(eq(podSettings.id, existing.id));
  } else {
    await db
      .insert(podSettings)
      .values({ settings: { governanceRulesBackfill: marker } });
  }
}

export interface BackfillGovernanceRulesResult {
  workspaceRulesInserted: number;
  agentRulesInserted: number;
  /** Redundant floor-covered backfill rows soft-revoked by the cleanup. */
  floorCoveredRevoked: number;
  /**
   * True when the pod was ALREADY converged, so this boot did not read the
   * legacy `autoApproveFor` JSONB at all (the steady state past the first run).
   */
  skipped: boolean;
}

/**
 * Seed `governance_rules` from every workspace's + agent's existing
 * `autoApproveFor` JSONB list — ONCE per pod, ever (see the TRUE ONE-SHOT note
 * in the file header). Safe to call on every boot: past the first successful
 * run it short-circuits on the converged marker and returns `skipped: true`.
 * Never throws for an individual malformed row — a workspace/agent whose
 * JSONB doesn't parse as `string[]` is skipped, not fatal to the run.
 */
export async function backfillGovernanceRules(
  db: DbHandle
): Promise<BackfillGovernanceRulesResult> {
  return db.transaction((tx) => runBackfill(tx));
}

async function runBackfill(db: Tx): Promise<BackfillGovernanceRulesResult> {
  let workspaceRulesInserted = 0;
  let agentRulesInserted = 0;

  // Serialize concurrent boots: the loser blocks here until the winner commits,
  // then reads the winner's marker below and skips. Released on COMMIT/ROLLBACK.
  await db.execute(
    drizzleSql`SELECT pg_advisory_xact_lock(hashtext(${BACKFILL_LOCK_KEY}))`
  );

  // TRUE ONE-SHOT gate: never re-read the stale JSONB against a moving floor.
  if (await isConverged(db)) {
    return {
      workspaceRulesInserted: 0,
      agentRulesInserted: 0,
      floorCoveredRevoked: 0,
      skipped: true,
    };
  }

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

  // LAST: stamp converged. Same transaction as every write above, so a throw
  // anywhere earlier rolls back the marker with the rows — a partial run can
  // never look converged, and the next boot retries from a clean slate.
  await markConverged(db);

  return {
    workspaceRulesInserted,
    agentRulesInserted,
    floorCoveredRevoked,
    skipped: false,
  };
}
