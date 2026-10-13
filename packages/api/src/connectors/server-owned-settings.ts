/**
 * Workspace settings keys that belong to the SERVER, not to whoever edits the
 * workspace.
 *
 * `controlPlane` is written by the provisioning flow (its `podId`, `tier`),
 * `nango` is the legacy plaintext connector credential, and `intent` is the
 * template's (install / reconcile only). `workspaces.update`
 * REPLACES the settings blob and clients receive a projection with these keys
 * stripped — so a client round-trip would both erase them and, worse, let any
 * editor plant a `controlPlane.url` / `nango.host` of their choosing.
 * `workspaces.create` / `update` therefore never take them from the client:
 * they are stripped from the incoming blob and, on update, carried over from
 * the stored row.
 */

export const SERVER_OWNED_WORKSPACE_SETTINGS_KEYS = [
  "controlPlane",
  "nango",
  // Sites W2 S3 — what the owner lets a workspace share (guests, links, the
  // public). Written ONLY by `shares.setPolicy` (owner, human) through
  // `WorkspaceRepository.setExposurePolicy`; the repository's generic writers
  // strip it too (`withoutExposurePolicy`, @synap/database).
  "exposurePolicy",
  // Homes A10 — what the space PRODUCES. ONE writer: the template install /
  // reconcile (`projectTemplateIntent` → `settings.intent`, @synap/database),
  // which writes through the repository, never this door. Clients DO read it
  // (`CLIENT_SAFE_WORKSPACE_SETTINGS_KEYS` lists it), so a settings save sends
  // it back: stripped and carried over from the stored row, never refused —
  // a refusal would fail every round-trip, a pass-through would let an editor
  // fork a template's intent the next reconcile then overwrites.
  "intent",
  // Template install state — written ONLY by the template apply (layer 1 +
  // layer 2 + the finisher, `template-apply-finisher.ts`) and the pack
  // installer, through `mergeSettings`. Clients read some of it
  // (`packageSlug`, `packageVersion`, `installedPacks`, `actionPlacements`,
  // `proposalId`), so a save sends them back; the rest (`templateApply`,
  // `failedStep*`, `completedSteps`, `provisioning*`) never reaches a client,
  // so a REPLACE without them erased the install record. Stripped and carried
  // over from the stored row: a settings save can neither erase the record nor
  // plant a version stamp layer 2 never earned. `packageSlug`, `proposalId`,
  // `provisioningStatus` and `systemSlug` also drive promoted COLUMNS
  // (`WorkspaceRepository.update` writes them from this blob, `?? null`), so
  // carrying them over is what keeps those columns from being nulled by a
  // save that merely omitted them. `template` is the coming one state object
  // (APPLY-ONE-DOOR-PLAN §2).
  "template",
  "templateApply",
  "failedStep",
  "failedStepError",
  "completedSteps",
  "provisioningStatus",
  "provisioningStartedAt",
  "packageSlug",
  "packageVersion",
  "proposalId",
  "installedPacks",
  "actionPlacements",
  // Identity of a SYSTEM space (`pod-admin`): read from the column by the
  // admin-role checks, so a client must never plant or clear it.
  "systemSlug",
] as const;

/** The client's settings with every server-owned key removed. */
export function stripServerOwnedSettings(
  incoming: Record<string, unknown>
): Record<string, unknown> {
  const out = { ...incoming };
  for (const key of SERVER_OWNED_WORKSPACE_SETTINGS_KEYS) delete out[key];
  return out;
}

/**
 * The settings to persist on an update: the client's blob minus server-owned
 * keys, plus the server-owned keys exactly as currently stored.
 */
export function preserveServerOwnedSettings(
  incoming: Record<string, unknown>,
  stored: unknown
): Record<string, unknown> {
  const out = stripServerOwnedSettings(incoming);
  const current = (stored ?? {}) as Record<string, unknown>;
  for (const key of SERVER_OWNED_WORKSPACE_SETTINGS_KEYS) {
    if (key in current) out[key] = current[key];
  }
  return out;
}
