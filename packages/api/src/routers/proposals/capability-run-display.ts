/**
 * READ-TIME re-derivation for capability-run proposals filed BEFORE the pod
 * titled core entity-verb runs as the action on their object.
 *
 * A stored summary is durable: the nine GRP retirements filed 2026-09-28 read
 * "Run entity.delete" and would for the rest of their life. Same pattern FL1
 * used for legacy "Run Playbook" rows: ONLY a summary that is exactly the
 * generated tool-id shape (`isGeneratedCapabilityRunSummary`) is replaced —
 * anything a person or agent wrote is kept byte for byte.
 *
 * The name comes from the display batch's entity map, which is already floored
 * by the entity `VisibilityRule` and then by the proposal's workspace lens (the
 * caller's `lookup`), so this adds no read and no new name path.
 */
import type { UpdateRequest } from "@synap-core/types";
import {
  capabilityRunReasoning,
  describeEntityVerbRun,
  entityVerbRunTarget,
  isGeneratedCapabilityRunSummary,
  type EntityVerbRunSubject,
} from "@synap-core/types/proposals/capability-run";
import { CAPABILITY_RUN_PROPOSAL_TYPE } from "../../services/proposals/proposal-class.js";

type RowLike = { proposalType: string; data: unknown };

function runPayload(
  row: RowLike
): { verbId: string | null; parameters: Record<string, unknown> } | null {
  if (row.proposalType !== CAPABILITY_RUN_PROPOSAL_TYPE) return null;
  const data =
    row.data && typeof row.data === "object"
      ? (row.data as Record<string, unknown>)
      : {};
  const parameters =
    data.parameters && typeof data.parameters === "object"
      ? (data.parameters as Record<string, unknown>)
      : {};
  return {
    verbId: typeof data.verbId === "string" ? data.verbId : null,
    parameters,
  };
}

/** The entity a capability-run row acts on — joined into the floored entity batch. */
export function capabilityRunEntityId(row: RowLike): string | undefined {
  const run = runPayload(row);
  return run
    ? entityVerbRunTarget(run.verbId, run.parameters)?.entityId
    : undefined;
}

/**
 * The request with a legacy generated summary re-derived and the run's reason
 * hoisted. Any other row is returned unchanged (same object).
 */
export function withEntityVerbRunTitle<
  R extends Pick<UpdateRequest, "summary" | "reasoning">,
>(
  row: RowLike,
  request: R,
  lookup: (entityId: string) => EntityVerbRunSubject | undefined
): R {
  const run = runPayload(row);
  if (!run) return request;
  const target = entityVerbRunTarget(run.verbId, run.parameters);
  if (!target) return request;
  const reasoning = request.reasoning ?? capabilityRunReasoning(run.parameters);
  const summary = isGeneratedCapabilityRunSummary(request.summary, run.verbId)
    ? describeEntityVerbRun(target.action, lookup(target.entityId))
    : request.summary;
  if (summary === request.summary && reasoning === request.reasoning) {
    return request;
  }
  return { ...request, summary, reasoning };
}
