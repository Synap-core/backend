/**
 * Pod-wide reads (founder decision e1b59d38 "B", 2026-10-30): the ONE rule
 * for what an app may hold with no space, and the words for it.
 *
 * An app's grant part with no space is never "every space" for writes: it is
 * a read of named kinds everywhere in the pod, and nothing else. Every reader
 * that treats a part with no space as "not limited to spaces" (the holder's
 * sentence, template reach, facet reach, capture routing, a role write) must
 * skip such a part, through `isPodWideReadScope`.
 */

/**
 * What an app may hold pod-wide: a READ of ONE named kind,
 * `entity.<kind>.read`. Never a write or a gate verb, never a whole kind
 * (`entity.decision` = every verb), never every kind (`entity.read`,
 * `entity.*.read`), never `*`, never another subject. Checked where an app
 * declares it (the client metadata document), where the person ticks it
 * (consent, the `app/connect` executor), where it is stored and read back
 * (`readAppConnectRequests`) and where it becomes a grant
 * (`grantsForApprovedRequests`).
 */
export function isPodWideReadPermission(permission: string): boolean {
  return /^entity\.[a-z0-9][a-z0-9_-]*\.read$/.test(permission);
}

/**
 * A grant scope that is only a pod-wide read: no space, project or object
 * limit, and every permission `isPodWideReadPermission`. Such a scope reads
 * its kinds everywhere and does nothing else, so the doors that treat a scope
 * with no space as "not limited to spaces" must not count it as one.
 */
export function isPodWideReadScope(scope: {
  readonly permissions: readonly string[];
  readonly workspaceIds?: readonly string[] | null;
  readonly projectIds?: readonly string[] | null;
  readonly entityIds?: readonly string[] | null;
}): boolean {
  return (
    !scope.workspaceIds?.length &&
    !scope.projectIds?.length &&
    !scope.entityIds?.length &&
    scope.permissions.length > 0 &&
    scope.permissions.every(isPodWideReadPermission)
  );
}

/** Where a pod-wide read applies, after its verb ("reads decisions everywhere in your pod"). */
export const EVERYWHERE_IN_POD = "everywhere in your pod";

/** The same place as a heading, where a space's name would go. */
export const POD_WIDE_HEADING = "Everywhere in your pod";
