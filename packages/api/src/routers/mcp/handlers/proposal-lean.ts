/**
 * `synap_get_proposal` default shape. The enriched row carries the payload
 * three times (`data`, `request.data`, and `review.changes` as its readable
 * form) plus every revision's whole before/patch snapshot, ~3x what a reader
 * needs to answer "why did my write not land?". `lean` keeps ONE copy of the
 * payload (`data`, where `data.failure` lives), `review`, provenance and
 * status; `full` is today's row.
 */

interface RevisionLike {
  at?: unknown;
  by?: unknown;
  patch?: unknown;
}

export function leanProposal<T>(proposal: T): T | Record<string, unknown> {
  // Only the enriched row has the shape to thin; anything else passes through.
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal))
    return proposal;
  const { request, revisionHistory, ...rest } = proposal as Record<
    string,
    unknown
  > & {
    request?: Record<string, unknown>;
    revisionHistory?: unknown;
  };
  const out: Record<string, unknown> = { ...rest };
  if (request && typeof request === "object") {
    const { data: _requestData, ...requestRest } = request;
    out.request = requestRest;
  }
  if (Array.isArray(revisionHistory)) {
    // Who and when, and which fields moved; never the before/patch bodies.
    out.revisionHistory = (revisionHistory as RevisionLike[]).map((r) => ({
      at: r.at,
      by: r.by,
      patchedFields:
        r.patch && typeof r.patch === "object" ? Object.keys(r.patch) : [],
    }));
  }
  return out;
}
