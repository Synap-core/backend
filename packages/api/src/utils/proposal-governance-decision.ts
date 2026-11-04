/**
 * WHY A PROPOSED WRITE ASKED — which rule, and which side of the host step.
 *
 * An agent on a computer is judged twice, as itself and as its computer, and
 * the stricter verdict wins (`resolveAgentGovernanceDecision`). Before this, a
 * proposal could only say "One of your rules says to ask you first.": not
 * which rule, and not that it was the COMPUTER's rule while the agent's own
 * setting would have let it act (finding 168956d8).
 *
 * Stored at the TOP LEVEL of `proposals.data` as `_governanceDecision`, beside
 * the request envelope (like `expectedLabel`), never inside the payload the
 * executors parse; a `_` key is plumbing to every diff reader
 * (`changes.ts`). The auto-approved receipt keeps its own `_autoApprove`
 * marker: that one means "a rule let it act", which several readers count
 * (`recommend-tighten.ts`, `next-rung.ts`), so a proposal never writes it.
 *
 * ONE writer (`permission-check.ts`, the agent branch) and ONE reader
 * (`display.ts`, through {@link askedByFor}), both through this module.
 */
import type { AgentGovernanceResolution } from "@synap/database/agent-governance";
import { isUuid } from "@synap-core/types/property-render";

export const GOVERNANCE_DECISION_KEY = "_governanceDecision";

export interface StoredGovernanceDecision {
  /** Which pass decided: the agent itself, or the computer it runs on. */
  principal: "agent" | "computer";
  /** The computer's user id, when it decided. */
  computerUserId?: string;
  /** The `propose` rule (rung 2.8) that made it ask, when one did. */
  governanceRuleId?: string;
}

/**
 * The marker a proposed write stores, or undefined when there is nothing to
 * name (no rule decided, and the agent runs on no computer that did).
 */
export function storedGovernanceDecisionOf(
  gov: AgentGovernanceResolution
): StoredGovernanceDecision | undefined {
  if (gov.decision !== "propose") return undefined;
  const computer =
    gov.decidedBy?.principal === "computer"
      ? gov.decidedBy.computerUserId
      : undefined;
  if (!computer && !gov.governanceRuleId) return undefined;
  return {
    principal: computer ? "computer" : "agent",
    ...(computer ? { computerUserId: computer } : {}),
    ...(gov.governanceRuleId ? { governanceRuleId: gov.governanceRuleId } : {}),
  };
}

/** The stored marker, read defensively: anything malformed reads as absent. */
export function readStoredGovernanceDecision(
  data: unknown
): StoredGovernanceDecision | undefined {
  const raw =
    data && typeof data === "object"
      ? (data as Record<string, unknown>)[GOVERNANCE_DECISION_KEY]
      : undefined;
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (r.principal !== "agent" && r.principal !== "computer") return undefined;
  const computerUserId =
    typeof r.computerUserId === "string" && isUuid(r.computerUserId)
      ? r.computerUserId
      : undefined;
  if (r.principal === "computer" && !computerUserId) return undefined;
  const governanceRuleId =
    typeof r.governanceRuleId === "string" && isUuid(r.governanceRuleId)
      ? r.governanceRuleId
      : undefined;
  return {
    principal: r.principal,
    ...(computerUserId ? { computerUserId } : {}),
    ...(governanceRuleId ? { governanceRuleId } : {}),
  };
}

/**
 * Why an agent's write asked, as the review row serves it (`askedBy`): which
 * pass decided, the computer NAMED (so a card can link to it), and the rule
 * only when the viewer may read it. Names only, never a bare id.
 */
export interface AskedBy<Rule> {
  principal: "agent" | "computer";
  /** The computer that asked, when `principal` is `computer` and it still exists. */
  computer?: { id: string; name: string };
  /** The `propose` rule that made it ask, when the viewer may read it. */
  governanceRule?: Rule;
}

/**
 * The stored marker → the wire shape, from the page's batched reads: the
 * computers it named (`loadMachineNames`) and the rules the viewer may read
 * (the receipts' floored batch). A computer or rule absent from them is left
 * out, never shown as an id.
 */
export function askedByFor<Rule>(
  stored: StoredGovernanceDecision | undefined,
  machineNames: ReadonlyMap<string, { id: string; name: string }>,
  rules: ReadonlyMap<string, Rule>
): AskedBy<Rule> | undefined {
  if (!stored) return undefined;
  const computer =
    stored.principal === "computer" && stored.computerUserId
      ? machineNames.get(stored.computerUserId)
      : undefined;
  const rule = stored.governanceRuleId
    ? rules.get(stored.governanceRuleId)
    : undefined;
  return {
    principal: stored.principal,
    ...(computer ? { computer: { id: computer.id, name: computer.name } } : {}),
    ...(rule ? { governanceRule: rule } : {}),
  };
}
