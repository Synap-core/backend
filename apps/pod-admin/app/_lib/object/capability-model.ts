/**
 * The pure half of the capability object page (`views/capability-object.tsx`,
 * drawn by `/open/capability/:id`): who the page offers the verb switches to.
 * Its status mark is the Tools one (`tools/_lib/tool-status.ts`). The page
 * only fetches and draws.
 */

/**
 * Whether the page offers the verb switches. Mirrors the pod's ONE gate
 * (`setSkillApproved`, packages/api `set-skill-approved.ts`): a space's verb
 * needs that space's OWNER, a pod-wide verb needs a pod admin. Offer only —
 * the pod re-checks every switch and its refusal is shown under the verb.
 */
export function mayTurnVerbsOn(input: {
  /** The capability's space; null = pod-wide. */
  workspaceId: string | null;
  /** The viewer's role in that space (`workspaces.list`), if a member. */
  roleInSpace: string | null | undefined;
  viewerIsPodAdmin: boolean;
}): boolean {
  if (!input.workspaceId) return input.viewerIsPodAdmin;
  return input.roleInSpace === "owner";
}

/** Who can turn them on, said to someone who can't. */
export function whoTurnsVerbsOn(spaceName: string | null): string {
  return spaceName
    ? `Only an owner of ${spaceName} can turn its actions on or off.`
    : "Only a pod admin can turn its actions on or off — it is shared by the whole pod.";
}
