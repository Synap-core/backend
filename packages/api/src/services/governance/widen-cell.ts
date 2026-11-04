/**
 * WIDEN a matrix cell (agent routing W3) — the agent × work matrix's one
 * primary action, `governanceRules.widenCell`.
 *
 * A cell has no card to climb from, so this drafts the SAME narrowest rule the
 * trust ladder writes (`nextRungRuleDraft`: agent × space × exact action ×
 * kind, `auto`) and files it through the SAME back half (`fileRuleGrant`):
 * a rule now, or a pending `settings.update` for the agent's owner. WHO grants
 * is the router's call (founder decision 8, 2026-10-14: an admin widening
 * another user's agent files a proposal to its owner, never a direct rule).
 *
 * Refused with the ladder's typed `NO_NEXT_RUNG` when nothing may be widened:
 * a floor, a write that cannot be undone, or an answer a rule cannot change —
 * asked of the ONE resolver now, never trusted from the client's cell.
 */

import { TRPCError } from "@trpc/server";
import { db, and, eq } from "@synap/database";
import { users } from "@synap/database/schema";
import {
  dryRunAgentGovernanceDecision,
  seedHostFor,
} from "@synap/database/agent-governance";
import {
  isReversibleWrite,
  nonWidenableFloorFor,
} from "@synap/governance-policy";
import { nextRungRuleDraft } from "@synap-core/types/trust-ladder";
import {
  canWidenAnswer,
  matrixVerdictOf,
} from "@synap-core/types/agent-matrix";
import { noNextRung, type RuleGrantDraft } from "../proposals/next-rung.js";

export interface MatrixCellProbe {
  agentUserId: string;
  /** `null` = a pod-wide write (no space). */
  workspaceId: string | null;
  /** The governance event key (`entity.update`). */
  action: string;
  profileSlug: string | null;
}

/** The agent's owner (`null` = nobody owns it), or NOT_FOUND. */
export async function loadAgentOwner(
  agentUserId: string
): Promise<string | null> {
  const [agent] = await db
    .select({ createdByUserId: users.createdByUserId })
    .from(users)
    .where(and(eq(users.id, agentUserId), eq(users.userType, "agent")))
    .limit(1);
  if (!agent) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found" });
  }
  return agent.createdByUserId ?? null;
}

/** The narrowest rule that would widen this probe, or a typed refusal. */
export async function draftMatrixWiden(
  probe: MatrixCellProbe,
  ownerUserId: string | null
): Promise<RuleGrantDraft> {
  if (nonWidenableFloorFor(probe.action)) {
    throw noNextRung("a floor decides this write; no rule can widen it.");
  }
  if (!isReversibleWrite(probe.action)) {
    throw noNextRung("this write cannot be undone, so it always asks.");
  }
  const now = await dryRunAgentGovernanceDecision({
    db,
    userId: ownerUserId ?? probe.agentUserId,
    agentUserId: probe.agentUserId,
    workspaceId: probe.workspaceId,
    action: probe.action,
    profileSlug: probe.profileSlug,
    door: "chat",
  });
  if (
    !canWidenAnswer(
      { verdict: matrixVerdictOf(now.outcome), rung: now.rung },
      probe
    )
  ) {
    throw noNextRung(
      "nothing to widen here (it already acts, is off, or a rule cannot reach what decides it)."
    );
  }
  if (await computerAsksFor(probe)) {
    throw noNextRung(
      "its computer asks first for this write, and a rule for the agent does not reach it; change what agents on that computer may do on the computer's page."
    );
  }
  const { sourceProposalId: _lineage, ...rule } = nextRungRuleDraft({
    proposalId: "",
    agentUserId: probe.agentUserId,
    workspaceId: probe.workspaceId,
    eventKey: probe.action,
    profileSlug: probe.profileSlug,
  });
  return rule;
}

/**
 * Does the agent's computer ask for this write, where a rule widened for the
 * agent alone cannot reach it? The host step keeps the stricter of the agent
 * and its computer, and a rule for the agent is copied onto its computer only
 * when the computer belongs to the agent (`seedHostFor`). On a person's own or
 * a shared computer, the computer's OWN answer (the one resolver, asked as the
 * computer) is then the ceiling: when it is not `auto`, widening the agent
 * changes nothing (plan 07ecf0be item 3).
 */
export async function computerAsksFor(
  probe: MatrixCellProbe
): Promise<boolean> {
  const [agent] = await db
    .select({ hostUserId: users.hostUserId })
    .from(users)
    .where(eq(users.id, probe.agentUserId))
    .limit(1);
  const hostUserId = agent?.hostUserId;
  if (!hostUserId || hostUserId === probe.agentUserId) return false;
  if (await seedHostFor(db, probe.agentUserId)) return false;
  const [host] = await db
    .select({ createdByUserId: users.createdByUserId })
    .from(users)
    .where(eq(users.id, hostUserId))
    .limit(1);
  if (!host) return false;
  const asComputer = await dryRunAgentGovernanceDecision({
    db,
    userId: host.createdByUserId ?? hostUserId,
    agentUserId: hostUserId,
    workspaceId: probe.workspaceId,
    action: probe.action,
    profileSlug: probe.profileSlug,
    door: "chat",
  });
  return asComputer.outcome !== "auto";
}
