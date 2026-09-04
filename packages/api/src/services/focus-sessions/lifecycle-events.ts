/**
 * The focus-session lifecycle event names OTHER than close.
 *
 * `close-event.ts` owns the close pair (and the shared subject type, imported
 * here rather than re-declared). This file owns the Wave B verbs: triage
 * accept/discard, the session→project spawn, the session→playbook promote, and
 * the conversion revert.
 *
 * SAME GRAMMAR, SAME REASON. `emitSideEffects` composes
 * `${subjectType}.${action}.completed`, so the action segment is what an
 * automation rule is authored against — and the matcher grammar wants the PAST
 * mood. A present-tense action here ("spawn_project") makes every rule written
 * against it unbuildable, which is the defect
 * `rule-compile-or-refuse-shipped-2026-09-04` records. Hence `spawned_project`,
 * `triage_accepted`, `triage_discarded`, `conversion_reverted`.
 *
 * Never inline these literals: producers and consumers both import from here so
 * the emitted type and the persisted type cannot diverge.
 */

import { FOCUS_SESSION_SUBJECT_TYPE } from "./close-event.js";

export { FOCUS_SESSION_SUBJECT_TYPE };

/** A person took an agent/automation-originated session out of the triage lens. */
export const FOCUS_SESSION_TRIAGE_ACCEPT_ACTION = "triage_accepted" as const;
export const FOCUS_SESSION_TRIAGE_ACCEPTED_EVENT_TYPE =
  `${FOCUS_SESSION_SUBJECT_TYPE}.${FOCUS_SESSION_TRIAGE_ACCEPT_ACTION}.completed` as const;

/** A person threw one away (the session is cancelled, not deleted). */
export const FOCUS_SESSION_TRIAGE_DISCARD_ACTION = "triage_discarded" as const;
export const FOCUS_SESSION_TRIAGE_DISCARDED_EVENT_TYPE =
  `${FOCUS_SESSION_SUBJECT_TYPE}.${FOCUS_SESSION_TRIAGE_DISCARD_ACTION}.completed` as const;

/** A session became a project (structure-only conversion). */
export const FOCUS_SESSION_SPAWN_PROJECT_ACTION = "spawned_project" as const;
export const FOCUS_SESSION_SPAWNED_PROJECT_EVENT_TYPE =
  `${FOCUS_SESSION_SUBJECT_TYPE}.${FOCUS_SESSION_SPAWN_PROJECT_ACTION}.completed` as const;

/**
 * A session became a playbook. The promote door has existed since the
 * capability substrate but emitted NOTHING — no history row, no reactor hop —
 * so nothing downstream could see a promotion happen. Same pair as the others.
 */
export const FOCUS_SESSION_PROMOTE_ACTION = "promoted_playbook" as const;
export const FOCUS_SESSION_PROMOTED_EVENT_TYPE =
  `${FOCUS_SESSION_SUBJECT_TYPE}.${FOCUS_SESSION_PROMOTE_ACTION}.completed` as const;

/** The undo: the conversion was reverted inside its window. */
export const FOCUS_SESSION_REVERT_ACTION = "conversion_reverted" as const;
export const FOCUS_SESSION_CONVERSION_REVERTED_EVENT_TYPE =
  `${FOCUS_SESSION_SUBJECT_TYPE}.${FOCUS_SESSION_REVERT_ACTION}.completed` as const;
