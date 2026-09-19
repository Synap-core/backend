/**
 * Applying the IS workspace-decision door's answer to a capture's structure
 * result (capture.structure step 1a′). Pure — no DB, no IO.
 *
 * The IS decides WHO answers `/api/workspace-tiebreak`: its typed decision
 * model (JEV, `decider: "jev"`, with a probability per candidate) or its LLM
 * cascade (`decider: "llm"`). Only a decision-model answer outranks the
 * structurer's catalog-wide pick: it is a dedicated, calibrated Choice over
 * the same candidates, where the structurer's pick is a side-output of
 * extraction. An LLM answer never replaces another LLM answer here.
 */

import type { WorkspaceTiebreakResult } from "@synap/intelligence-client";
import type { WorkspaceDecisionRecord } from "./ai-events.js";

export interface WorkspacePickFields {
  targetWorkspaceId?: string | null;
  targetWorkspaceName?: string | null;
  targetWorkspaceReason?: string | null;
  targetWorkspaceConfidence?: number | null;
}

/** The recordable distribution behind a door answer (none for deterministic answers). */
export function toWorkspaceDecisionRecord(
  tb: WorkspaceTiebreakResult,
  candidates: ReadonlyArray<{ id: string; name: string }>
): WorkspaceDecisionRecord | undefined {
  if (!tb.decider) return undefined;
  return {
    decider: tb.decider,
    ...(tb.model ? { model: tb.model } : {}),
    ...(tb.probabilities ? { probabilities: tb.probabilities } : {}),
    candidates: candidates.map((c) => ({ id: c.id, name: c.name })),
  };
}

/**
 * Overwrite `target`'s workspace pick with a decision-model answer. A pick
 * lands with the model's confidence; an abstain ("none of these fits") keeps
 * the capture in the ambient workspace with no confidence — the same honest
 * outcome as a tie-break abstain. Returns the record to carry to
 * `capture.execute`, or `undefined` (target untouched) when the answer did not
 * come from the decision model.
 */
export function applyDecisionModelPick(
  target: WorkspacePickFields,
  decision: WorkspaceTiebreakResult | null | undefined,
  candidates: ReadonlyArray<{ id: string; name: string }>,
  ambientWorkspaceId: string | null | undefined
): WorkspaceDecisionRecord | undefined {
  if (decision?.decider !== "jev") return undefined;
  const nameOf = (id: string | null | undefined) =>
    (id && candidates.find((c) => c.id === id)?.name) ?? null;
  const picked =
    decision.workspaceId &&
    candidates.some((c) => c.id === decision.workspaceId)
      ? decision.workspaceId
      : null;
  if (picked) {
    target.targetWorkspaceId = picked;
    target.targetWorkspaceName = nameOf(picked);
    target.targetWorkspaceConfidence = decision.confidence;
  } else {
    target.targetWorkspaceId = ambientWorkspaceId ?? null;
    target.targetWorkspaceName = nameOf(ambientWorkspaceId);
    target.targetWorkspaceConfidence = null;
  }
  target.targetWorkspaceReason = decision.reason;
  return toWorkspaceDecisionRecord(decision, candidates);
}
