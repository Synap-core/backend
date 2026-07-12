/**
 * Name→id reconciliation for the AI's workspace pick.
 *
 * The IS emits `targetWorkspaceName` (the workspace it reasoned about) alongside
 * `targetWorkspaceId` (a UUID it copies from the candidate list — UNRELIABLY;
 * the model routinely transposes UUIDs). The NAME is the authoritative signal:
 * resolve it back to the real id from the caller-built candidate list, so a
 * copy-error id gets corrected. Pure + side-effect-free so it is unit-testable —
 * this path never actually fired before Wave 2 (the IS dropped
 * `targetWorkspaceName` end-to-end), so its behavior is locked by tests now that
 * it receives real data for the first time.
 */

import {
  BELOW_GATE_CONFIDENCE,
  EXACT_MATCH_CONFIDENCE,
  FUZZY_MATCH_CONFIDENCE,
} from "./ai-events.js";

export interface WorkspaceNameReconcileResult {
  /** The resolved workspace id (authoritative over the LLM's raw id). */
  resolvedWorkspaceId: string;
  /**
   * The confidence to apply WHEN the model didn't self-report one — derived from
   * the match strength so the auto-apply gate works for BYOA agents that name a
   * workspace but omit a confidence. Callers must NOT overwrite a reported
   * confidence with this.
   */
  derivedConfidence: number;
  matchKind: "exact" | "fuzzy-single" | "fuzzy-ambiguous";
}

/**
 * Resolve a picked workspace NAME to a real id from `availableWorkspaces`.
 * Returns `null` when there is nothing to reconcile (no/blank name, empty list,
 * or no name match) — the caller then leaves the LLM's raw id untouched.
 */
export function reconcileWorkspaceByName(
  pickedName: string | null | undefined,
  availableWorkspaces: Array<{ id: string; name: string }>
): WorkspaceNameReconcileResult | null {
  const norm = (s: string) => s.toLowerCase().trim();
  const wanted = pickedName ? norm(pickedName) : "";
  // Guard the empty/whitespace name: `"".includes("")` is TRUE, so a blank pick
  // (or a workspace with a blank name) would substring-"match" every workspace
  // and file into an arbitrary one.
  if (wanted.length === 0 || availableWorkspaces.length === 0) return null;

  const exactMatch = availableWorkspaces.find((w) => norm(w.name) === wanted);
  // ALL fuzzy matches (not just the first) — so we can tell an unambiguous
  // single match from an arbitrary pick among several.
  const fuzzyMatches = exactMatch
    ? []
    : availableWorkspaces.filter(
        (w) => norm(w.name).includes(wanted) || wanted.includes(norm(w.name))
      );
  const match = exactMatch ?? fuzzyMatches[0];
  if (!match) return null;

  if (exactMatch) {
    return {
      resolvedWorkspaceId: match.id,
      derivedConfidence: EXACT_MATCH_CONFIDENCE,
      matchKind: "exact",
    };
  }
  if (fuzzyMatches.length === 1) {
    return {
      resolvedWorkspaceId: match.id,
      derivedConfidence: FUZZY_MATCH_CONFIDENCE,
      matchKind: "fuzzy-single",
    };
  }
  // AMBIGUOUS — the name substring-matched MORE THAN ONE workspace, so `match` is
  // an arbitrary pick. Below-gate confidence so it degrades to ask/no-move
  // instead of auto-moving to a coin-flip workspace.
  return {
    resolvedWorkspaceId: match.id,
    derivedConfidence: BELOW_GATE_CONFIDENCE,
    matchKind: "fuzzy-ambiguous",
  };
}
