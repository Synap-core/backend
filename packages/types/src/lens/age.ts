/**
 * The two time words a row prints, ONCE: the age span ("8d") and the short
 * date ("29 Sep"). The ask card (`../ask/card.ts`), the row's expiry
 * (`lensRowExpiry`) and the proposal's fate line (`proposalFateLine`) all read
 * these, so "8d" on an ask and "Expires in 7d" on a proposal count alike.
 *
 * A leaf module: `rows.ts` imports the ask card, so the card cannot import
 * `rows.ts` back.
 */

/** "<1m" / "12m" / "5h" / "8d" — a span, floored to its largest unit. */
export function ageSpan(ms: number): string {
  const mins = Math.floor(Math.max(0, ms) / 60_000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  if (mins < 24 * 60) return `${Math.floor(mins / 60)}h`;
  return `${Math.floor(mins / (24 * 60))}d`;
}

/** "29 Sep" — or null when the instant is absent or unreadable. */
export function shortDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
