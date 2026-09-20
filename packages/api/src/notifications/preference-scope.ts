/**
 * Notification-preference SCOPE — pure rules for "which row applies, and which
 * row does a write land on".
 *
 * WHY THIS EXISTS. `notification_preferences` is keyed `(user_id, workspace_id)`
 * with a NULLABLE `workspace_id`, so it has always held two kinds of row: a
 * POD-WIDE row (`workspace_id IS NULL`) and per-workspace OVERRIDE rows.
 * `NotificationService.create` reads them with a precedence — the workspace row
 * first, the pod row as fallback — but the two doors disagreed with it:
 *
 *   - `notifCenter.getPrefs` read ONLY the workspace row. A founder whose
 *     preferences live on the pod-wide row saw them as UNSET, in every
 *     workspace. That is the empty≠failed defect in its quietest form: a real
 *     stored preference rendering as "nothing configured".
 *   - `notifCenter.updatePrefs` WROTE only the workspace row. A quiet-hour
 *     window or a routing rule set from relay applied to exactly one workspace
 *     and was silent about it.
 *
 * THE RECONCILIATION CHOSEN (migration-free, nothing destroyed):
 *   1. **The reader's precedence is UNCHANGED** — workspace row, then pod row.
 *      Every existing override keeps behaving exactly as it does today; no row
 *      is rewritten, deleted, or migrated by this change.
 *   2. **Writes default to the pod-wide row** (`scope: "pod"`), matching the
 *      founder's decision that preferences are pod-wide. A caller that means a
 *      single workspace must say `scope: "workspace"` explicitly.
 *   3. **The shadow is SURFACED, never silent.** Because (1) holds, an existing
 *      workspace override still wins inside its workspace — so a pod-wide write
 *      would appear to do nothing there. `shadowingWorkspaceIds` reports exactly
 *      which workspaces that is, and `clearWorkspaceOverride` is the one door
 *      that drops an override so the pod row applies again. Without that pair,
 *      the founder has a preference they cannot see and cannot reach.
 *
 * Pure and DB-free so the precedence can be tested without a pod.
 */

/** The fields of a `notification_preferences` row this module reasons about. */
export interface PreferenceRowLike {
  workspaceId: string | null;
}

export type PreferenceScope = "pod" | "workspace";

/**
 * The row that APPLIES, mirroring `NotificationService.create`'s lookup:
 * workspace row first, pod-wide row as the fallback.
 *
 * Returns `null` for "neither row exists" — which is genuinely "nothing
 * configured", and is distinct from a failed read (the caller throws on a DB
 * error rather than folding it in here).
 */
export function resolveEffectivePrefs<T extends PreferenceRowLike>(
  podRow: T | null | undefined,
  workspaceRow: T | null | undefined
): { row: T | null; scope: PreferenceScope | null } {
  if (workspaceRow) return { row: workspaceRow, scope: "workspace" };
  if (podRow) return { row: podRow, scope: "pod" };
  return { row: null, scope: null };
}

/**
 * The workspaces where a pod-wide write will NOT take effect, because an
 * override row exists there and the reader's precedence gives it priority.
 *
 * Derived from the user's own rows rather than hand-listed, so a workspace that
 * gains an override joins this answer by EXISTING. A pod-wide row in the input
 * (`workspaceId === null`) is not a shadow of itself and is skipped.
 */
export function shadowingWorkspaceIds(
  rows: readonly PreferenceRowLike[]
): string[] {
  return rows
    .map((r) => r.workspaceId)
    .filter((id): id is string => id !== null);
}
