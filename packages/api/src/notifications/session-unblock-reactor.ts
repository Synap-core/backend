/**
 * "The last thing you were waiting on is done" — the ONE producer of
 * `session.unblocked`.
 *
 * THE RULE (Asana's, and the reason this is a reactor and not a line inside the
 * close door): a session waiting on three blockers is NOT unblocked when the
 * first one closes. The notification fires exactly once, when the set of
 * blockers that are still OPEN becomes empty. So this reactor never reasons
 * from the close event alone — it re-derives `openBlockerIds(dependent)` after
 * the close and stays silent unless that set is empty.
 *
 * THE SEAM: `complete-session.ts` is the only close door, and it already emits
 * `focus_session.closed` through `emitSideEffects`. Registering a reactor off
 * that emit means the close door does not have to remember the notification —
 * the same IoC move `pod-wide-proposal-reactor.ts` makes, and for the same
 * reason (`@synap/events` cannot import `@synap/api`, so the api process
 * registers its own reactors at boot).
 *
 * IDEMPOTENT on `(dependent, closed blocker)`, keyed on the durable
 * notification row's `groupKey` rather than on ordering — a re-delivered or
 * replayed close event is a no-op. Deliberately NOT keyed on the dependent
 * alone: a session can legitimately be blocked again later and unblocked again,
 * and that second unblocking is real news.
 *
 * NEVER THROWS: `emitSideEffects` isolates a failing reactor, but a swallowed
 * failure here would leave no evidence that nobody was told their work can
 * resume — so failures are logged.
 */

import { createLogger } from "@synap-core/core";
import {
  db,
  and,
  eq,
  inArray,
  focusSessions,
  notifications,
} from "@synap/database";
import { registerReactor, type Reactor } from "@synap/events";
import {
  FOCUS_SESSION_SUBJECT_TYPE,
  FOCUS_SESSION_CLOSE_ACTION,
} from "../services/focus-sessions/close-event.js";
import {
  getSessionEdgesFor,
  openBlockerIds,
} from "../services/focus-sessions/session-blocked-by.js";
import { NotificationService } from "./NotificationService.js";

const logger = createLogger({ module: "session-unblock-reactor" });

/**
 * The registry type this reactor produces — declared under the lowercase name
 * first on purpose. `notification-producer-allowlist.test.ts` proves a registry
 * row has a producer by scanning source for the literal next to a
 * case-SENSITIVE `(type|notificationType)\s*[:=?]`, so a SCREAMING_SNAKE
 * declaration is invisible to it and a real producer reads as a dead row.
 */
const notificationType = "session.unblocked" as const;

export const SESSION_UNBLOCKED_NOTIFICATION_TYPE = notificationType;

/** `(dependent, blocker)` — the natural identity of "this unblocking". */
function unblockGroupKey(sessionId: string, blockerId: string): string {
  return `${SESSION_UNBLOCKED_NOTIFICATION_TYPE}:${sessionId}:${blockerId}`;
}

export const sessionUnblockNotifyReactor: Reactor = {
  id: "session-unblock-notify",
  match: (payload) =>
    payload.subjectType === FOCUS_SESSION_SUBJECT_TYPE &&
    payload.action === FOCUS_SESSION_CLOSE_ACTION,
  async handler(payload) {
    const closedId =
      (payload.data?.sessionId as string | undefined) ?? payload.subjectId;
    if (!closedId) return;

    // Inbound `blocked_by` edges — the sessions that were waiting on this one.
    const { unblocks } = await getSessionEdgesFor(closedId);
    if (unblocks.length === 0) return;

    // The closed session's goal, for the body. `complete-session.ts` DOES put
    // `goal` on the payload, but this reads the row anyway: the payload shape
    // is the close door's contract with the automation matcher, not with this
    // reactor, and the row is the one authority on what the session is called.
    // One extra query, only on a close that actually unblocks something.
    const [closed] = await db
      .select({ id: focusSessions.id, title: focusSessions.goal })
      .from(focusSessions)
      .where(eq(focusSessions.id, closedId))
      .limit(1);

    const dependents = await db
      .select({
        id: focusSessions.id,
        title: focusSessions.goal,
        userId: focusSessions.userId,
        workspaceId: focusSessions.workspaceId,
      })
      .from(focusSessions)
      .where(inArray(focusSessions.id, unblocks));

    for (const dependent of dependents) {
      try {
        // THE DERIVATION. Anything still open ⇒ still blocked ⇒ stay silent.
        const stillOpen = await openBlockerIds(dependent.id);
        if (stillOpen.length > 0) continue;

        const groupKey = unblockGroupKey(dependent.id, closedId);
        const [already] = await db
          .select({ id: notifications.id })
          .from(notifications)
          .where(
            and(
              eq(notifications.userId, dependent.userId),
              eq(notifications.type, SESSION_UNBLOCKED_NOTIFICATION_TYPE),
              eq(notifications.groupKey, groupKey)
            )
          )
          .limit(1);
        if (already) continue;

        await NotificationService.create({
          type: SESSION_UNBLOCKED_NOTIFICATION_TYPE,
          userId: dependent.userId,
          workspaceId: dependent.workspaceId,
          sourceType: "system",
          // The UNBLOCKED session is the destination — the registry's
          // `navigate-object` action reads this as its object id.
          sourceId: dependent.id,
          groupKey,
          data: {
            sessionId: dependent.id,
            sessionTitle: dependent.title,
            blockerSessionId: closedId,
            blockerTitle: closed?.title ?? "A blocking session",
          },
        });
      } catch (error) {
        logger.error(
          { error, sessionId: dependent.id, blockerSessionId: closedId },
          "Failed to notify session unblocked"
        );
      }
    }
  },
};

let registered = false;

/** Register the reactor. Called once at API boot (`apps/api/src/index.ts`). */
export function registerSessionUnblockReactor(): void {
  if (registered) return;
  registered = true;
  registerReactor(sessionUnblockNotifyReactor);
  logger.info("Registered session unblock notification reactor");
}
