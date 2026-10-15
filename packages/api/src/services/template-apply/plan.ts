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
 *     the build did not finish                   continues from its steps)
 *   failed in a layer-1 RE-SYNC (`reconcile`)  → resync (the space was built:
 *                                                its ledger is the create's,
 *                                                every step done — a "resume"
 *                                                would run nothing, then stamp)
 *   failed in layer 1, NO ledger               → resync (the row exists: a
 *                                                resume would re-run step 1 and
 *                                                mint a second space / 409)
 *   failed in layer 2                          → resync (layer 1 is built; its
 *                                                stamp is not trusted)
 *   left "building", with a resume ledger      → resume-layer1 (a build that
 *     the build did not finish                   died before its finisher: the
 *                                                ledger is that build's own —
 *                                                the finisher clears it once a
 *                                                space converges)
 *   failed / left "building" with a COMPLETE   → resync + reopen (every step of
 *     ledger (`CREATE_CORE_LAST_STEP`)           the core ran: a "resume" would
 *                                                run nothing, then stamp the
 *                                                caller's version over that
 *                                                build — or race a create still
 *                                                between its core and its
 *                                                finisher; a re-sync is additive)
 *   left "building", NO ledger                 → resync + reopen (legacy
 *                                                "pending"; reopening leaves
 *                                                "building", so the finisher
 *                                                can mark it active)
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

/**
 * The LAST step `createWorkspaceFromDefinition` records: a ledger holding it
 * is a complete build, never resumed. Pinned to the core's source by
 * `plan.test.ts` (its last `completedSteps.push(...)`).
 */
export const CREATE_CORE_LAST_STEP = "relations-seed";

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
        | "abandoned-build"
        | "unfinished"
        | "adopt"
        | "complete-ledger";
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

/**
 * The ONE rule for a space whose build may not have finished: resume only a
 * ledger that holds the row step and lacks the core's last step; a complete
 * ledger re-syncs; no ledger re-syncs for `noLedger`.
 */
function resumeOrResync(
  completedSteps: string[] | undefined,
  noLedger: "failed-no-ledger" | "abandoned-build"
): TemplateApplyAction {
  const steps = completedSteps ?? [];
  if (steps.includes(CREATE_CORE_LAST_STEP))
    return { kind: "resync", reason: "complete-ledger", reopen: true };
  if (steps.includes(WORKSPACE_ROW_STEP))
    return { kind: "resume-layer1", completedSteps: steps };
  return { kind: "resync", reason: noLedger, reopen: true };
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
    return resumeOrResync(state.completedSteps, "failed-no-ledger");
  }
  if (state?.state === "building")
    // Either abandoned (a crash, a pre-step that threw before decision 3
    // covered it) or another apply still in its layer 2 (the per-key lock
    // spans layer 1 only). Resuming / re-syncing is additive either way, and
    // a "building" nothing can move on would read "in flight" forever.
    return resumeOrResync(state.completedSteps, "abandoned-build");
  if (isTemplateApplyUnfinished(state))
    return { kind: "resync", reason: "unfinished", reopen: false };
  if (!version) return { kind: "unchanged", checked: false };
  if (version !== state?.version)
    return { kind: "resync", reason: "stale", reopen: false };
  return { kind: "unchanged", checked: true };
}
