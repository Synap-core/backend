/**
 * An automation runs FOR a person in a space. When that person leaves the
 * space, the automation must stop (audit 2026-10-28, F9): its writes were
 * already refused (`checkAutomationWriteOrPropose` re-runs the owner's RBAC),
 * but its reads (`query` steps scope to the space, not to the owner's
 * membership) and its outbound steps (`fetch`, webhook) never consulted it,
 * so a removed member kept a feed of the space going to a server they chose.
 *
 * Two halves, one rule:
 *  - `pauseAutomationsOfRemovedMember`: the removal itself pauses them, with a
 *    visible reason (`WorkspaceMemberRepository.remove`, the one door every
 *    member removal goes through);
 *  - `automationOwnerHasSpaceAccess`: the run checks again before it starts
 *    (`handleAutomationExecute`), for every trigger kind, so a removal by any
 *    other path, or a run already queued, is refused too.
 *
 * "The person" of an automation is its owner, or, when the owner is an agent,
 * the human who created that agent: an agent works for its person, and its
 * person leaving the space is what ends its access.
 */
import { and, eq, inArray } from "drizzle-orm";
import { automations, users, workspaceMembers } from "../schema/index.js";

export const AUTOMATION_OWNER_LEFT_SPACE =
  "Paused: the person it runs for is no longer a member of this space.";

/**
 * Whether the person an automation runs for may still read its space. `true`
 * for a pod-wide automation (no space) and for an owner that is not a pod
 * person (no users row: a system owner), which no member removal concerns.
 */
export async function automationOwnerHasSpaceAccess(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- any drizzle handle (db / tx)
  database: any,
  params: { ownerId: string; workspaceId: string | null | undefined }
): Promise<boolean> {
  if (!params.workspaceId) return true;
  const [owner] = await database
    .select({
      userType: users.userType,
      createdByUserId: users.createdByUserId,
    })
    .from(users)
    .where(eq(users.id, params.ownerId))
    .limit(1);
  if (!owner) return true;
  const person =
    owner.userType === "agent" ? owner.createdByUserId : params.ownerId;
  if (!person) return true;
  const [member] = await database
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, params.workspaceId),
        eq(workspaceMembers.userId, person)
      )
    )
    .limit(1);
  return !!member;
}

/**
 * Pause every active automation of the space that runs for `userId` (theirs,
 * or one of their agents'). Returns how many were paused.
 */
export async function pauseAutomationsOfRemovedMember(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- any drizzle handle (db / tx)
  database: any,
  params: { workspaceId: string; userId: string }
): Promise<number> {
  const agents: Array<{ id: string }> = await database
    .select({ id: users.id })
    .from(users)
    .where(
      and(eq(users.userType, "agent"), eq(users.createdByUserId, params.userId))
    );
  const owners = [params.userId, ...agents.map((a) => a.id)];
  const paused: Array<{ id: string }> = await database
    .update(automations)
    .set({
      status: "paused",
      errorMessage: AUTOMATION_OWNER_LEFT_SPACE,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(automations.workspaceId, params.workspaceId),
        inArray(automations.createdBy, owners),
        eq(automations.status, "active")
      )
    )
    .returning({ id: automations.id });
  return paused.length;
}
