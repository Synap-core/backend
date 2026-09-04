/**
 * ONE name for the focus-session close event.
 *
 * Emitter: `complete-session.ts` (the only close door). Consumers: the
 * automation trigger matcher (`focus_session.closed.*`), the unblock reactor
 * (session-blocked-by), and the events history row. The verb is PAST mood
 * on purpose — the matcher grammar is `subjectType.action.completed` and a
 * mismatched mood makes every rule authored against it unbuildable (see
 * memory: rule-compile-or-refuse-shipped-2026-09-04).
 *
 * Never inline the literal elsewhere: a source-scan tripwire pins producers
 * and consumers to this constant.
 */
export const FOCUS_SESSION_SUBJECT_TYPE = "focus_session" as const;
export const FOCUS_SESSION_CLOSE_ACTION = "closed" as const;
export const FOCUS_SESSION_CLOSED_EVENT_TYPE =
  `${FOCUS_SESSION_SUBJECT_TYPE}.${FOCUS_SESSION_CLOSE_ACTION}.completed` as const;
