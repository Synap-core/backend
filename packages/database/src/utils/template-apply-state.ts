/**
 * Did the last template apply on this space NOT finish? Read from the two
 * durable records an apply writes into `workspace.settings`:
 *   - `provisioningStatus: "failed"` — a layer-2 throw
 *     (api `applyPackagePostWorkspace`), or a core step failure;
 *   - `templateApply` — layer 2 did not converge (awaiting approval, partial,
 *     never run), written by the ONE finisher (api `finishTemplateApply`).
 * Either way the version stamp was not earned by that apply, whatever it says.
 *
 * ONE predicate, read by every party that judges or writes the stamp: template
 * health (api `templateHealthFor`: such a space reads drifted) and the
 * reconcile util below (`reconcileWorkspaceFromDefinition` holds a version it
 * was asked to stamp — the boot pass's channel), so boot can never stamp over
 * an apply the update door has not finished.
 */
export function templateApplyUnfinished(settings: unknown): boolean {
  const s = (settings ?? {}) as {
    provisioningStatus?: unknown;
    templateApply?: unknown;
  };
  return (
    s.provisioningStatus === "failed" ||
    (!!s.templateApply && typeof s.templateApply === "object")
  );
}
