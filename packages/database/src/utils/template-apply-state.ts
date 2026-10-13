import {
  isTemplateApplyUnfinished,
  readTemplateState,
} from "./template-state.js";

/**
 * Did the last template apply on this space NOT finish? — failed (in either
 * layer), or layer 2 unfinished (awaiting approval, partial, never run).
 * Either way the version stamp was not earned by that apply, whatever it says.
 *
 * ONE derivation: read through `readTemplateState` (utils/template-state.ts),
 * so `settings.template` and the legacy keys it falls back to answer the same.
 * A space still BUILDING is not "unfinished" here (an in-flight build — the
 * semantics before the state object, kept).
 *
 * Read by every party that judges or writes the stamp: template health (api
 * `templateHealthFor`: such a space reads drifted) and the reconcile util
 * (`reconcileWorkspaceFromDefinition` holds a version it was asked to stamp —
 * the boot pass's channel), so boot can never stamp over an apply the update
 * door has not finished.
 */
export function templateApplyUnfinished(settings: unknown): boolean {
  return isTemplateApplyUnfinished(readTemplateState(settings));
}
