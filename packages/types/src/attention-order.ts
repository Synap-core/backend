/**
 * The ONE ordering of a list by how much it wants the reader's attention.
 *
 * Four surfaces that list things which can go wrong each invented their own
 * precedence — a `STATE_RANK` in the tools model, a `rankOf(failure)` in the
 * connectors model, an `IDENTITY_STATUS_RANK` in the brand kit, a `rankOf(kind)`
 * in governance. Four tables, four vocabularies, four answers to "what goes on
 * top", which is how the same inbox reads differently on two screens.
 *
 * ⚠️ All four STILL EXIST and none of them imports this yet: today this module
 * is a FIFTH table, not the one they converged on. (This docblock used to
 * describe the consolidation in the past tense, which a reader cannot check and
 * which was not true.) It has exactly one caller — `ConnectorGrid`, ordering
 * its connection cards. Treat it as the door those four should come through,
 * not as the door they already came through.
 *
 * This module owns the LADDER and the comparator, and nothing else. It names no
 * product value: a caller maps its own state to a rung
 * (`ToolRowState` → `needs-you`, a sync phase → `error`) and hands that in. The
 * mapping stays with the domain that knows its own states; the order is shared.
 *
 * PURE and dependency-free — it runs in the browser, Electron, Node and the CLI.
 *
 * WHY THIS ORDER. A reader opening a list is asking "what needs me?". So:
 *   error      something BROKE. Nothing outranks a failure.
 *   needs-you  nothing is broken, but it will not work until the person acts
 *              (connect, reconnect, approve, turn on).
 *   pending    in flight, or waiting on someone else — no action owed yet.
 *   ready      working. The good news, after the problems.
 *   off        deliberately not in play. Last: it is the quietest state, and a
 *              thing the user turned off is the thing they least need to see.
 */
export const ATTENTION_LEVELS = ['error', 'needs-you', 'pending', 'ready', 'off'] as const;

export type AttentionLevel = (typeof ATTENTION_LEVELS)[number];

/**
 * The rung's position: 0 is most urgent. `ATTENTION_LEVELS` is the ladder, so
 * the index IS the rank — there is no second numbering to drift from it.
 */
export function attentionRank(level: AttentionLevel): number {
  return ATTENTION_LEVELS.indexOf(level);
}

/** Sort comparator: most urgent first. Ties keep the caller's own order. */
export function compareAttention(a: AttentionLevel, b: AttentionLevel): number {
  return attentionRank(a) - attentionRank(b);
}

/** True for the two rungs that ask something OF the reader (error, needs-you). */
export function wantsAttention(level: AttentionLevel): boolean {
  return level === 'error' || level === 'needs-you';
}

/**
 * A STABLE copy of `items`, most urgent first, by the caller's own mapping.
 * A stable sort matters: two items on the same rung keep the order the caller
 * built, so a domain can pre-order within a rung (newest first, say) and this
 * will not scramble it.
 */
export function sortByAttention<T>(
  items: readonly T[],
  levelOf: (item: T) => AttentionLevel,
): T[] {
  return items
    .map((item, index) => ({ item, index, level: levelOf(item) }))
    .sort((a, b) => compareAttention(a.level, b.level) || a.index - b.index)
    .map((entry) => entry.item);
}

/**
 * The single rung a CONTAINER takes from its members: the most urgent one.
 * A thing is only as healthy as its worst part — folding a unit's members to
 * its most urgent member's state is what makes a list of one-liners honest.
 * `null` for an empty set, so a caller never invents a state for nothing.
 */
export function mostUrgentAttention(
  levels: readonly AttentionLevel[],
): AttentionLevel | null {
  let worst: AttentionLevel | null = null;
  for (const level of levels) {
    if (worst === null || compareAttention(level, worst) < 0) worst = level;
  }
  return worst;
}
