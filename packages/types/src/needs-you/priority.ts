/**
 * THE PRIORITY of one needs-you row: P0-P3, DERIVED by the pod, never
 * nominated by an agent (founder, 2026-11-04; research doc 353be97e §4.2).
 *
 *   P0 — breaks through: a headline ask whose `answerBy` is due within the
 *        hour (or already past).
 *   P1 — push: the needs-you headline (a real asker, the agent stopped on it).
 *   P2 — feed: no push, in the feed and the badge — an agent is still working
 *        (`working`), a pending proposal nothing waits on
 *        (`changes_to_review`), or a headline ask its asker marked
 *        `urgency: 'whenever'`.
 *   P3 — digest: `stopped`, `review_later`, `from_system`.
 *
 * Same principle as a proposal's class (`proposal-class.ts` in the pod): an
 * agent that could pick its level would pick the loud one. So the level comes
 * from the needs-you rule's CLASS (`./rule.ts`, decided by the pod) plus one
 * fact the ask carries (`answerBy`), and the asker's `urgency` can only LOWER
 * it: `whenever` holds it at P2 at most; `now` and `today` change nothing.
 *
 * It ranks what the rule already admitted; it never moves a row between the
 * headline and a fold. Pure, zod-free (relay loads the needs-you leaves), the
 * clock a parameter — so Relay and the browser can mirror it under a tripwire.
 */

import type { NeedsYouClass } from "./rule.js";

export const NEEDS_YOU_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export type NeedsYouPriority = (typeof NEEDS_YOU_PRIORITIES)[number];

/** A headline ask due within this long (or overdue) is P0. */
export const NEEDS_YOU_DUE_SOON_MS = 60 * 60 * 1000;

/** The level each class starts at, before the ask's own facts. */
export const NEEDS_YOU_CLASS_PRIORITY: Readonly<
  Record<NeedsYouClass, NeedsYouPriority>
> = {
  needs_you: "P1",
  working: "P2",
  changes_to_review: "P2",
  stopped: "P3",
  review_later: "P3",
  from_system: "P3",
};

/** The facts the priority reads — structural, a slot's `ask` fits. */
export interface NeedsYouPriorityFacts {
  /** The needs-you rule's class for the row (stamped by the pod). */
  needsYouClass: NeedsYouClass;
  /** `ask.urgency` — the asker's hint; read only to LOWER the level. */
  urgency?: unknown;
  /** `ask.answerBy` — an ISO-8601 instant; anything else is ignored. */
  answerBy?: unknown;
}

function rank(p: NeedsYouPriority): number {
  return NEEDS_YOU_PRIORITIES.indexOf(p);
}

/** The quieter of two levels. */
function quieter(a: NeedsYouPriority, b: NeedsYouPriority): NeedsYouPriority {
  return rank(a) >= rank(b) ? a : b;
}

/** `answerBy` as epoch ms, or NaN when it is not a readable instant. */
function dueAt(answerBy: unknown): number {
  return typeof answerBy === "string" ? Date.parse(answerBy) : Number.NaN;
}

export function needsYouPriority(
  facts: NeedsYouPriorityFacts,
  now: Date = new Date()
): NeedsYouPriority {
  const base = NEEDS_YOU_CLASS_PRIORITY[facts.needsYouClass] ?? "P3";
  let level = base;
  // Only a headline ask can break through: a fold is out of the headline by
  // the rule, and a deadline does not change who is working on it.
  if (facts.needsYouClass === "needs_you") {
    const due = dueAt(facts.answerBy);
    if (!Number.isNaN(due) && due - now.getTime() <= NEEDS_YOU_DUE_SOON_MS) {
      level = "P0";
    }
  }
  // The asker's hint only ever lowers the level.
  if (facts.urgency === "whenever") level = quieter(level, "P2");
  return level;
}
