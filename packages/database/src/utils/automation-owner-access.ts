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
import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { automations, workspaceMembers } from "../schema/index.js";
import { agentsActingFor, personOfOwner } from "./owner-person.js";
import { setAutomationStatus } from "../services/lifecycle/automation-status.js";
import {
  AUTOMATION_AUDIENCE_KEY,
  type AutomationAudience,
} from "@synap-core/types/automations";

const EVERYONE: AutomationAudience = "everyone";

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
  const person = await personOfOwner(database, params.ownerId);
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
 * Pause every active automation of the space that runs for `userId` or was
 * written by them or by an agent acting for them (`agentsActingFor`): RBAC is
 * the owner's, so a removal is what stops an agent's work in that space.
 * Returns how many were paused.
 */
export async function pauseAutomationsOfRemovedMember(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- any drizzle handle (db / tx)
  database: any,
  params: { workspaceId: string; userId: string }
): Promise<number> {
  const actors = [
    params.userId,
    ...(await agentsActingFor(database, params.userId)),
  ];
  const paused = await setAutomationStatus(database, {
    from: "active",
    to: "paused",
    set: { errorMessage: AUTOMATION_OWNER_LEFT_SPACE },
    where: and(
      eq(automations.workspaceId, params.workspaceId),
      or(
        eq(automations.createdBy, params.userId),
        inArray(automations.agentUserId, actors)
      )
    ),
  });
  return paused.length;
}

export const AUTOMATION_AGENT_REMOVED =
  "Paused: the agent that wrote it was removed.";

/**
 * Pause every active automation these agents wrote. Call it in the same
 * transaction that deletes them: the delete nulls `agent_user_id`, and an
 * automation with no actor is governed as its person, so a deleted agent's
 * automations would otherwise keep running ungoverned.
 */
export async function pauseAutomationsOfAgents(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- any drizzle handle (db / tx)
  database: any,
  agentUserIds: readonly string[]
): Promise<number> {
  if (agentUserIds.length === 0) return 0;
  const paused = await setAutomationStatus(database, {
    from: "active",
    to: "paused",
    set: { errorMessage: AUTOMATION_AGENT_REMOVED, nextRunAt: null },
    where: inArray(automations.agentUserId, [...agentUserIds]),
  });
  return paused.length;
}

/**
 * WHICH POD-WIDE AUTOMATIONS answer to an event — the ONE predicate the trigger
 * matcher (`@synap/jobs` automation-trigger-matcher) and every surface that
 * replays it (`services/signal/channel-stack.ts`) select with.
 *
 * `eventActorIds` is `actorsOfSamePerson(db, <event userId>)`: the event's
 * person and that person's agents. A pod-wide automation answers when
 *  - its owner is one of them (audience `me`, the default: an automation an
 *    agent of P made answers to P's events and to P's other agents' events), or
 *  - its `triggerConfig.audience` is `everyone` (any member's events; the
 *    matcher then drops a run in a space the automation's person cannot see).
 *
 * Before decision 782c862e (2026-11-16) this was `createdBy = <event userId>`,
 * so an agent-authored automation never met an event by its person or by
 * another of its person's agents (finding 54095e11: two automations active for
 * nine days, runCount 0).
 */
export function podWideAutomationAnswersTo(
  eventActorIds: readonly string[]
): SQL {
  return and(
    isNull(automations.workspaceId),
    or(
      inArray(automations.createdBy, [...eventActorIds]),
      sql`${automations.triggerConfig}->>${AUTOMATION_AUDIENCE_KEY} = ${EVERYONE}`
    )
  ) as SQL;
}
