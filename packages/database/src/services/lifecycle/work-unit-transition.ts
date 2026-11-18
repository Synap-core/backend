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
  RecordedHold,
  TransitionBase,
  TransitionCause,
  WorkUnitTransitionPayload,
} from "@synap-core/types/lifecycle";
import type { StatusMoveActor } from "./apply-status-move.js";
import { transitionStamp } from "./transition-stamp.js";

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

/** What every subject's transition is built from (the shared base fields). */
export interface TransitionBaseInput {
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
  /** When it really happened (already bounded by the door); default now. */
  occurredAt?: Date | null;
  /** Decided by the writer (`decideMoveHold`); null when not a pause. */
  hold?: RecordedHold | null;
  /** A replay: the app its proposal was filed by (`proposals.app_id`). */
  appId?: string | null;
  /** The move that caused this one (a reaction); absent otherwise. */
  cause?: TransitionCause | null;
}

/**
 * The fields of `TransitionBase` every non-entity subject fills the same way
 * (a goal, a session, a run, a proposal, a slot): the subject type and its
 * own fields are the caller's.
 */
export function transitionBaseOf(
  input: TransitionBaseInput
): Omit<TransitionBase, "subjectType"> {
  return {
    transitionId: randomUUID(),
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
    // not seen). These writes land only from the statuses their
    // compare-and-set names, or write nothing, so they are never "stale".
    staleExpected: false,
    proposalId: input.proposalId ?? null,
    workspaceId: input.workspaceId,
    ...transitionStamp(input.actor.kind, input.occurredAt, {
      appId: input.appId,
    }),
    hold: input.hold ?? null,
    ...(input.cause ? { cause: input.cause } : {}),
  };
}

export function buildWorkUnitTransition(
  input: TransitionBaseInput & {
    subjectType: WorkUnitTransitionPayload["subjectType"];
    projectId: string | null;
    trackId: string | null;
  }
): WorkUnitTransitionPayload {
  return {
    ...transitionBaseOf(input),
    subjectType: input.subjectType,
    projectId: input.projectId,
    trackId: input.trackId,
  };
}
