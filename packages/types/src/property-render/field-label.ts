/** Field labels — the one source of the words a property shows. */

import { humanizeToken } from "../vocabulary/index.js";

/**
 * The label for a property: `uiHints.displayName` → `uiHints.label` →
 * humanized slug. `label` counts because the system-profile seeds write it;
 * an authored label is used verbatim, since humanizing it would mangle
 * deliberate casing ("MRR" → "Mrr").
 */
export function resolvePropertyLabel(property: {
  slug: string;
  /** `unknown`: a hand-stored non-string label falls through to the slug. */
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
 * A field key as a sentence-case label, like every other label door. A dotted
 * slug keeps every segment ("billing.city" → "Billing city"): the path is what
 * tells `billing.city` from `shipping.city`.
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
