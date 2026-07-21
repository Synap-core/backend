/**
 * capture-graph-policy — the PURE half of agent-mode capture governance.
 *
 * A composite capture graph is atomic (all-or-nothing on approve/materialize),
 * so its auto-apply decision must be all-or-nothing too: it may auto-apply ONLY
 * if EVERY op in the graph is auto-approvable. This module turns a graph's
 * operations into the DISTINCT `(subjectType, action)` event keys the ONE agent
 * policy evaluator (`decideAgentPolicy`, via `resolveAgentGovernanceDecision`)
 * scores — it never re-implements the policy itself.
 *
 * The mapping mirrors the composite materializer's op semantics:
 *   - create_entity            → entity.create
 *   - create_entity w/ facets  → additionally facet.attach
 *   - create_relation          → relation.create
 * All three are in DEFAULT_AUTO_APPROVE, so an ordinary capture graph
 * auto-applies unless a workspace/agent override, writesRequireProposal, or a
 * CBAC allowlist withholds one of them — in which case the WHOLE graph proposes.
 */

import type { CompositeProposalOperation } from "@synap-core/types/proposals";

export interface CaptureGraphEventKey {
  subjectType: string;
  action: string;
}

/**
 * The DISTINCT `(subjectType, action)` policy keys a capture graph exercises.
 * Deduped so the caller runs the evaluator at most once per distinct key.
 */
export function captureGraphEventKeys(
  operations: CompositeProposalOperation[]
): CaptureGraphEventKey[] {
  const keys = new Map<string, CaptureGraphEventKey>();
  const add = (subjectType: string, action: string) =>
    keys.set(`${subjectType}.${action}`, { subjectType, action });
  for (const op of operations) {
    if (op.op === "create_entity") {
      add("entity", "create");
      if (op.facets && op.facets.length > 0) add("facet", "attach");
    } else if (op.op === "create_relation") {
      add("relation", "create");
    }
  }
  return [...keys.values()];
}
