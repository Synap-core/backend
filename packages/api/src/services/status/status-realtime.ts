/**
 * REALTIME STATUS EVENTS (status-first wave 2) — a status move and a status
 * signal, pushed to the people who may read that status, and nobody else:
 *
 *   status:transition:completed  every transition (a thing's or a role's, a
 *                                goal's, a session's), from the transition
 *                                log row (`lifecycle-transition.ts` appends
 *                                it through the hooked repository, once per
 *                                move; {@link statusRealtimeHook});
 *   status:signal:raised         every episode the status watcher raises
 *                                (`watcher.ts` `raise`, {@link pushStatusSignal}).
 *
 * AUDIENCE: `statusAudience` — THE statusOf floor (`status-floor.ts`), asked
 * for each user; each reader gets the event in their own `user:<id>` room.
 * Never a workspace room: a workspace member may not read every thing in it,
 * nor every role on a thing they read (the leak #538 closed for holds).
 *
 * PAYLOAD: what moved, from what to what, and when — no hold, no reason, no
 * mover, none of the watcher's words; the realtime schema is strict, so a key
 * added here later is refused. A client reads the rest through `statusOf`.
 *
 * Fire-and-forget, like every realtime push: nothing here can fail a move or
 * a raise. A failed audience read sends NOTHING (logged), never everyone.
 */
import { createLogger } from "@synap-core/core";
import type { EventHook, EventRecord } from "@synap/database";
import {
  EventNames,
  type StatusEventSubjectType,
  type StatusSignalRaisedEvent,
  type StatusTransitionEvent,
} from "@synap-core/types/events";
import {
  LIFECYCLE_CATEGORIES,
  isStatusSignal,
  type LifecycleCategory,
  type StatusSignal,
  type TransitionSubjectType,
} from "@synap-core/types/lifecycle";
import { validateEmitPayload } from "@synap/events/realtime-schemas";
import { postToBridge } from "../../utils/domain-event-bridge.js";
import { statusAudience, type StatusSubjectRef } from "./status-floor.js";

const logger = createLogger({ module: "status-realtime" });

/** A transition's subject, in `statusOf`'s words. */
const SUBJECT_OF: Record<TransitionSubjectType, StatusEventSubjectType> = {
  entity: "entity",
  track: "goal",
  focus_session: "session",
};

/** `<subject>.transition.completed` → its subject type (the log row's type). */
const TRANSITION_EVENT_SUBJECT = new Map<string, TransitionSubjectType>(
  (Object.keys(SUBJECT_OF) as TransitionSubjectType[]).map((t) => [
    `${t}.transition.completed`,
    t,
  ])
);

const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

const isCategory = (v: unknown): v is LifecycleCategory =>
  typeof v === "string" &&
  (LIFECYCLE_CATEGORIES as readonly string[]).includes(v);

/** One status event, ready to send: its audience's subject and its payload. */
export interface StatusPush<P> {
  event: string;
  subject: StatusSubjectRef;
  payload: P;
}

/**
 * The push a transition log row owes, or null when the row is not a status
 * move this can name (another event type, a row missing its target status).
 */
export function statusTransitionPush(
  row: EventRecord
): StatusPush<StatusTransitionEvent> | null {
  const subjectType = TRANSITION_EVENT_SUBJECT.get(row.eventType);
  if (!subjectType) return null;
  const d = row.data ?? {};
  const to = str(d.to);
  const category = d.category;
  if (!to || !isCategory(category)) return null;
  // Only an entity's move can be a role's (its status lives on the facet).
  const role = subjectType === "entity" ? str(d.role) : null;
  const facetId = subjectType === "entity" ? str(d.facetId) : null;
  // A role's move without its facet cannot be floored as the role: not sent.
  if (role && !facetId) return null;
  const type = SUBJECT_OF[subjectType];
  return {
    event: EventNames.STATUS_TRANSITION_COMPLETED,
    subject: { type, id: row.subjectId, facetId: role ? facetId : null },
    payload: {
      subjectType: type,
      subjectId: row.subjectId,
      transitionId: str(d.transitionId) ?? row.id,
      role,
      from: str(d.from),
      to,
      category,
      at: str(d.occurredAt) ?? new Date(row.timestamp).toISOString(),
    },
  };
}

/** What the watcher raised (`SignalCandidate`'s own fields). */
export interface RaisedStatusSignal {
  signal: StatusSignal;
  subjectType: TransitionSubjectType;
  subjectId: string;
  facetId: string | null;
  role: string | null;
  beganAt: string;
  raisedAt: Date;
}

/** The push a raised signal owes. */
export function statusSignalPush(
  s: RaisedStatusSignal
): StatusPush<StatusSignalRaisedEvent> | null {
  if (!isStatusSignal(s.signal)) return null;
  const type = SUBJECT_OF[s.subjectType];
  if (!type) return null;
  const role = s.subjectType === "entity" ? (s.role ?? null) : null;
  // A role's signal without its facet cannot be floored as the role: not sent.
  if (role && !s.facetId) return null;
  return {
    event: EventNames.STATUS_SIGNAL_RAISED,
    subject: { type, id: s.subjectId, facetId: role ? s.facetId : null },
    payload: {
      subjectType: type,
      subjectId: s.subjectId,
      signal: s.signal,
      role,
      beganAt: s.beganAt,
      raisedAt: s.raisedAt.toISOString(),
    },
  };
}

/**
 * Send one status event to each reader's room. Resolves once every POST is
 * handed to the bridge; never throws.
 */
export async function sendStatusPush<P>(push: StatusPush<P>): Promise<void> {
  const ctx = {
    socketEvent: push.event,
    subjectType: push.subject.type,
    subjectId: push.subject.id,
  };
  // The realtime server's own check: a payload it would refuse is not sent.
  const valid = validateEmitPayload(push.event, push.payload);
  if (!valid.ok) {
    logger.warn(
      { ...ctx, issues: valid.issues },
      "status event not sent: the realtime schema refuses its payload"
    );
    return;
  }
  let readers: string[];
  try {
    readers = await statusAudience(push.subject);
  } catch (err) {
    logger.warn(
      { ...ctx, err },
      "status event not sent: its readers could not be read"
    );
    return;
  }
  try {
    for (const userId of readers) {
      postToBridge(
        JSON.stringify({ event: push.event, data: push.payload, userId }),
        ctx
      );
    }
  } catch (err) {
    logger.warn({ ...ctx, err }, "status event not sent to every reader");
  }
}

/** Push a transition log row to its readers (a no-op for any other row). */
export async function pushStatusTransition(row: EventRecord): Promise<void> {
  const push = statusTransitionPush(row);
  if (push) await sendStatusPush(push);
}

/** Push a raised signal to its readers. Never throws. */
export async function pushStatusSignal(s: RaisedStatusSignal): Promise<void> {
  const push = statusSignalPush(s);
  if (push) await sendStatusPush(push);
}

/**
 * The event hook (`setup-event-broadcasting.ts`): a transition's log row,
 * appended once per move through the shared repository, becomes one
 * `status:transition:completed` per reader. Returns at once.
 */
export const statusRealtimeHook: EventHook = (row) => {
  if (!TRANSITION_EVENT_SUBJECT.has(row.eventType)) return;
  void pushStatusTransition(row);
};
