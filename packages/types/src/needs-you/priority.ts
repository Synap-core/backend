/**
 * THE PRIORITY of one needs-you row: P0-P3, DERIVED by the pod, never
 * nominated by an agent (founder, 2026-11-04; research doc 353be97e §4.2).
 *
 *   P0 — first: a headline ask whose `answerBy` is due within the hour (or
 *        already past).
 *   P1 — the needs-you headline (a real asker, the agent stopped on it).
 *   P2 — below it, in the feed and the badge — an agent is still working
 *        (`working`), a pending proposal nothing waits on
 *        (`changes_to_review`), or a headline ask its asker marked
 *        `urgency: 'whenever'`.
 *   P3 — last: `stopped`, `review_later`, `from_system`.
 *
 * A RANK only, today: it orders the list and stamps the notification row's
 * level; no push decision reads it (push levels are a later change).
 *
 * Same principle as a proposal's class (`proposal-class.ts` in the pod): an
 * agent that could pick its level would pick the loud one. So the level comes
 * from the needs-you rule's CLASS (`./rule.ts`, decided by the pod) plus one
 * fact the ask carries (`answerBy`), and the asker's `urgency` can only LOWER
 * it: `whenever` holds it at P2 at most; `today` (the default) changes nothing.
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

/**
 * The level a needs-you NOTIFICATION row is stamped with (the EXISTING
 * `notifications.priority` scale, low · normal · high · urgent — never a fifth
 * scale). P1 is `high`, the `session.needs_you` registry default, so an ask
 * with no deadline and no urgency is stamped exactly as before. Display only:
 * no push decision reads it.
 */
export const NEEDS_YOU_PRIORITY_NOTIFICATION_LEVEL: Readonly<
  Record<NeedsYouPriority, "urgent" | "high" | "normal" | "low">
> = { P0: "urgent", P1: "high", P2: "normal", P3: "low" };

/** The louder of several levels (a push naming several asks names the loudest). */
export function loudestNeedsYouPriority(
  levels: readonly NeedsYouPriority[]
): NeedsYouPriority | null {
  let best: NeedsYouPriority | null = null;
  for (const l of levels) if (best === null || rank(l) < rank(best)) best = l;
  return best;
}

/**
 * A needs-you row's rank in the triage order (`orderNeedsYouByBlocking`): its
 * level's index, and P1 when the pod stamped none (a notification, an access
 * request, an older pod) — so only a row the pod DERIVED as quieter or louder
 * moves, and every other row keeps its place.
 */
export function needsYouPriorityRank(priority: unknown): number {
  const i = NEEDS_YOU_PRIORITIES.indexOf(priority as NeedsYouPriority);
  return i === -1 ? rank("P1") : i;
}
