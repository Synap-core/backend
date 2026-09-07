/**
 * Governance RAISE-CEILING recommender — the numeric-limit twin of the
 * `governance.tighten_lane` recommender (`recommend-tighten.ts`).
 *
 * Where tighten watches an agent's REJECTED proposals and PROPOSES pinning a
 * write-motif back to review, this recommender watches an agent's DAILY
 * AUTO-WRITE VOLUME and, when the agent keeps bumping its per-UTC-day write
 * ceiling for several days running, PROPOSES RAISING that ceiling. A ceiling
 * (`governance_ceilings`, axis `daily_write_count`) downgrades an over-budget
 * auto-write to a proposal at rung 2.56; an agent that legitimately does more
 * work per day than its cap allows generates a steady trickle of ceiling-forced
 * proposals, and the fix is to raise the cap — a human decision, so this
 * recommender FILES it as a `governance.raise_ceiling` proposal rather than
 * writing the ceiling directly.
 *
 * NEVER silent + never a direct ceiling write: like tighten/widen, the ONLY
 * side effect is a PENDING proposal via the one door `insertPendingProposal`,
 * plus its pod-wide notification. Approving it inserts the `governance_ceilings`
 * row — see the approve-branch (B4d) in `apply-approval.ts`.
 *
 * SEAM MIRRORED FROM recommend-tighten.ts:
 *   - agent enumeration (`listAgentUsers`) + resilient per-agent loop
 *     (`recommendRaiseCeilingForAllAgents`) — one agent's failure never aborts
 *     the batch.
 *   - the one-door `insertPendingProposal` + `notifyPodWideProposal` +
 *     `emitSideEffects` fan-out, verbatim shape.
 *   - per-agent dedupe against an already-open pending proposal + a covering
 *     store row (there: a covering propose RULE; here: a covering higher CEILING).
 *
 * The one structural divergence: the signal is per-UTC-DAY WRITE VOLUME on the
 * `events` spine (not rejected proposals). Daily counts reuse the SAME predicate
 * as `countAgentWritesTodayUtc` (`is_agent = true AND proposal_id IS NULL`,
 * matching the partial index `idx_events_ungoverned_agent`), grouped by UTC day,
 * and each day is compared to the agent's resolved ceiling via the SAME resolver
 * rung 2.56 enforces (`resolveDailyWriteCeiling`). The ceiling is a per-agent
 * pod-wide daily budget, so this recommender is pod-scoped: it never carries a
 * workspace dimension.
 */

import {
  db,
  and,
  or,
  eq,
  isNull,
  gt,
  gte,
  count,
  sqlTemplate,
  events,
  users,
  proposals,
  governanceCeilings,
  insertPendingProposal,
  ProposalStatus,
} from "@synap/database";
import { resolveDailyWriteCeiling } from "@synap/database/agent-governance";
import { createLogger } from "@synap-core/core";
import { emitSideEffects } from "@synap/events";
import { notifyPodWideProposal } from "../../notifications/notify-pod-wide-proposal.js";

const logger = createLogger({ module: "governance-recommend-raise-ceiling" });

/**
 * `governance.raise_ceiling` proposal payload. The subject agent lives in the
 * payload (`agentUserId`) — this recommender authors the row, the agent does
 * not (so `proposals.agentUserId` is null). Pod-scoped only: the daily-write
 * ceiling is a per-agent pod-wide budget.
 */
export interface GovernanceRaiseCeilingProposalData {
  agentUserId: string;
  scopeKind: "pod";
  workspaceId?: string | null;
  /** The agent's resolved ceiling today (the limit it keeps hitting). */
  currentLimit: number;
  /** The proposed new ceiling (currentLimit * RAISE_FACTOR, rounded up). */
  proposedLimit: number;
  evidence: {
    /** How many of the last LOOKBACK_DAYS the agent was at/near its ceiling. */
    daysAtCeiling: number;
    /** Up to SAMPLE_CAP `{ day, count }` samples of the at-ceiling days. */
    sampleDays: Array<{ day: string; count: number }>;
  };
}

/**
 * Conservative floors — recommender NOISE is the failure mode (mirrors
 * recommend-tighten's MIN_CLUSTER_SIZE / MIN_REJECT_RATE spirit):
 *   - LOOKBACK_DAYS: the window (M) of recent UTC days examined.
 *   - CEILING_UTILIZATION: a day counts as "at ceiling" at ≥ this fraction of
 *     the resolved limit.
 *   - MIN_DAYS_AT_CEILING: at least this many (N) of the last M days at ceiling.
 *   - RAISE_FACTOR: the proposed new limit = ceil(currentLimit * RAISE_FACTOR).
 */
const LOOKBACK_DAYS = 7;
const CEILING_UTILIZATION = 0.8;
const MIN_DAYS_AT_CEILING = 3;
const RAISE_FACTOR = 1.5;
const SAMPLE_CAP = 20;

interface AgentRow {
  id: string;
  createdByUserId: string | null;
}

interface DailyCount {
  day: string;
  n: number;
}

async function listAgentUsers(): Promise<AgentRow[]> {
  return db
    .select({ id: users.id, createdByUserId: users.createdByUserId })
    .from(users)
    .where(eq(users.userType, "agent"));
}

/**
 * Per-UTC-day auto-write counts for this agent over the last LOOKBACK_DAYS. The
 * WHERE clause matches `idx_events_ungoverned_agent`'s predicate EXACTLY
 * (`is_agent = true AND proposal_id IS NULL`, plus agent + a timestamp floor) so
 * PG can serve it from that partial index — the SAME population
 * `countAgentWritesTodayUtc` counts for TODAY, here bucketed by day.
 */
async function loadAgentDailyWriteCounts(
  agentId: string,
  since: Date
): Promise<DailyCount[]> {
  const dayExpr = sqlTemplate<string>`to_char(date_trunc('day', ${events.timestamp} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`;
  const rows = (await db
    .select({ day: dayExpr, n: count() })
    .from(events)
    .where(
      and(
        eq(events.agentUserId, agentId),
        eq(events.isAgent, true),
        isNull(events.proposalId),
        gte(events.timestamp, since)
      )
    )
    .groupBy(dayExpr)) as Array<{ day: string; n: number }>;
  return rows.map((r) => ({ day: r.day, n: Number(r.n) }));
}

/**
 * Any PENDING `governance.raise_ceiling` already open for this agent. Mirror of
 * tighten's `hasPendingTightenProposal`, keyed on the subject agent in `data`
 * (this recommender authors the row; `proposals.agentUserId` is null).
 */
async function hasPendingRaiseProposal(agentId: string): Promise<boolean> {
  const rows = await db
    .select({ data: proposals.data })
    .from(proposals)
    .where(
      and(
        eq(proposals.proposalType, "governance.raise_ceiling"),
        eq(proposals.status, ProposalStatus.PENDING)
      )
    );
  return rows.some((r) => {
    const data = r.data as Partial<GovernanceRaiseCeilingProposalData> | null;
    return data?.agentUserId === agentId;
  });
}

/**
 * A covering higher ceiling already exists — an ACTIVE agent-scoped
 * `daily_write_count` ceiling for this agent whose limit already meets/exceeds
 * what we would propose, so proposing again is redundant. Mirror of tighten's
 * `hasCoveringProposeRule` (there: a covering propose RULE; here: a covering
 * higher CEILING). "Active" reuses `resolveDailyWriteCeiling`'s predicate
 * (`revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`).
 */
async function hasCoveringHigherCeiling(
  agentId: string,
  proposedLimit: number
): Promise<boolean> {
  const rows = (await db
    .select({ limitValue: governanceCeilings.limitValue })
    .from(governanceCeilings)
    .where(
      and(
        eq(governanceCeilings.axis, "daily_write_count"),
        eq(governanceCeilings.principalKind, "agent"),
        eq(governanceCeilings.agentUserId, agentId),
        isNull(governanceCeilings.revokedAt),
        or(
          isNull(governanceCeilings.expiresAt),
          gt(governanceCeilings.expiresAt, new Date())
        )
      )
    )) as Array<{ limitValue: number }>;
  return rows.some((r) => r.limitValue >= proposedLimit);
}

/** Scan ONE agent; file a raise-ceiling proposal if it qualifies. */
async function recommendRaiseCeilingForAgent(
  agent: AgentRow
): Promise<string[]> {
  if (!agent.createdByUserId) return [];

  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const dailyCounts = await loadAgentDailyWriteCounts(agent.id, since);
  if (dailyCounts.length === 0) return [];

  // Resolve the ceiling the agent keeps hitting — the SAME resolver rung 2.56
  // enforces. Pod-wide per-agent budget, so no workspace dimension.
  const currentLimit = await resolveDailyWriteCeiling({
    db,
    agentUserId: agent.id,
    workspaceId: undefined,
  });

  const atCeilingThreshold = Math.ceil(currentLimit * CEILING_UTILIZATION);
  const atCeilingDays = dailyCounts.filter((d) => d.n >= atCeilingThreshold);
  if (atCeilingDays.length < MIN_DAYS_AT_CEILING) return [];

  const proposedLimit = Math.ceil(currentLimit * RAISE_FACTOR);
  // Guard the always-raise invariant: never file a no-op or a downgrade.
  if (proposedLimit <= currentLimit) return [];

  if (await hasPendingRaiseProposal(agent.id)) return [];
  if (await hasCoveringHigherCeiling(agent.id, proposedLimit)) return [];

  const data: GovernanceRaiseCeilingProposalData = {
    agentUserId: agent.id,
    scopeKind: "pod",
    workspaceId: null,
    currentLimit,
    proposedLimit,
    evidence: {
      daysAtCeiling: atCeilingDays.length,
      sampleDays: atCeilingDays
        .slice(0, SAMPLE_CAP)
        .map((d) => ({ day: d.day, count: d.n })),
    },
  };

  const { proposal, deduped } = await insertPendingProposal({
    workspaceId: null,
    targetType: "governance",
    targetId: agent.id,
    proposalType: "governance.raise_ceiling",
    data: data as unknown as Record<string, unknown>,
    createdBy: agent.createdByUserId,
    proposedByUserId: null,
    // OWNER FLOOR (0248): the human who owns this agent decides its ceiling.
    subjectUserId: agent.createdByUserId,
  });

  // TELL A HUMAN — same rationale as recommend-tighten: insertPendingProposal is
  // durable but fires no notification, so without this the proposal is invisible.
  if (!deduped) {
    void notifyPodWideProposal({
      proposalId: proposal.id,
      proposalType: "governance.raise_ceiling",
      description: `Raise daily write ceiling ${currentLimit}→${proposedLimit} (at ceiling ${atCeilingDays.length}/${LOOKBACK_DAYS} days)`,
      agentUserId: agent.id,
    });
  }

  void emitSideEffects({
    subjectType: "proposal",
    action: "created",
    subjectId: proposal.id,
    userId: agent.createdByUserId,
    data: {
      proposalStatus: "created",
      targetType: "governance",
      changeType: "governance.raise_ceiling",
    },
  }).catch((err) => {
    logger.warn(
      { err, proposalId: proposal.id, agentId: agent.id },
      "recommend-raise-ceiling: emitSideEffects failed (non-fatal)"
    );
  });

  logger.info(
    {
      agentId: agent.id,
      currentLimit,
      proposedLimit,
      daysAtCeiling: atCeilingDays.length,
    },
    "recommend-raise-ceiling: filed raise_ceiling proposal"
  );

  return [proposal.id];
}

/**
 * Scan EVERY agent-user and file raise-ceiling proposals. Resilient per-agent
 * (mirror recommendTightenForAllAgents). Returns the ids of every filed
 * `governance.raise_ceiling` proposal.
 */
export async function recommendRaiseCeilingForAllAgents(): Promise<{
  proposalsFiled: number;
  proposalIds: string[];
}> {
  logger.info("recommend-raise-ceiling: starting scan");
  const agents = await listAgentUsers();
  const proposalIds: string[] = [];
  let failed = 0;

  for (const agent of agents) {
    try {
      const filed = await recommendRaiseCeilingForAgent(agent);
      proposalIds.push(...filed);
    } catch (err) {
      failed += 1;
      logger.error(
        { err, agentId: agent.id },
        "recommend-raise-ceiling: failed for agent, skipping"
      );
    }
  }

  logger.info(
    { agents: agents.length, failed, proposalsFiled: proposalIds.length },
    "recommend-raise-ceiling: scan complete"
  );
  return { proposalsFiled: proposalIds.length, proposalIds };
}
