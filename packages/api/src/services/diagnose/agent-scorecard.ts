/**
 * Agent-quality scorecard — the ALWAYS-ON, agent-system-AGNOSTIC tier.
 *
 * Pure SQL over `proposals` keyed by `proposals.agentUserId`: approve/reject/
 * revise rates, a rejection-reason histogram, and a duplicate rate derived from
 * the SAME structural fingerprint the review inbox uses. It describes an agent's
 * *behaviour* from governance data the pod already owns — never its
 * implementation, so there is NO `switch(agentType)` and NO Intelligence-Service
 * coupling (root CLAUDE.md: `agentType ⟂ intelligenceServiceId`).
 *
 * The optional "deep quality" tier (prompt/trace quality) is an IS-provided
 * capability verb resolved through the normal capability ladder — deliberately
 * NOT built here; this pod-side card is the floor that works for any agent.
 */

import {
  db,
  and,
  eq,
  gte,
  desc,
  drizzleSql,
  isNotNull,
  inArray,
  proposals,
  users,
  ProposalStatus,
} from "@synap/database";
import type { ProposalRevision } from "@synap/database";
import { userVisibleWhere } from "../../utils/user-visible-where.js";
import { collapseProposalsToClusters } from "../proposals/fingerprint.js";
import type { ClusterInputRow } from "../proposals/fingerprint.js";
import {
  AGENT_PROPOSALS_PER_USER_PER_DAY,
  agentDailyProposalCap,
  startOfUtcDay,
} from "../../utils/permission-check.js";
import type { AgentScorecard } from "./types.js";

/** The minimum a proposal row must expose to score an agent. Fingerprint-shaped. */
export interface ScorecardProposalRow {
  proposalType: string;
  targetType: string;
  targetId: string;
  data: unknown;
  status: string;
  rejectionReason: string | null;
  revisionHistory: ProposalRevision[] | null;
  createdAt: Date;
  workspaceId: string | null;
}

/**
 * PURE scorecard math over a set of an agent's proposals. DB-free so it is
 * unit-testable: hand it rows, get back counts + rates + the rejection
 * histogram + a duplicate rate (share of rows in a same-shape cluster > 1).
 */
export function computeAgentScorecard(
  rows: ScorecardProposalRow[],
  opts: {
    agentId: string;
    agentName: string | null;
    agentType: string | null;
    todayCount: number;
    cap?: number;
  }
): AgentScorecard {
  const cap = opts.cap ?? AGENT_PROPOSALS_PER_USER_PER_DAY;
  const total = rows.length;

  let pending = 0;
  let approved = 0;
  let rejected = 0;
  let revised = 0;
  const reasonHist = new Map<string, number>();

  for (const r of rows) {
    switch (r.status) {
      case ProposalStatus.PENDING:
      case ProposalStatus.APPROVAL_FAILED:
        pending += 1;
        break;
      case ProposalStatus.APPROVED:
      case ProposalStatus.AUTO_APPROVED:
        approved += 1;
        break;
      case ProposalStatus.REJECTED:
        rejected += 1;
        break;
      default:
        break;
    }
    if (Array.isArray(r.revisionHistory) && r.revisionHistory.length > 0) {
      revised += 1;
    }
    const reason = r.rejectionReason?.trim();
    if (reason) reasonHist.set(reason, (reasonHist.get(reason) ?? 0) + 1);
  }

  // Duplicate rate — reuse the EXACT structural fingerprint the review inbox
  // clusters on, so "duplicate" means the same thing everywhere. A row counts
  // as a duplicate if it shares its fingerprint with at least one sibling.
  const clusterRows: ClusterInputRow[] = rows.map((r, i) => ({
    id: String(i),
    proposalType: r.proposalType,
    targetType: r.targetType,
    targetId: r.targetId,
    data: r.data,
    createdAt: r.createdAt,
    workspaceId: r.workspaceId,
  }));
  const clusters = collapseProposalsToClusters(clusterRows);
  const inDuplicateCluster = clusters
    .filter((c) => c.count > 1)
    .reduce((sum, c) => sum + c.count, 0);

  const rate = (n: number) => (total > 0 ? Number((n / total).toFixed(4)) : 0);

  const rejectionReasons = [...reasonHist.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    mode: "agent",
    agentId: opts.agentId,
    agentName: opts.agentName,
    agentType: opts.agentType,
    sampled: total,
    counts: { total, pending, approved, rejected, revised },
    rates: {
      approveRate: rate(approved),
      rejectRate: rate(rejected),
      reviseRate: rate(revised),
      duplicateRate: rate(inDuplicateCluster),
    },
    rejectionReasons,
    dailyCap: {
      todayCount: opts.todayCount,
      cap,
      atOrOverCap: opts.todayCount >= cap,
    },
  };
}

/** Cap on proposals scanned to build a scorecard (bounds a chatty agent). */
const SCORECARD_SCAN_LIMIT = 500;

/**
 * DB tier: fetch an agent-user's proposals (USER-floored) + its today-count,
 * then hand them to the pure `computeAgentScorecard`. Returns an error object
 * when `agentId` is not an agent-user visible to the caller.
 */
export async function agentScorecard(params: {
  userId: string;
  agentId: string;
}): Promise<AgentScorecard | { error: string }> {
  const { userId, agentId } = params;

  const [agent] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      userType: users.userType,
      agentType: users.agentType,
    })
    .from(users)
    // OWNER FLOOR: only the caller's OWN agent-users. Without this, a guessed
    // agent UUID would leak that agent's name/email/agentType cross-user (the
    // proposal aggregation below is already user-floored, but the identity row
    // was not). Mirrors the same floor resolveObjectKind's agent probe applies.
    .where(and(eq(users.id, agentId), eq(users.createdByUserId, userId)))
    .limit(1);

  if (!agent || agent.userType !== "agent") {
    return { error: `No agent-user found for id ${agentId}` };
  }

  // USER floor: only proposals in workspaces the caller can see. An agent acting
  // for a different owner never leaks into this card.
  const rows = await db
    .select({
      proposalType: proposals.proposalType,
      targetType: proposals.targetType,
      targetId: proposals.targetId,
      data: proposals.data,
      status: proposals.status,
      rejectionReason: proposals.rejectionReason,
      revisionHistory: proposals.revisionHistory,
      createdAt: proposals.createdAt,
      workspaceId: proposals.workspaceId,
    })
    .from(proposals)
    .where(
      and(
        eq(proposals.agentUserId, agentId),
        userVisibleWhere(proposals.workspaceId, userId)
      )
    )
    .orderBy(desc(proposals.createdAt))
    .limit(SCORECARD_SCAN_LIMIT);

  // Daily-cap posture: the cap is per-AGENT (not shared across the owner's
  // roster) and scales with this agent's own trust (base 10, x3 for a proven
  // agent) — see `agentDailyProposalCap()`, the same helper `createProposal`
  // enforces against.
  const [todayRow, cap] = await Promise.all([
    db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(proposals)
      .where(
        and(
          eq(proposals.createdBy, userId),
          eq(proposals.agentUserId, agentId),
          gte(proposals.createdAt, startOfUtcDay())
        )
      )
      .then((rows) => rows[0]),
    agentDailyProposalCap(agentId),
  ]);

  return computeAgentScorecard(rows, {
    agentId,
    agentName: agent.name ?? agent.email ?? null,
    agentType: agent.agentType ?? null,
    todayCount: todayRow?.count ?? 0,
    cap,
  });
}

/** One agent's standing in the pod-wide trust grid — REAL lifetime totals. */
export interface AgentStanding {
  agentUserId: string;
  agentName: string | null;
  agentType: string | null;
  /** Human approvals (approved + auto_approved). */
  approved: number;
  /** Subset of `approved` that were auto-approved (no human touched them). */
  autoApproved: number;
  rejected: number;
  reverted: number;
  /** Not scored — pending + approval_failed. */
  pending: number;
  /** Not scored — the agent recalled it. */
  withdrawn: number;
  /** Denominator: approved + rejected + reverted (genuine decisions). */
  scoredTotal: number;
  approveRate: number;
  refuseRate: number;
}

/**
 * The pod-wide trust grid: a REAL `count(*) GROUP BY agent_user_id, status`
 * across every proposal the caller can see, so the numbers are lifetime totals —
 * not a fetched-page slice like the browser's old client-side reduce. Only
 * AGENT-user actors are returned (humans are filtered out by `userType`), keyed
 * on the stable `agentUserId` so two agents that display the same name never
 * collapse. Sorted most-refused-first (highest learning value).
 */
export async function allAgentsScorecard(params: {
  userId: string;
}): Promise<AgentStanding[]> {
  const { userId } = params;

  // USER floor: only proposals in workspaces the caller can see.
  const rows = await db
    .select({
      agentUserId: proposals.agentUserId,
      status: proposals.status,
      count: drizzleSql<number>`count(*)::int`,
    })
    .from(proposals)
    .where(
      and(
        isNotNull(proposals.agentUserId),
        userVisibleWhere(proposals.workspaceId, userId)
      )
    )
    .groupBy(proposals.agentUserId, proposals.status);

  type Acc = {
    approved: number;
    autoApproved: number;
    rejected: number;
    reverted: number;
    pending: number;
    withdrawn: number;
  };
  const byAgent = new Map<string, Acc>();
  for (const r of rows) {
    if (!r.agentUserId) continue;
    const a = byAgent.get(r.agentUserId) ?? {
      approved: 0,
      autoApproved: 0,
      rejected: 0,
      reverted: 0,
      pending: 0,
      withdrawn: 0,
    };
    switch (r.status) {
      case ProposalStatus.APPROVED:
        a.approved += r.count;
        break;
      case ProposalStatus.AUTO_APPROVED:
        a.approved += r.count;
        a.autoApproved += r.count;
        break;
      case ProposalStatus.REJECTED:
        a.rejected += r.count;
        break;
      case ProposalStatus.REVERTED:
        a.reverted += r.count;
        break;
      case ProposalStatus.PENDING:
      case ProposalStatus.APPROVAL_FAILED:
        a.pending += r.count;
        break;
      case ProposalStatus.WITHDRAWN:
        a.withdrawn += r.count;
        break;
      default:
        break;
    }
    byAgent.set(r.agentUserId, a);
  }

  const ids = [...byAgent.keys()];
  if (ids.length === 0) return [];

  // Resolve identity — DROP non-agent actors (a human owner whose proposals are
  // visible must never show up), AND owner-floor to the caller's OWN agents. The
  // owner floor keeps the grid consistent with the per-agent detail doors
  // (`agentProfile`/`agentScorecard`, which are owner-floored): without it a
  // team-pod card for a co-member's agent would be a dead link (the detail probe
  // would miss). It also matches the identity-leak floor the detail doors apply.
  const identities = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      userType: users.userType,
      agentType: users.agentType,
    })
    .from(users)
    .where(
      and(
        inArray(users.id, ids),
        eq(users.userType, "agent"),
        eq(users.createdByUserId, userId)
      )
    );

  const standings: AgentStanding[] = [];
  for (const ident of identities) {
    const a = byAgent.get(ident.id);
    if (!a) continue;
    const scoredTotal = a.approved + a.rejected + a.reverted;
    const rate = (n: number) =>
      scoredTotal > 0 ? Number((n / scoredTotal).toFixed(4)) : 0;
    standings.push({
      agentUserId: ident.id,
      agentName: ident.name ?? ident.email ?? null,
      agentType: ident.agentType ?? null,
      approved: a.approved,
      autoApproved: a.autoApproved,
      rejected: a.rejected,
      reverted: a.reverted,
      pending: a.pending,
      withdrawn: a.withdrawn,
      scoredTotal,
      approveRate: rate(a.approved),
      refuseRate: rate(a.rejected),
    });
  }

  // Most-refused-first — the highest learning value.
  standings.sort(
    (x, y) => y.refuseRate - x.refuseRate || y.rejected - x.rejected
  );
  return standings;
}
