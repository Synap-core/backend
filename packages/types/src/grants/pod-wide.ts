/**
 * Pod-wide reads (founder decision e1b59d38 "B", 2026-10-30): the ONE rule
 * for what an app may hold with no space, and the words for it.
 *
 * An app's grant part with no space is never "every space" for writes: it is
 * a read of named kinds everywhere in the pod, and nothing else. Every reader
 * that treats a part with no space as "not limited to spaces" (the holder's
 * sentence, template reach, facet reach, capture routing, a role write) must
 * skip such a part, through `isPodWideReadScope`.
 *
 * Since access model B (2 Nov 2026) the rule is applied ONCE, by `parsePlace`
 * (`./reach.ts`): an app's scope that passes it is the place `{kind: "pod"}`.
 */

/**
 * The subjects (not kinds) whose plain READ an app may hold pod-wide
 * (`<subject>.read`): what a person's own assistant app needs to see across the
 * whole pod, never to change it. Widened from entity kinds alone on
 * 2026-11-09 at the founder's request (the Synap AI Chat app asks for its
 * playbooks, runs, views, documents, relations, projects, automations,
 * proposals and conversations with no space): a space-restricted grant matches
 * `workspace_id IN (spaces)`, which a pod-wide row (workspace NULL) never
 * satisfies, so an app limited to spaces could not see the pod's own
 * playbooks at all.
 *
 * It is a closed list on purpose. A subject joins it only as a READ, for what
 * the person already reads (grant ∩ floor), and never adds a write: every
 * write, gate verb and act (`playbook.run`, `chat.stream`) stays per space.
 */
export const POD_WIDE_READ_SUBJECTS = [
  "playbook",
  "session",
  "view",
  "document",
  "relation",
  "project",
  "automation",
  "proposal",
  "channel",
] as const;

/**
 * What an app may hold pod-wide: a READ, and nothing else. Exactly one of
 *  - `entity.<kind>.read`, one named kind (decision e1b59d38 "B");
 *  - `entity.read`, every kind (the AI answering from the person's data);
 *  - `<subject>.read` for a subject in `POD_WIDE_READ_SUBJECTS`.
 * Never a write or a gate verb, never a whole kind or subject (`entity.decision`
 * and `playbook` mean every verb), never `entity.*.read`, never `*`, never a
 * subject outside the list. Checked where an app declares it (the client
 * metadata document), where the person ticks it (consent, the `app/connect`
 * executor), where it is stored and read back (`readAppConnectRequests`) and
 * where it becomes a grant (`grantsForApprovedRequests`).
 *
 * ONE regex literal on purpose: the SDK mirrors this rule and its tripwire
 * (`grammar.tripwire.test.ts`) reads the literal from this source. The subject
 * alternation must equal `POD_WIDE_READ_SUBJECTS` (`pod-wide.test.ts` ties them
 * both ways).
 */
export function isPodWideReadPermission(permission: string): boolean {
  // The SDK tripwire reads this literal on one line, so it is not wrapped:
  // prettier-ignore
  return /^(?:entity\.(?:[a-z0-9][a-z0-9_-]*\.)?read|(?:playbook|session|view|document|relation|project|automation|proposal|channel)\.read)$/.test(permission);
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

// The words for the place moved to the vocabulary door (`resolvePlaceLabel`,
// `../vocabulary/place-words.ts`); re-exported here so consumers that import
// them from the grants keep compiling.
export {
  EVERYWHERE_IN_POD,
  POD_WIDE_HEADING,
} from "../vocabulary/place-words.js";
