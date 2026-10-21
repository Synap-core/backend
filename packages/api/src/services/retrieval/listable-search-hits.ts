/**
 * The listing rule for RAW search hits (FB1020 B5).
 *
 * Typesense knows nothing of probe rows or sample (demo) projects: a project
 * is flagged, or a record filed into one, without any reindex. So every door
 * that hands raw `entities` hits to a person passes them through the SAME
 * predicate the database listing doors use (`listableEntityWhere`), as one
 * database intersect over the page's entity ids. Non-entity hits pass through
 * untouched.
 *
 * `found` is Typesense's total BEFORE this filter; it is reduced by the hits
 * dropped from this page, which keeps it honest for this page and approximate
 * beyond it — `hiddenFromListing` says how many this page dropped.
 *
 * A failed intersect THROWS: hiding every hit on a read failure would render
 * as "no results" (empty ≠ failed).
 */

import { db, and, inArray, listableEntityWhere } from "@synap/database";
import { entities } from "@synap/database/schema";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface HitLike {
  id: string;
  collection: string;
  document?: unknown;
}

function entityIdOf(hit: HitLike): string {
  const doc = hit.document as { id?: unknown } | null | undefined;
  return typeof doc?.id === "string" ? doc.id : hit.id;
}

/** Drop entity hits the listing rule leaves out (probe + demo rows). */
export async function withoutUnlistableEntityHits<
  R extends { results: HitLike[]; found: number },
>(
  response: R,
  opts: { projectLens?: string | null } = {}
): Promise<R & { hiddenFromListing?: number }> {
  const entityIds = [
    ...new Set(
      response.results
        .filter((r) => r.collection === "entities")
        .map(entityIdOf)
    ),
  ];
  if (entityIds.length === 0) return response;

  // A hit whose id is not a uuid names no `entities` row: not listable (and
  // a non-uuid in the IN list would fail the whole read).
  const candidates = entityIds.filter((id) => UUID_RE.test(id));
  const listable =
    candidates.length === 0
      ? []
      : await db
          .select({ id: entities.id })
          .from(entities)
          .where(
            and(
              inArray(entities.id, candidates),
              listableEntityWhere({ projectLens: opts.projectLens })
            )
          );
  const keep = new Set(listable.map((r) => r.id));
  const results = response.results.filter(
    (r) => r.collection !== "entities" || keep.has(entityIdOf(r))
  );
  const hidden = response.results.length - results.length;
  if (hidden === 0) return response;
  return {
    ...response,
    results,
    found: Math.max(0, response.found - hidden),
    hiddenFromListing: hidden,
  };
}
