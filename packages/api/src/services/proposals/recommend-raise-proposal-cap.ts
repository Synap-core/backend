/**
 * Governance RAISE-PROPOSAL-CAP recommender — the `pending_proposal_cap` twin of
 * `recommend-raise-ceiling.ts`. Where raise-ceiling watches DAILY AUTO-WRITE
 * VOLUME against the `daily_write_count` ceiling, this watches an agent's
 * CURRENT PENDING-PROPOSAL count against its resolved `pending_proposal_cap` —
 * the F2 floor's limit. An agent at/over its pending cap is BLOCKED (its next
 * propose is refused), so the fix is to raise the cap — a human decision, filed
 * as a `settings.update` proposal through the UNIFIED settings door (B5), not
 * the bespoke `governance.raise_ceiling` type.
 *
 * NEVER silent + never a direct write: the ONLY side effect is a PENDING
 * `settings.update` proposal via the one door `insertPendingProposal` + its
 * pod-wide notification. Approving it inserts a `governance_ceilings` row
 * (axis `pending_proposal_cap`) via B5.
 *
 * SEAM MIRRORED FROM recommend-raise-ceiling.ts:
 *   - agent enumeration (`listAgentUsers`) + resilient per-agent loop.
 *   - one-door `insertPendingProposal` + `notifyProposalCreatedOrdered` + emit.
 *   - per-agent dedupe against an open proposal + a covering higher ceiling.
 *
 * SIGNAL differs (concurrency, not volume): the counter is
 * `countPendingAgentProposals` (the SAME predicate the cap enforces), the limit
 * is `agentProposalCap` (explicit ceiling, else trust-scaled default), and the
 * qualification is the agent being AT/OVER the cap RIGHT NOW — the exact state
 * that blocks it — rather than N-of-M days of volume. Dedupe keeps a rejected
 * raise from re-filing only while its proposal is PENDING; a rejection re-arms
 * the scan (same as raise-ceiling — no reject-cooldown).
 */

import {
  db,
  and,
  or,
  eq,
  isNull,
  gt,
  users,
  proposals,
  governanceCeilings,
  insertPendingProposal,
  ProposalStatus,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import {
  countPendingAgentProposals,
  agentProposalCap,
} from "../../utils/permission-check.js";
import { notifyProposalCreatedOrdered } from "../../notifications/notify-proposal-created-ordered.js";

const logger = createLogger({
  module: "governance-recommend-raise-proposal-cap",
});

/** The proposed new cap = ceil(currentCap * RAISE_FACTOR) (mirrors raise-ceiling). */
const RAISE_FACTOR = 1.5;

interface AgentRow {
  id: string;
  createdByUserId: string | null;
}

async function listAgentUsers(): Promise<AgentRow[]> {
  return db
    .select({ id: users.id, createdByUserId: users.createdByUserId })
    .from(users)
    .where(eq(users.userType, "agent"));
}

/**
 * Any PENDING `settings.update` already open for this agent on the
 * `pending_proposal_cap` axis — the settings-door twin of raise-ceiling's
 * `hasPendingRaiseProposal`.
 */
async function hasPendingSettingsRaise(agentId: string): Promise<boolean> {
  const rows = await db
    .select({ data: proposals.data })
    .from(proposals)
    .where(
      and(
        eq(proposals.proposalType, "settings.update"),
        eq(proposals.status, ProposalStatus.PENDING)
      )
    );
  return rows.some((r) => {
    const data = r.data as Record<string, unknown> | null;
    return (
      data?.store === "governance_ceilings" &&
      data?.axis === "pending_proposal_cap" &&
      data?.agentUserId === agentId
    );
  });
}

/**
 * A covering higher ceiling already exists — an ACTIVE agent-scoped
 * `pending_proposal_cap` ceiling for this agent whose limit already
 * meets/exceeds what we would propose. Mirror of raise-ceiling's
 * `hasCoveringHigherCeiling`, axis-swapped.
 */
async function hasCoveringCapCeiling(
  agentId: string,
  proposedLimit: number
): Promise<boolean> {
  const rows = (await db
    .select({ limitValue: governanceCeilings.limitValue })
    .from(governanceCeilings)
    .where(
      and(
        eq(governanceCeilings.axis, "pending_proposal_cap"),
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

/** Scan ONE agent; file a `settings.update` cap-raise if it is blocked. */
async function recommendRaiseProposalCapForAgent(
  agent: AgentRow
): Promise<string[]> {
  if (!agent.createdByUserId) return [];

  // The SAME predicate + limit the cap enforces: blocked iff
  // pendingCount >= cap. No lookback window — this is a concurrency signal.
  const [pendingCount, cap] = await Promise.all([
    countPendingAgentProposals(agent.id),
    agentProposalCap(agent.id),
  ]);
  if (pendingCount < cap) return [];

  const proposedLimit = Math.ceil(cap * RAISE_FACTOR);
  // Guard the always-raise invariant: never file a no-op or a downgrade.
  if (proposedLimit <= cap) return [];

  if (await hasPendingSettingsRaise(agent.id)) return [];
  if (await hasCoveringCapCeiling(agent.id, proposedLimit)) return [];

  const data = {
    store: "governance_ceilings",
    op: "set",
    axis: "pending_proposal_cap",
    limitValue: proposedLimit,
    agentUserId: agent.id,
    currentLimit: cap,
    pendingCount,
  };

  const { proposal, deduped } = await insertPendingProposal({
    workspaceId: null,
    targetType: "settings",
    targetId: agent.id,
    proposalType: "settings.update",
    data: data as unknown as Record<string, unknown>,
    createdBy: agent.createdByUserId,
    proposedByUserId: null,
    // OWNER FLOOR (0248): the human who owns this agent decides its ceiling.
    subjectUserId: agent.createdByUserId,
  });

  // TELL A HUMAN — insertPendingProposal is durable but fires no notification;
  // without this the proposal is invisible. Ordered fan-out-then-emit.
  await notifyProposalCreatedOrdered({
    podWide: deduped
      ? null
      : {
          proposalId: proposal.id,
          proposalType: "settings.update",
          description: `Raise proposal cap ${cap}→${proposedLimit} (${pendingCount} pending, blocked)`,
          agentUserId: agent.id,
        },
    sideEffect: {
      subjectId: proposal.id,
      userId: agent.createdByUserId,
      data: {
        proposalStatus: "created",
        targetType: "settings",
        changeType: "settings.update",
      },
    },
    onEmitError: (err) =>
      logger.warn(
        { err, proposalId: proposal.id, agentId: agent.id },
        "recommend-raise-proposal-cap: emitSideEffects failed (non-fatal)"
      ),
  });

  logger.info(
    { agentId: agent.id, cap, proposedLimit, pendingCount },
    "recommend-raise-proposal-cap: filed settings.update cap-raise"
  );

  return [proposal.id];
}

/**
 * Scan EVERY agent-user and file cap-raise proposals. Resilient per-agent
 * (mirror recommendRaiseCeilingForAllAgents). Returns the ids of every filed
 * `settings.update` proposal.
 */
export async function recommendRaiseProposalCapForAllAgents(): Promise<{
  proposalsFiled: number;
  proposalIds: string[];
}> {
  logger.info("recommend-raise-proposal-cap: starting scan");
  const agents = await listAgentUsers();
  const proposalIds: string[] = [];
  let failed = 0;

  for (const agent of agents) {
    try {
      const filed = await recommendRaiseProposalCapForAgent(agent);
      proposalIds.push(...filed);
    } catch (err) {
      failed += 1;
      logger.error(
        { err, agentId: agent.id },
        "recommend-raise-proposal-cap: failed for agent, skipping"
      );
    }
  }

  logger.info(
    { agents: agents.length, failed, proposalsFiled: proposalIds.length },
    "recommend-raise-proposal-cap: scan complete"
  );
  return { proposalsFiled: proposalIds.length, proposalIds };
}
