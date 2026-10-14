/**
 * plan — what a template apply does to the space it found (APPLY-ONE-DOOR-PLAN
 * §1). Pure: (the target's template state, the version being applied) → one
 * action. It replaces the per-door branches that decided this before —
 * `resumeIfFailed`, `failedInLayerTwo` + `withoutStamp`, the tRPC resume
 * blocks and `reconcileExisting` — which each answered a different subset of
 * the cases below, so the same space could be re-created by one door,
 * re-synced by another and skipped by a third.
 *
 *   no space                                   → create
 *   adopting (the space takes this identity
 *     now: Hub `/pod/adopt`, approve adopt)    → resync (its layer 1 has never
 *                                                been this template's)
 *   failed in layer 1, with a resume ledger    → resume-layer1 (the create core
 *                                                continues from its steps)
 *   failed in a layer-1 RE-SYNC (`reconcile`)  → resync (the space was built:
 *                                                its ledger is the create's,
 *                                                every step done — a "resume"
 *                                                would run nothing, then stamp)
 *   failed in layer 1, NO ledger               → resync (the row exists: a
 *                                                resume would re-run step 1 and
 *                                                mint a second space / 409)
 *   failed in layer 2                          → resync (layer 1 is built; its
 *                                                stamp is not trusted)
 *   unfinished (awaiting-approval · partial ·
 *     layer-2-not-run)                         → resync (the last apply did not
 *                                                earn its stamp)
 *   version differs from the stamp             → resync (stale)
 *   no version to compare                      → unchanged, `checked: false`
 *   version equals the stamp, state settled    → unchanged
 *
 * A `resync` with `reopen` leaves the "failed" state before layer 2 runs (the
 * finisher never overwrites "failed"; a layer 2 that throws again re-marks it).
 */
import {
  isFailedInLayerTwo,
  isTemplateApplyUnfinished,
  type TemplateState,
} from "@synap/database";

/** The step `createWorkspaceFromDefinition` records once the row exists. */
export const WORKSPACE_ROW_STEP = "workspace";

/** The failed step layer one records when a re-sync of a BUILT space throws. */
export const RESYNC_FAILED_STEP = "reconcile";

export type TemplateApplyAction =
  | { kind: "create" }
  | { kind: "resume-layer1"; completedSteps: string[] }
  | {
      kind: "resync";
      reason:
        | "stale"
        | "failed-layer-2"
        | "failed-no-ledger"
        | "failed-resync"
        | "unfinished"
        | "adopt";
      /** Leave "failed" before layer 2 re-runs. */
      reopen: boolean;
    }
  | {
      kind: "unchanged";
      /** False when no version signal existed to compare against. */
      checked: boolean;
    };

export interface PlanTemplateApplyInput {
  /** `null` = no space holds the template yet. */
  target: { state: TemplateState | null } | null;
  /** The version being applied (catalog-resolved, else the caller's). */
  version: string | undefined;
  /**
   * The space is being adopted into this template right now (it did not hold
   * the identity before): re-sync it whatever its state or version says.
   */
  adopting?: boolean;
}

export function planTemplateApply(
  input: PlanTemplateApplyInput
): TemplateApplyAction {
  const { target, version } = input;
  if (!target) return { kind: "create" };
  const state = target.state;
  if (input.adopting)
    return {
      kind: "resync",
      reason: "adopt",
      reopen: state?.state === "failed",
    };
  if (state?.state === "failed") {
    if (isFailedInLayerTwo(state))
      return { kind: "resync", reason: "failed-layer-2", reopen: true };
    if (state.failedStep === RESYNC_FAILED_STEP)
      return { kind: "resync", reason: "failed-resync", reopen: true };
    const steps = state.completedSteps ?? [];
    if (steps.includes(WORKSPACE_ROW_STEP))
      return { kind: "resume-layer1", completedSteps: steps };
    return { kind: "resync", reason: "failed-no-ledger", reopen: true };
  }
  if (isTemplateApplyUnfinished(state))
    return { kind: "resync", reason: "unfinished", reopen: false };
  if (!version) return { kind: "unchanged", checked: false };
  if (version !== state?.version)
    return { kind: "resync", reason: "stale", reopen: false };
  return { kind: "unchanged", checked: true };
}
