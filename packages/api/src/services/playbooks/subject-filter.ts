/**
 * A playbook's `subjectProfile.filter` against ONE entity — evaluated by the
 * pod, so every surface that offers "run this on this record" (the entity
 * action strip, capture's route suggestions) agrees on which records it fits.
 *
 * Readable shape: a flat `{ property: literal }` record — exact equality on the
 * entity's `properties` (the `when.propertyEquals` grammar). Anything else (a
 * query string, operators, nesting) cannot be read safely: `unreadable`, and
 * the caller decides (the entity strip skips it; ranking keeps it).
 *
 * Limit, stated: a role-facet subject's properties live on `entity_facets`, not
 * on the entity — a filter on a facet property reads the entity's own bag.
 * PURE.
 */

export type SubjectFilterVerdict = "pass" | "fail" | "unreadable";

function isScalar(v: unknown): boolean {
  return (
    v === null ||
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "boolean"
  );
}

export function evaluateSubjectFilter(
  filter: unknown,
  properties: Record<string, unknown> | null | undefined
): SubjectFilterVerdict {
  if (filter === undefined || filter === null) return "pass";
  if (typeof filter === "string")
    return filter.trim() === "" ? "pass" : "unreadable";
  if (typeof filter !== "object" || Array.isArray(filter)) return "unreadable";
  const entries = Object.entries(filter as Record<string, unknown>);
  if (entries.some(([, want]) => !isScalar(want))) return "unreadable";
  return entries.every(([k, want]) => Object.is(properties?.[k], want))
    ? "pass"
    : "fail";
}
