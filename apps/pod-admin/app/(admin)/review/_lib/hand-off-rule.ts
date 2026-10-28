/**
 * "Always allow hand-offs for this agent" (founder B-3, 27 Oct 2026) — ONE
 * `governance_rules` row: this agent may hand a session to an agent
 * (`focus_session.assign_agent`) without asking, pod-wide. Written only
 * through `governanceRules.create`, the human door (`credentialProcedure`:
 * a Kratos or fresh device session — an agent key cannot reach it), and
 * revoked through `governanceRules.revoke`.
 *
 * The rule is the "this agent" granularity `deriveGovernanceGrantOptions`
 * (operator mode) writes for a hand-off — the SAME payload the proposal
 * page's "Approve & always…" offers; `hand-off-rule.test.ts` pins that the
 * two agree. Pure.
 */
import type { GovernanceRuleDraft } from "@synap-core/types";

/** The action a hand-off is filed under (`focus_session/assign_agent`). */
export const HAND_OFF_ACTION = "focus_session.assign_agent";

export function handOffRuleFor(
  agentUserId: string,
  sourceProposalId?: string
): Omit<GovernanceRuleDraft, "sourceProposalId"> & {
  sourceProposalId?: string;
} {
  return {
    principalKind: "agent",
    agentUserId,
    scopeKind: "pod",
    targetKind: "action",
    targetPattern: HAND_OFF_ACTION,
    verdict: "auto",
    ...(sourceProposalId ? { sourceProposalId } : {}),
  };
}

/** The rule fields a list row carries (`governanceRules.list`). */
export interface RuleRow {
  id: string;
  principalKind: string;
  agentUserId: string | null;
  agentLabel?: string | null;
  scopeKind: string;
  targetKind: string;
  targetPattern: string;
  verdict: string;
}

/** Is this live rule an "always allow hand-offs" for one agent? */
export function isHandOffRule(rule: RuleRow): boolean {
  return (
    rule.principalKind === "agent" &&
    !!rule.agentUserId &&
    rule.targetKind === "action" &&
    rule.targetPattern === HAND_OFF_ACTION &&
    rule.verdict === "auto"
  );
}
