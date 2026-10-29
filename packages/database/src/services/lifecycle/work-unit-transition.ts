/**
 * The transition of a GOAL or a FOCUS SESSION (status-flow plan W1/W2) — the
 * same shape an entity move writes (`@synap-core/types/lifecycle`
 * `TransitionBase`), owed through the same outbox in the same transaction as
 * the status write, and emitted by the same dispatcher as
 * `track.transition.completed` / `focus_session.transition.completed`.
 *
 * Only the BUILD lives here. The writes stay where they were decided: a goal's
 * compare-and-set in `TrackRepository.transitionStatus`, a session's in
 * `setSessionStatus`. Neither dispatches inline (the writes often run inside a
 * caller's larger transaction, whose commit this package cannot see): the
 * sweeper (`lifecycle-transition-sweeper`, every minute) delivers what they
 * owe.
 */
import { randomUUID } from "node:crypto";
import type {
  LifecycleCategory,
  WorkUnitTransitionPayload,
} from "@synap-core/types/lifecycle";
import type { StatusMoveActor } from "./apply-status-move.js";

/**
 * Who moved a goal or a session. `userId` defaults to the subject's owner: a
 * reaper's bulk move is the system's, attributed to each row's own person.
 */
export interface WorkUnitActor {
  kind: StatusMoveActor["kind"];
  userId?: string | null;
  agentUserId?: string | null;
}

/** The actor of a door's move: the agent when an agent key made it, else the person. */
export function workUnitActorOf(
  userId: string,
  agentUserId?: string | null
): WorkUnitActor {
  return agentUserId
    ? { kind: "agent", userId, agentUserId }
    : { kind: "human", userId };
}

export function buildWorkUnitTransition(input: {
  subjectType: WorkUnitTransitionPayload["subjectType"];
  subjectId: string;
  from: string | null;
  to: string;
  fromCategory: LifecycleCategory | null;
  category: LifecycleCategory;
  actor: WorkUnitActor;
  ownerUserId: string;
  sessionId?: string | null;
  reason?: string | null;
  proposalId?: string | null;
  workspaceId: string | null;
  projectId: string | null;
  trackId: string | null;
}): WorkUnitTransitionPayload {
  return {
    transitionId: randomUUID(),
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    property: "status",
    from: input.from,
    to: input.to,
    fromCategory: input.fromCategory,
    category: input.category,
    actorKind: input.actor.kind,
    userId: input.actor.userId ?? input.ownerUserId,
    agentUserId: input.actor.agentUserId ?? null,
    sessionId: input.sessionId ?? null,
    reason: input.reason ?? null,
    // A `moveStatus` notion (a person's move applied over a value they had
    // not seen). A goal or session write lands only from the statuses its
    // compare-and-set names, or writes nothing, so it is never "stale".
    staleExpected: false,
    proposalId: input.proposalId ?? null,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    trackId: input.trackId,
  };
}
