/**
 * `settings.exposurePolicy` is SERVER-OWNED (Sites W2 S3).
 *
 * It decides what a workspace lets its owner share with guests, link holders and
 * the public, so it must be written by exactly ONE door: the owner's
 * `shares.setPolicy` → `WorkspaceRepository.setExposurePolicy`. Every generic
 * settings path — `WorkspaceRepository.create` / `update` / `mergeSettings`,
 * which every package / template applier (create- and reconcile-workspace-from-
 * definition, package-apply-post-workspace) and every settings router goes
 * through — drops the key from what it writes. `update` REPLACES the blob, so it
 * also carries the STORED value over (a client round-trip cannot erase it).
 *
 * The policy's schema and its code ceiling live with the share service
 * (`packages/api/src/services/sharing/exposure-policy.ts`); this layer only
 * knows the key.
 */

export const EXPOSURE_POLICY_SETTINGS_KEY = "exposurePolicy" as const;

/** A copy of `settings` without the server-owned exposure policy. */
export function withoutExposurePolicy<T extends Record<string, unknown>>(
  settings: T
): Omit<T, typeof EXPOSURE_POLICY_SETTINGS_KEY> {
  if (!(EXPOSURE_POLICY_SETTINGS_KEY in settings)) return settings;
  const { [EXPOSURE_POLICY_SETTINGS_KEY]: _dropped, ...rest } = settings;
  return rest;
}
