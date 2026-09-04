/**
 * GLOBAL diagnosis — whole-pod health, composed from existing reads.
 *
 * A no-arg `diagnose` runs a fixed checklist and returns a ranked health report.
 * The door only ORCHESTRATES + RANKS; every signal reuses a primitive that
 * already exists (the runs substrate, the pending-proposal reads,
 * `collapseProposalsToClusters`). All USER-floored — it aggregates across every
 * workspace the caller can see (the sovereign "whole brain"), narrowable with a
 * `workspaceId`.
 *
 * HONEST-EMPTY by construction: when nothing is wrong the summary SAYS so
 * ("no stuck runs, no backlog, N capabilities healthy") rather than returning a
 * bare empty object.
 */

import {
  db,
  and,
  eq,
  gte,
  desc,
  drizzleSql,
  proposals,
  ProposalStatus,
  capabilities,
} from "@synap/database";
import { or } from "@synap/database";
import { userVisibleWhere } from "../../utils/user-visible-where.js";
import { ownAgentUserFilter } from "../agent-identity-service.js";
import { listRuns, listRunGroups } from "../runs/index.js";
import {
  collapseProposalsToClusters,
  type ClusterInputRow,
} from "../proposals/fingerprint.js";
import {
  AGENT_PROPOSALS_PER_USER_PER_DAY,
  startOfUtcDay,
} from "../../utils/permission-check.js";
import {
  DEFAULT_STUCK_THRESHOLD_HOURS,
  type GlobalHealthReport,
  type HealthSection,
  type HealthStatus,
} from "./types.js";
import {
  IDLE_STALL_MINUTES,
  classifyStalls,
  type StallReport,
} from "./stall.js";

const HOUR_MS = 60 * 60 * 1000;
const PENDING_SCAN_LIMIT = 1000;
/** An agent this close to the daily cap is worth flagging as "attention". */
const CAP_ATTENTION_FRACTION = 0.8;

// ── The raw signals the pure summarizer ranks ────────────────────────────────

export interface GlobalSignals {
  stuckHours: number;
  stuck: Array<{
    id: string;
    flowType: string;
    flowName: string;
    ageHours: number;
  }>;
  /**
   * The progress-based half of the stuck signal (see ./stall.ts). Optional so
   * existing callers/tests that only supply `stuck` keep working and simply get
   * the historical age-only verdict — absent means "not computed", and the
   * section says nothing about idleness rather than claiming none.
   */
  stall?: StallReport;
  /** Minutes of no-progress that counts as idle (echoed into thresholds). */
  idleMinutes?: number;
  failedFlows: Array<{
    flowName: string;
    failedCount: number;
    hasRunning: boolean;
  }>;
  backlog: {
    pending: number;
    oldestAgeHours: number | null;
    /**
     * Pending rows traceable to this user whose `workspaceId` does NOT resolve
     * to a workspace they belong to — malformed/orphaned placement. Reported,
     * never dropped: a health door that hides broken records hides exactly the
     * ones needing attention.
     */
    mineOutsideLens: number;
  };
  duplicateClusters: Array<{ targetLabel: string; count: number }>;
  capabilities: { enabled: number; unapproved: number };
  agentActivity: Array<{ agentId: string; todayCount: number; cap: number }>;
}

/**
 * PURE: rank the signals into sections + a roll-up status + an honest-empty
 * plain-language summary. DB-free, so this is the unit-tested heart of GLOBAL.
 */
export function summarizeGlobalHealth(
  signals: GlobalSignals,
  scope: { workspaceId: string | null }
): GlobalHealthReport {
  const sections: HealthSection[] = [];

  // Stuck runs — TWO signals, ranked (see ./stall.ts for why age alone lied).
  //   aged (past the hour boundary)      → degraded, the historical verdict
  //   idle (no progress, minutes-scale)  → attention, "worth a look"
  // `count` / `oldest` keep meaning EXACTLY what they meant (the aged list), so
  // the browser's FlowHealthBand and the Raycast card read unchanged; idleness
  // is additive detail. `unobservableRunning` is stated out loud: a section that
  // silently omits the runs it cannot judge is how "No stuck runs" got printed
  // over a hung session in the first place.
  const idle = signals.stall?.idle ?? [];
  const unobservable = signals.stall?.unobservable ?? 0;
  const idleMinutes = signals.idleMinutes ?? null;
  sections.push({
    key: "stuck_runs",
    status:
      signals.stuck.length > 0
        ? "degraded"
        : idle.length > 0
          ? "attention"
          : "ok",
    headline:
      signals.stuck.length > 0
        ? `${signals.stuck.length} run(s) still running past ${signals.stuckHours}h` +
          (idle.length > 0 ? `, ${idle.length} more idle` : "")
        : idle.length > 0
          ? `${idle.length} run(s) running but idle${
              idleMinutes !== null
                ? ` for over ${Math.round(idleMinutes)}m`
                : ""
            }`
          : "No stuck runs",
    detail: {
      count: signals.stuck.length,
      thresholdHours: signals.stuckHours,
      oldest: signals.stuck.slice(0, 5),
      idleCount: idle.length,
      idleThresholdMinutes: idleMinutes,
      idlest: idle.slice(0, 5),
      /** Running runs whose ledger records no progress timestamp at all. */
      unobservableRunning: unobservable,
    },
  });

  // Failed flows — degraded if any flow has a failure.
  const failedTotal = signals.failedFlows.reduce(
    (s, f) => s + f.failedCount,
    0
  );
  sections.push({
    key: "failed_flows",
    status: signals.failedFlows.length > 0 ? "degraded" : "ok",
    headline:
      signals.failedFlows.length > 0
        ? `${failedTotal} failed run(s) across ${signals.failedFlows.length} flow(s)`
        : "No failed flows",
    detail: { flows: signals.failedFlows.slice(0, 10), failedTotal },
  });

  // Review backlog — attention when non-empty; degraded when it's gone stale.
  const oldest = signals.backlog.oldestAgeHours;
  const backlogStatus: HealthStatus =
    signals.backlog.pending === 0
      ? "ok"
      : oldest !== null && oldest > 48
        ? "degraded"
        : "attention";
  const mineOutsideLens = signals.backlog.mineOutsideLens;
  sections.push({
    key: "review_backlog",
    status: backlogStatus,
    headline:
      signals.backlog.pending === 0 && mineOutsideLens === 0
        ? "No pending proposals"
        : `${signals.backlog.pending} pending proposal(s)` +
          (oldest !== null ? `, oldest ${Math.round(oldest)}h` : "") +
          // Name the gap rather than dropping it. These rows are pending and
          // traceable to this user, but their workspaceId does not resolve to
          // a workspace they are a member of — malformed or orphaned placement.
          // Silently excluding them is what made this door disagree with
          // `orient` across three external test passes.
          (mineOutsideLens > 0
            ? `; ${mineOutsideLens} more of yours sit outside your workspace lens (unresolvable placement) — list proposals to see them`
            : ""),
    detail: { ...signals.backlog, mineOutsideLens },
  });

  // Similar-proposal groups — a review-GROUPING signal, not a duplicate
  // detector: `computeProposalFingerprint` clusters on a deliberately loose
  // structural key (proposalType × targetType × name), so a cluster can
  // legitimately contain distinct payloads that merely share that shape (see
  // the file's own FINGERPRINT_CAUSE_EXTENSION note). It reads "N proposals
  // want to change X" for the reviewer — it is NOT evidence of a governance
  // bug. The strict, preventive de-duplication is `dedup_hash` + the 0208
  // partial unique index, a separate mechanism this section does not surface.
  // `attention` here means "worth a look", never "degraded" — a grouping is
  // informational and must never register as a health failure.
  sections.push({
    key: "duplicate_proposals",
    status: signals.duplicateClusters.length > 0 ? "attention" : "ok",
    headline:
      signals.duplicateClusters.length > 0
        ? `${signals.duplicateClusters.length} proposal(s) grouped by similarity for review`
        : "No similar-proposal groups pending review",
    detail: { clusters: signals.duplicateClusters.slice(0, 10) },
  });

  // Capabilities — attention when some are enabled-but-unapproved. Live
  // per-connection outage detection is deferred (see NEEDS-DOGFOOD in the impl).
  sections.push({
    key: "capabilities",
    status: signals.capabilities.unapproved > 0 ? "attention" : "ok",
    headline:
      signals.capabilities.enabled > 0 || signals.capabilities.unapproved > 0
        ? `${signals.capabilities.enabled} capability(ies) approved, ${signals.capabilities.unapproved} awaiting approval`
        : "No capabilities configured",
    detail: signals.capabilities,
  });

  // Agent activity — degraded when an agent is at/over the daily cap.
  const overCap = signals.agentActivity.filter((a) => a.todayCount >= a.cap);
  const nearCap = signals.agentActivity.filter(
    (a) =>
      a.todayCount < a.cap && a.todayCount >= a.cap * CAP_ATTENTION_FRACTION
  );
  sections.push({
    key: "agent_activity",
    status:
      overCap.length > 0 ? "degraded" : nearCap.length > 0 ? "attention" : "ok",
    headline:
      overCap.length > 0
        ? `${overCap.length} agent(s) hit the daily proposal cap`
        : nearCap.length > 0
          ? `${nearCap.length} agent(s) approaching the daily cap`
          : "No agent flooding the queue",
    detail: { overCap, nearCap },
  });

  // Roll up: worst section wins.
  const rank: Record<HealthStatus, number> = {
    ok: 0,
    attention: 1,
    degraded: 2,
  };
  const status = sections.reduce<HealthStatus>(
    (worst, s) => (rank[s.status] > rank[worst] ? s.status : worst),
    "ok"
  );

  const problems = sections.filter((s) => s.status !== "ok");
  const summary =
    problems.length === 0
      ? `All clear — no stuck runs, no failed flows, no review backlog, and ${signals.capabilities.enabled} capability(ies) healthy.`
      : `${problems.length} area(s) need attention: ` +
        problems.map((s) => s.headline).join("; ") +
        ".";

  return {
    mode: "global",
    status,
    summary,
    thresholds: {
      stuckHours: signals.stuckHours,
      ...(idleMinutes !== null ? { idleMinutes } : {}),
    },
    scope,
    sections,
  };
}

// ── DB tier: gather the signals, then summarize ──────────────────────────────

/**
 * Run the whole-pod health checklist for `userId`. `workspaceId` narrows the
 * floor to one lens; `stuckThresholdHours` overrides the "stuck" boundary.
 */
export async function diagnoseGlobal(params: {
  userId: string;
  workspaceId?: string | null;
  stuckThresholdHours?: number;
}): Promise<GlobalHealthReport> {
  const { userId } = params;
  const workspaceId = params.workspaceId ?? null;
  const stuckHours =
    params.stuckThresholdHours ?? DEFAULT_STUCK_THRESHOLD_HOURS;
  const now = Date.now();
  const scope = workspaceId ? { workspaceId } : undefined;

  // Fire the independent reads together.
  // Chat is included in listRuns only for status=running|failed (or
  // flowType=chat) so successful Discord pings never flood stuck/failed.
  const [
    runningRuns,
    groups,
    failedChatRuns,
    backlogRow,
    // Author-floored twin of `backlogRow` — see the comment on its query.
    mineBacklogRow,
    pendingRows,
    capRows,
    agentRows,
  ] = await Promise.all([
    // Stuck: running runs across flows (per-flow cap 100), aged client-side.
    // Includes chat turns still `running` past the threshold.
    listRuns({ userId, status: "running", scope, limit: 100 }),
    // Failed: per-flow failure counts (automation/playbook — already in-DB).
    listRunGroups({ userId, scope, limit: 100 }),
    // Failed chat turns (no flowId group) — B4: only failures, not successes.
    listRuns({ userId, flowType: "chat", status: "failed", scope, limit: 100 }),
    // Backlog: exact count + oldest age of pending proposals (user-floored).
    db
      .select({
        pending: drizzleSql<number>`count(*)::int`,
        oldest: drizzleSql<Date | null>`min(${proposals.createdAt})`,
      })
      .from(proposals)
      .where(
        and(
          userVisibleWhere(proposals.workspaceId, userId),
          eq(proposals.status, ProposalStatus.PENDING),
          workspaceId ? eq(proposals.workspaceId, workspaceId) : undefined
        )
      ),
    // SECOND floor, deliberately: the count above is WORKSPACE-lensed, so a
    // pending row whose `workspaceId` does not resolve to a workspace this user
    // is a member of is DROPPED — and those are exactly the rows that need
    // attention (orphaned workspace ids; one row carries a USER id in the
    // workspace column). A health door that hides malformed records is the
    // worst place for that to happen: three external test passes reported
    // `diagnose` saying 11 while `orient` and `list_proposals` said 14.
    //
    // This adds NO disclosure. It is the same AUTHOR floor `orient` already
    // reports to this same user (`discover.ts`), so the number is one the
    // caller can already see — it just stops two surfaces disagreeing without
    // explanation. It is NOT a workspace widening: no membership term.
    db
      .select({ mine: drizzleSql<number>`count(*)::int` })
      .from(proposals)
      .where(
        and(
          or(
            eq(proposals.createdBy, userId),
            ownAgentUserFilter(proposals.agentUserId, userId),
            ownAgentUserFilter(proposals.createdBy, userId)
          ),
          eq(proposals.status, ProposalStatus.PENDING),
          workspaceId ? eq(proposals.workspaceId, workspaceId) : undefined
        )
      ),
    // Duplicate clustering: a capped scan of the pending rows.
    db
      .select({
        id: proposals.id,
        proposalType: proposals.proposalType,
        targetType: proposals.targetType,
        targetId: proposals.targetId,
        data: proposals.data,
        createdAt: proposals.createdAt,
        workspaceId: proposals.workspaceId,
      })
      .from(proposals)
      .where(
        and(
          userVisibleWhere(proposals.workspaceId, userId),
          eq(proposals.status, ProposalStatus.PENDING),
          workspaceId ? eq(proposals.workspaceId, workspaceId) : undefined
        )
      )
      .orderBy(desc(proposals.createdAt))
      .limit(PENDING_SCAN_LIMIT),
    // Capability posture: approved vs awaiting-approval (user-floored).
    db
      .select({ approved: capabilities.approved })
      .from(capabilities)
      .where(
        and(
          userVisibleWhere(capabilities.workspaceId, userId),
          workspaceId ? eq(capabilities.workspaceId, workspaceId) : undefined
        )
      ),
    // Agent activity today: per-agent proposal counts for this owner.
    //
    // Floored by LINEAGE (`agentUserId` is one of MY agents), not by
    // `createdBy = <human> AND agentUserId IS NOT NULL`. That pair excluded
    // the MAJORITY row shape: `proposals.createdBy` is overloaded ("userId or
    // agentUserId that authored this row"), so an agent write that passes no
    // explicit createdBy lands `createdBy = agentUserId = <agent>` — measured
    // live at 4 of 6 pending on this pod. The hard daily cap
    // (`countTodayAgentProposals`) counts `agentUserId` alone, so the old pair
    // here displayed a SMALLER number than the counter enforcing the refusal
    // this panel exists to explain. Same floor as the cap = the two agree.
    db
      .select({
        agentId: proposals.agentUserId,
        todayCount: drizzleSql<number>`count(*)::int`,
      })
      .from(proposals)
      .where(
        and(
          ownAgentUserFilter(proposals.agentUserId, userId),
          gte(proposals.createdAt, startOfUtcDay())
        )
      )
      .groupBy(proposals.agentUserId),
  ]);

  // ONE pass over the running set produces BOTH halves of the signal — the aged
  // list (unchanged shape, unchanged meaning) and the progress-based idle list.
  const stall = classifyStalls(
    runningRuns.map((r) => ({
      id: r.id,
      flowType: r.flowType,
      flowName: r.flowName,
      startedAt: r.startedAt,
      lastActivityAt: r.lastActivityAt,
    })),
    now,
    { agedHours: stuckHours, idleMinutes: IDLE_STALL_MINUTES }
  );
  const stuck = stall.aged.map((r) => ({
    id: r.id,
    flowType: r.flowType,
    flowName: r.flowName,
    ageHours: r.ageHours,
  }));

  const failedFlows = groups
    .filter((g) => g.failedCount > 0)
    .map((g) => ({
      flowName: g.flowName,
      failedCount: g.failedCount,
      hasRunning: g.hasRunning,
    }));
  // Chat has no flowId group — surface failed chat as one synthetic "Chat" row.
  if (failedChatRuns.length > 0) {
    failedFlows.push({
      flowName: "Chat",
      failedCount: failedChatRuns.length,
      hasRunning: runningRuns.some((r) => r.flowType === "chat"),
    });
  }

  const backlogPending = backlogRow[0]?.pending ?? 0;
  const backlog = {
    pending: backlogPending,
    oldestAgeHours: backlogRow[0]?.oldest
      ? (now - new Date(backlogRow[0].oldest).getTime()) / HOUR_MS
      : null,
    // Clamped at 0: the author floor is NOT a superset of the workspace floor
    // (a teammate's row in a shared workspace is workspace-visible but not
    // author-mine), so the difference can legitimately go negative and a
    // negative "hidden" count would be nonsense.
    mineOutsideLens: Math.max(
      0,
      (mineBacklogRow[0]?.mine ?? 0) - backlogPending
    ),
  };

  const clusterRows: ClusterInputRow[] = pendingRows.map((r) => ({
    id: r.id,
    proposalType: r.proposalType,
    targetType: r.targetType,
    targetId: r.targetId,
    data: r.data,
    createdAt: r.createdAt,
    workspaceId: r.workspaceId ?? null,
  }));
  const duplicateClusters = collapseProposalsToClusters(clusterRows)
    .filter((c) => c.count > 1)
    .map((c) => ({ targetLabel: c.targetLabel, count: c.count }))
    .sort((a, b) => b.count - a.count);

  const capabilitiesSignal = {
    enabled: capRows.filter((c) => c.approved).length,
    unapproved: capRows.filter((c) => !c.approved).length,
  };

  const agentActivity = agentRows
    .filter((a): a is { agentId: string; todayCount: number } =>
      Boolean(a.agentId)
    )
    .map((a) => ({
      agentId: a.agentId,
      todayCount: a.todayCount,
      cap: AGENT_PROPOSALS_PER_USER_PER_DAY,
    }));

  return summarizeGlobalHealth(
    {
      stuckHours,
      stuck,
      stall,
      idleMinutes: IDLE_STALL_MINUTES,
      failedFlows,
      backlog,
      duplicateClusters,
      capabilities: capabilitiesSignal,
      agentActivity,
    },
    { workspaceId }
  );
}
