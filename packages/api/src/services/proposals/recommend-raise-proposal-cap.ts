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
  /** `users.name` — carried so the REVIEW CARD can name the agent asking. */
  name: string | null;
}

async function listAgentUsers(): Promise<AgentRow[]> {
  return db
    .select({
      id: users.id,
      createdByUserId: users.createdByUserId,
      name: users.name,
    })
    .from(users)
    .where(eq(users.userType, "agent"));
}

/**
 * The PENDING `settings.update` already open for this agent on the
 * `pending_proposal_cap` axis — the settings-door twin of raise-ceiling's
 * `hasPendingRaiseProposal`.
 *
 * Returns the proposal's ID (not a boolean) because the refusal path needs to
 * POINT AT the open request: a capped agent that keeps writing must be handed
 * the SAME review link every time, never a second request and never a dead end.
 * This is the ONE dedup rule — the cron scan and the gate refusal both read it.
 */
async function findPendingSettingsRaise(
  agentId: string
): Promise<string | null> {
  const rows = await db
    .select({ id: proposals.id, data: proposals.data })
    .from(proposals)
    .where(
      and(
        eq(proposals.proposalType, "settings.update"),
        eq(proposals.status, ProposalStatus.PENDING)
      )
    );
  const hit = rows.find((r) => {
    const data = r.data as Record<string, unknown> | null;
    return (
      data?.store === "governance_ceilings" &&
      data?.axis === "pending_proposal_cap" &&
      data?.agentUserId === agentId
    );
  });
  return hit?.id ?? null;
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

/** The open cap-raise request an agent's owner must review. */
export interface RaiseProposalCapRequest {
  /** The OPEN `settings.update` cap-raise proposal for this agent. */
  proposalId: string;
  /**
   * True when an open request ALREADY existed and was returned instead of
   * filing a second one. A flooding agent gets this on every refusal after the
   * first — same id, same link, one row in the human's queue.
   */
  deduped: boolean;
  /** The cap in force when the request was resolved. */
  cap: number;
  /** The cap the request asks the owner to approve. */
  proposedLimit: number;
}

/** Scan ONE agent; file a `settings.update` cap-raise if it is blocked. */
async function requestRaiseProposalCapForAgentRow(
  agent: AgentRow,
  known?: { pendingCount?: number; cap?: number }
): Promise<RaiseProposalCapRequest | null> {
  if (!agent.createdByUserId) return null;

  // The SAME predicate + limit the cap enforces: blocked iff
  // pendingCount >= cap. No lookback window — this is a concurrency signal.
  // The GATE has already computed both when it refused a write, and passes
  // them in: re-querying could read a different number than the one the
  // refusal message quotes, so the request and the refusal would disagree.
  const [pendingCount, cap] = await Promise.all([
    known?.pendingCount ?? countPendingAgentProposals(agent.id),
    known?.cap ?? agentProposalCap(agent.id),
  ]);
  if (pendingCount < cap) return null;

  const proposedLimit = Math.ceil(cap * RAISE_FACTOR);
  // Guard the always-raise invariant: never file a no-op or a downgrade.
  if (proposedLimit <= cap) return null;

  const openRequestId = await findPendingSettingsRaise(agent.id);
  if (openRequestId) {
    return { proposalId: openRequestId, deduped: true, cap, proposedLimit };
  }
  if (await hasCoveringCapCeiling(agent.id, proposedLimit)) return null;

  // `store`/`op`/`axis`/`limitValue`/`agentUserId` are what the APPLIER reads
  // (`applyGovConfigChange`). `agentName`/`currentLimit`/`pendingCount` are
  // DISPLAY-ONLY evidence the applier ignores: they exist so the review card can
  // say WHICH agent is asking, what its limit is today, and why it ran out —
  // without the reviewer having to resolve a uuid. Carried by the PRODUCER
  // rather than re-derived in the UI because the UI has no user lookup, and
  // because these must be the numbers this refusal actually quoted.
  const data = {
    store: "governance_ceilings",
    op: "set",
    axis: "pending_proposal_cap",
    limitValue: proposedLimit,
    agentUserId: agent.id,
    agentName: agent.name,
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
          description: `${agent.name ?? "An agent"} is blocked at its ${cap}-proposal limit (${pendingCount} pending) — raise it to ${proposedLimit}?`,
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

  return { proposalId: proposal.id, deduped, cap, proposedLimit };
}

/**
 * THE REFUSAL'S DOOR — resolve (filing if needed) the ONE open cap-raise
 * request for a single agent, by id.
 *
 * Called from the F2 cap refusal in `checkPermissionOrPropose` so that a write
 * blocked by the cap does not merely name a remedy in prose: it FILES the
 * remedy and hands back its review link. Deliberately the SAME function body
 * the daily cron scan uses (one filer, one dedup rule) — only the entry shape
 * differs: an agent id the gate already has, plus the pendingCount/cap it
 * already resolved.
 *
 * Returns `null` when nothing is owed (agent row gone, no owner, not actually
 * at its cap, or a ceiling already covers the raise) — the caller then keeps
 * its plain refusal. It NEVER writes anything but a PENDING proposal: raising
 * the cap stays a human decision.
 */
export async function requestRaiseProposalCap(
  agentUserId: string,
  known?: { pendingCount?: number; cap?: number }
): Promise<RaiseProposalCapRequest | null> {
  const [agent] = await db
    .select({
      id: users.id,
      createdByUserId: users.createdByUserId,
      name: users.name,
    })
    .from(users)
    .where(eq(users.id, agentUserId))
    .limit(1);
  if (!agent) return null;
  return requestRaiseProposalCapForAgentRow(agent, known);
}

/**
 * READ-ONLY twin of the dedup lookup — "is a cap-raise already waiting for this
 * agent's owner?", with no chance of filing one.
 *
 * Exported so the `synap_governance` introspection tool can show the SAME link
 * the refusal hands back without becoming a write door. It is literally the
 * dedup predicate, not a second copy: a divergence here would show an agent a
 * link to a request the filer would not consider open.
 */
export async function findOpenRaiseProposalCapRequest(
  agentUserId: string
): Promise<string | null> {
  return findPendingSettingsRaise(agentUserId);
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
      const filed = await requestRaiseProposalCapForAgentRow(agent);
      // Only a NEWLY filed row counts as this scan's output — a dedup hit is
      // an existing request the previous scan (or a gate refusal) already
      // filed, exactly as the old boolean short-circuit behaved.
      if (filed && !filed.deduped) proposalIds.push(filed.proposalId);
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
