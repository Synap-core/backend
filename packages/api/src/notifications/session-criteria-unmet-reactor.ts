/**
 * "It finished, and it did not meet what you asked for" — the ONE producer of
 * `session.closed.criteria_unmet`.
 *
 * THE SEAM, and why this is a reactor rather than a line in the close door:
 * `complete-session.ts` is the only close door and it already emits
 * `focus_session.closed` through `emitSideEffects`. Hanging off that emit means
 * the close door does not have to remember the notification — the same IoC move
 * `session-unblock-reactor.ts` and `pod-wide-proposal-reactor.ts` make, and for
 * the same reason (`@synap/events` cannot import `@synap/api`, so the api
 * process registers its own reactors at boot).
 *
 * RE-DERIVED, NEVER TRUSTED. The close event DOES carry `verdict` on its
 * payload, and this reactor ignores it and recomputes from
 * `loadSessionEvaluationSummary`. The payload shape is the close door's
 * contract with the automation matcher, not with this reactor; a replayed or
 * hand-crafted event must not be able to make the founder's phone ring, and a
 * human grade landing between the close and this handler must not be announced
 * as unmet. The row is the one authority.
 *
 * CANCELLED IS EXEMPT, on purpose. `closed` and `failed` are a session ENDING
 * while its criteria stand — news. `cancelled` is the one exit that ends the
 * obligation (complete-session.ts's own words: the work was deliberately
 * stopped and its owed slots are retired). Telling someone who just cancelled a
 * session that it did not meet criteria they abandoned is noise, and noise in
 * the one channel that is allowed to ring a phone is how a channel gets muted
 * wholesale.
 *
 * IDEMPOTENT via the ONE door: the registry type declares a session-keyed
 * `dedupeWindowMs`, so `NotificationService.create()` suppresses a redelivered
 * close event itself. This reactor deliberately does NOT hand-roll a second
 * "already sent?" query beside it — two suppression mechanisms for one type is
 * the fork the dedupe field exists to prevent. The limit is stated on that
 * field: it collapses a storm, it is not a mutual exclusion.
 *
 * NEVER SILENTLY SWALLOWS: `emitSideEffects` isolates a failing reactor, so a
 * swallowed failure here would leave no evidence anywhere that nobody was told
 * their session closed flagged. Failures are logged.
 */

import { createLogger } from "@synap-core/core";
import { db, eq, focusSessions } from "@synap/database";
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import { resolveStatusLabel } from "@synap-core/types/vocabulary";
import { registerReactor, type Reactor } from "@synap/events";
import {
  FOCUS_SESSION_SUBJECT_TYPE,
  FOCUS_SESSION_CLOSE_ACTION,
} from "../services/focus-sessions/close-event.js";
import { loadSessionEvaluationSummary } from "../services/focus-sessions/evaluations/record.js";
import { NotificationService } from "./NotificationService.js";

const logger = createLogger({ module: "session-criteria-unmet-reactor" });

/**
 * The registry type this reactor produces — lowercase `notificationType` first,
 * so the source-scan producer allowlist can see it. See the same note in
 * `session-unblock-reactor.ts`.
 */
const notificationType = "session.closed.criteria_unmet" as const;

export const CRITERIA_UNMET_NOTIFICATION_TYPE = notificationType;

/**
 * The terminal statuses that count as "it ended while its criteria stood".
 * `cancelled` is absent deliberately — see the header.
 */
const FLAGGABLE_TERMINAL_STATUSES = new Set(["closed", "failed", "completed"]);

/** The session is the identity — one notification per session, per the founder's grouping decision. */
export function criteriaUnmetGroupKey(sessionId: string): string {
  return `${CRITERIA_UNMET_NOTIFICATION_TYPE}:${sessionId}`;
}

/**
 * "2 required criteria not met" — a SENTENCE, not a label, so it is built here
 * and not in `@synap-core/types/vocabulary` (which names domain values; see
 * `.claude/rules/vocabulary.md` on what does not belong in it). The word
 * "criterion/criteria" is English inflection, which is exactly why the template
 * cannot do it: `{{…}}` interpolation has no conditionals.
 */
export function unmetSummary(requiredUnmet: number): string {
  return requiredUnmet === 1
    ? "1 required criterion not met"
    : `${requiredUnmet} required criteria not met`;
}

export const sessionCriteriaUnmetNotifyReactor: Reactor = {
  id: "session-criteria-unmet-notify",
  match: (payload) =>
    payload.subjectType === FOCUS_SESSION_SUBJECT_TYPE &&
    payload.action === FOCUS_SESSION_CLOSE_ACTION,
  async handler(payload) {
    const closedId =
      (payload.data?.sessionId as string | undefined) ?? payload.subjectId;
    if (!closedId) return;

    try {
      const [session] = await db
        .select({
          id: focusSessions.id,
          title: focusSessions.title,
          goal: focusSessions.goal,
          status: focusSessions.status,
          userId: focusSessions.userId,
          workspaceId: focusSessions.workspaceId,
          criteria: focusSessions.criteria,
        })
        .from(focusSessions)
        .where(eq(focusSessions.id, closedId))
        .limit(1);
      if (!session) return;

      if (!FLAGGABLE_TERMINAL_STATUSES.has(session.status)) return;

      // THE DERIVATION. Read from `session_evaluations`, not from
      // `payload.data.verdict`.
      const { verdict } = await loadSessionEvaluationSummary(session);
      if (verdict.requiredUnmet === 0) return;

      await NotificationService.create({
        type: CRITERIA_UNMET_NOTIFICATION_TYPE,
        userId: session.userId,
        workspaceId: session.workspaceId,
        sourceType: "session",
        // The session is the destination — the registry's `navigate-object`
        // action and the push tap both read this as the object id.
        sourceId: session.id,
        groupKey: criteriaUnmetGroupKey(session.id),
        data: {
          sessionId: session.id,
          sessionTitle: resolveSessionTitle(session),
          // The ONE door for a lifecycle value's human name — never a local
          // map (`.claude/rules/vocabulary.md`).
          statusLabel: resolveStatusLabel(session.status),
          unmetSummary: unmetSummary(verdict.requiredUnmet),
          requiredUnmet: verdict.requiredUnmet,
        },
      });
    } catch (error) {
      logger.error(
        { error, sessionId: closedId },
        "Failed to notify session closed with required criteria unmet"
      );
    }
  },
};

let registered = false;

/** Register the reactor. Called once at API boot (`apps/api/src/index.ts`). */
export function registerSessionCriteriaUnmetReactor(): void {
  if (registered) return;
  registered = true;
  registerReactor(sessionCriteriaUnmetNotifyReactor);
  logger.info("Registered session criteria-unmet notification reactor");
}
