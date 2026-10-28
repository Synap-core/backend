/**
 * The activity log's FAMILIES in words — an observation namespace
 * (`OBSERVATION_NAMESPACES`, `../events/unified.ts`) as a person grants it:
 * a key limited to `event.ci.create` "Posts CI events". The family is a value
 * of the type system, so its words live here, never at a call site.
 */

import { humanizeToken } from "./index.js";

export const EVENT_FAMILY_LABELS = {
  dev: { plural: "Dev events", short: "Dev" },
  ci: { plural: "CI events", short: "CI" },
} as const;

/** "Dev events", "CI events"; an unknown family humanizes ("Deploy events"). */
export function resolveEventFamilyLabel(
  family: string,
  form: "plural" | "short" = "plural"
): string {
  const row = (
    EVENT_FAMILY_LABELS as Readonly<
      Record<string, { plural: string; short: string }>
    >
  )[family.trim()];
  if (row) return row[form];
  const words = humanizeToken(family);
  return form === "short" ? words : `${words} events`;
}
