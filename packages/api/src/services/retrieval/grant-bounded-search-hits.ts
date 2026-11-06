/**
 * The grant bound for RAW search hits (finding cce86e6b: Raycast's Search
 * Synap, a scoped key, was refused full-text search).
 *
 * Typesense knows the person, never the calling key's grant: it ranks every
 * match the PERSON may see. So for a key whose grant narrows anything
 * (`isFencedGrant`: a scoped key, or a `*` pinned to a space, project or
 * object) the page's entity hits are re-read through THE entity read floor,
 * `entityReadVisibleWhere` (`accessScopeWhere`, which ANDs the key's grant:
 * the same predicate `entities.list` reads under), as one database intersect
 * over the page's ids. What the grant does not reach is dropped, relevance
 * order kept. Narrow-only: a hit is kept only when the floor AND the grant
 * read it, so it can never widen what Typesense returned.
 *
 * Everything else Typesense says about the dropped hits goes with them:
 *  - non-entity hits (documents, views, channels, agents) are dropped: no
 *    seam bounds them here, so a fenced key gets none;
 *  - `found` is Typesense's count over every match the person may see, so it
 *    is replaced by the kept count of THIS page (a lower bound of the in-grant
 *    total, never a count of out-of-grant rows);
 *  - `facetCounts` are counted over every match, so they are removed.
 * Highlights and snippets ride on each hit and leave with it.
 *
 * An unfenced caller (no grant, or the unbounded full-access `*`) is answered
 * exactly as before: the response object is returned untouched, no query.
 *
 * A failed intersect THROWS: hiding every hit on a read failure would render
 * as "no results" (empty ≠ failed).
 */

import { db, and, inArray, isNull, getRequestGrant } from "@synap/database";
import { entities } from "@synap/database/schema";
import { isUuid } from "@synap-core/types/property-render";
import { isFencedGrant } from "../../access/grant-door-fence.js";
import { entityReadVisibleWhere } from "../../access/entity-read-floor.js";

interface HitLike {
  id: string;
  collection: string;
  document?: unknown;
}

function entityIdOf(hit: HitLike): string {
  const doc = hit.document as { id?: unknown } | null | undefined;
  return typeof doc?.id === "string" ? doc.id : hit.id;
}

/** Keep only the hits the request's grant reads (no-op when unfenced). */
export async function withinGrantSearchHits<
  R extends { results: HitLike[]; found: number; facetCounts?: unknown },
>(response: R, userId: string): Promise<R & { boundedByGrant?: true }> {
  if (!isFencedGrant(getRequestGrant())) return response;

  // A hit whose id is not a uuid names no `entities` row: not readable (and
  // a non-uuid in the IN list would fail the whole read).
  const candidates = [
    ...new Set(
      response.results
        .filter((r) => r.collection === "entities")
        .map(entityIdOf)
        .filter((id) => isUuid(id))
    ),
  ];
  const readable =
    candidates.length === 0
      ? []
      : await db
          .select({ id: entities.id })
          .from(entities)
          .where(
            and(
              inArray(entities.id, candidates),
              isNull(entities.deletedAt),
              entityReadVisibleWhere(userId)
            )
          );
  const keep = new Set(readable.map((r) => r.id));
  const results = response.results.filter(
    (r) => r.collection === "entities" && keep.has(entityIdOf(r))
  );
  return {
    ...response,
    results,
    found: results.length,
    facetCounts: undefined,
    boundedByGrant: true,
  };
}
