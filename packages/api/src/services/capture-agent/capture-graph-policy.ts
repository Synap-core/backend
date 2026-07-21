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
  /**
   * The write subject's profile slug — populated for `entity.create` ops so the
   * governance-by-kind rung (a `user_observation` INFERENCE must propose, never
   * auto-apply) fires PER OP. Undefined for facet/relation ops (governed by
   * action alone). Without this, the deduped `entity.create` key dropped the
   * slug and an unvalidated user_observation slipped through auto-apply.
   */
  subjectProfileSlug?: string;
  /**
   * `uo_validated` read from a `user_observation` op's properties: `true` =
   * user-stated (auto-approve), false/undefined = inference (propose). Only
   * meaningful when `subjectProfileSlug === "user_observation"`.
   */
  subjectUoValidated?: boolean;
}

/**
 * The DISTINCT policy keys a capture graph exercises. Deduped so the caller runs
 * the evaluator at most once per distinct key — now keyed by
 * `(subjectType, action, profileSlug, uoValidated)` so two `entity.create` ops
 * of DIFFERENT kinds (e.g. a `note` and an unvalidated `user_observation`) are
 * evaluated separately, letting governance-by-kind fire for the one that needs it.
 */
export function captureGraphEventKeys(
  operations: CompositeProposalOperation[]
): CaptureGraphEventKey[] {
  const keys = new Map<string, CaptureGraphEventKey>();
  const add = (key: CaptureGraphEventKey) => {
    const mapKey = `${key.subjectType}.${key.action}::${key.subjectProfileSlug ?? ""}::${key.subjectUoValidated ?? ""}`;
    if (!keys.has(mapKey)) keys.set(mapKey, key);
  };
  for (const op of operations) {
    if (op.op === "create_entity") {
      const props = op.properties as Record<string, unknown> | undefined;
      const subjectUoValidated =
        typeof props?.uo_validated === "boolean"
          ? props.uo_validated
          : undefined;
      add({
        subjectType: "entity",
        action: "create",
        subjectProfileSlug: op.profileSlug,
        ...(subjectUoValidated !== undefined ? { subjectUoValidated } : {}),
      });
      if (op.facets && op.facets.length > 0)
        add({ subjectType: "facet", action: "attach" });
    } else if (op.op === "create_relation") {
      add({ subjectType: "relation", action: "create" });
    }
  }
  return [...keys.values()];
}
