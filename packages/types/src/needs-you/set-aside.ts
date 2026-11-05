/**
 * "Later" on an owed ask (founder decision 9bc9f75c, 2026-11-04): the person
 * sets one ask aside until a time; until then it is Review later, and it
 * comes back on its own. The same act as a request's Later
 * (`proposal_snoozes`, decision G3), stored on the slot (`laterUntil`)
 * because an owed ask has exactly one person.
 *
 * Its own module so both readers import it without a cycle: the needs-you
 * rule (`classifyOwedAsk`, `./rule.ts`) and the older fold reading
 * (`isAskReviewLater`, `../ask/card.ts`).
 */

/**
 * Is this ask set aside right now? An unreadable stamp is no Later: the ask
 * stays where the rest of the rule puts it.
 */
export function isSetAside(
  laterUntil: unknown,
  now: Date | number = Date.now()
): boolean {
  const until =
    laterUntil instanceof Date
      ? laterUntil.getTime()
      : typeof laterUntil === "string"
        ? Date.parse(laterUntil)
        : NaN;
  const at = now instanceof Date ? now.getTime() : now;
  return Number.isFinite(until) && until > at;
}
