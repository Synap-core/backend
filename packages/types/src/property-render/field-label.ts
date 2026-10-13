/**
 * Field labels — SINGLE SOURCE OF TRUTH for the words a property shows.
 *
 * HOME: here (`@synap-core/types/property-render`), moved down from app-bases
 * `@synap-core/headless/property-renderer/utils/fieldFormatters.ts`. Follow-up:
 * re-point that copy's importers here and delete it (see `./index.ts`).
 */

import { humanizeToken } from "../vocabulary/index.js";

/**
 * Resolve the label to show for a property definition.
 *
 * Precedence: `uiHints.displayName` → `uiHints.label` → humanized slug.
 *
 * Two things this fixes, and both must stay true:
 *
 *  1. `label` is honoured. The system-profile seeds write `uiHints.label`
 *     (~138 sites in `ensure-system-profiles.ts`) while every reader read
 *     `uiHints.displayName`, so seeded properties displayed their humanized
 *     SLUG — "Ek Claim" instead of "Claim" — in detail cards and view column
 *     headers alike.
 *  2. An AUTHORED label is used verbatim. Only slugs get humanized. Running an
 *     authored label through `formatFieldLabel` lowercases inside words and
 *     mangles deliberate casing ("MRR" → "Mrr", "ID" → "Id").
 */
export function resolvePropertyLabel(property: {
  slug: string;
  /**
   * `unknown` members on purpose: a wire def's `uiHints` is an untyped JSON
   * record (`EffectivePropertyDef.uiHints`), so a non-string label stored by
   * hand falls through to the slug rather than being trusted.
   */
  uiHints?: { displayName?: unknown; label?: unknown } | null;
}): string {
  const hints = property.uiHints ?? {};
  const authored = trimmed(hints.displayName) || trimmed(hints.label);
  return authored || formatFieldLabel(property.slug);
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Format field key into human-readable label.
 *
 * Sentence case, through the vocabulary's `humanizeToken`.
 * This used to Title-Case every word itself ("Due Date", "First Name") while
 * every other label door in the product — `humanizeToken`, `resolveStatusLabel`,
 * the special cases right below — is sentence case, so one property list read
 * "Due date" beside "Start Date".
 *
 * A dotted slug keeps EVERY segment ("billing.city" → "Billing city"): a
 * property key's path is what tells `billing.city` from `shipping.city`, so it
 * is never cut to its last segment the way an action/event token is.
 */
export function formatFieldLabel(key: string): string {
  const label = key.replace(/^metadata\./, "");
  const specialCases: Record<string, string> = {
    dueDate: "Due date",
    createdAt: "Created",
    updatedAt: "Updated",
    assignee: "Assignee",
    isFavorite: "Favorite",
    userId: "User ID",
    startTime: "Start time",
    endTime: "End time",
    start_date: "Start date",
    end_date: "End date",
    startDate: "Start date",
    endDate: "End date",
    start_time: "Start time",
    end_time: "End time",
  };
  if (specialCases[label]) return specialCases[label];
  // `humanizeToken` keeps only a token's last dotted segment; a property path
  // must stay whole, so its dots become word breaks first.
  return humanizeToken(label.replace(/\./g, "_"));
}
