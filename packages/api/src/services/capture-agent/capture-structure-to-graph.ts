/**
 * capture-structure-to-graph — the confirm-mode bridge.
 *
 * `/capture/structure` produces a tempId-keyed PLAN (IS entities + relations).
 * Confirm mode persists that plan as a pending composite proposal via
 * `submitCaptureGraph`, which speaks ref-keyed `CaptureGraphEntity[]`. This is
 * the pure mapper between the two shapes, plus the guard that decides whether a
 * given plan is durable enough to persist at all.
 *
 * IMPORTANT — this changes ONLY what happens AFTER a plan is produced. A
 * degraded fallback (create-nothing), a clarifying `followUp`, or an empty plan
 * is NOT persisted; the door returns it unchanged, exactly as before.
 */

import type {
  CaptureGraphEntity,
  CaptureGraphRelation,
} from "../../routers/hub-protocol/rest/_capture-graph-dedup.js";

/** The subset of a `/capture/structure` response this bridge reads. */
export interface CaptureStructureLike {
  proposals?: Array<Record<string, unknown>>;
  relations?: Array<Record<string, unknown>>;
  followUp?: unknown;
  degraded?: boolean;
}

/**
 * Whether a produced structure plan should be PERSISTED as a pending proposal
 * (confirm mode). A degraded fallback, a clarifying-question `followUp`, or an
 * empty plan must NOT be persisted — those are returned to the caller unchanged.
 */
export function shouldPersistCapturePlan(
  structure: CaptureStructureLike
): boolean {
  if (structure.degraded === true) return false;
  if (structure.followUp != null) return false;
  return Array.isArray(structure.proposals) && structure.proposals.length > 0;
}

/**
 * Map a `/capture/structure` plan (tempId-keyed) → `submitCaptureGraph`
 * entities+relations (ref-keyed). `tempId` becomes `ref`; a facet's
 * `contextTempId` becomes `contextRef`; relations whose endpoints fell out of
 * the entity set are dropped (they'd dangle at materialization time).
 */
export function captureStructureToGraph(structure: CaptureStructureLike): {
  entities: CaptureGraphEntity[];
  relations: CaptureGraphRelation[];
} {
  const proposals = Array.isArray(structure.proposals)
    ? structure.proposals
    : [];
  const entities: CaptureGraphEntity[] = proposals.map((p, i) => {
    const ref = typeof p.tempId === "string" && p.tempId ? p.tempId : `e${i}`;
    const facetsRaw = Array.isArray(p.facets)
      ? (p.facets as Array<Record<string, unknown>>)
      : [];
    const facets = facetsRaw
      .filter((f) => typeof f.profileSlug === "string" && f.profileSlug)
      .map((f) => ({
        profileSlug: f.profileSlug as string,
        ...(typeof f.status === "string" ? { status: f.status } : {}),
        ...(f.properties && typeof f.properties === "object"
          ? { properties: f.properties as Record<string, unknown> }
          : {}),
        ...(typeof f.contextTempId === "string" && f.contextTempId
          ? { contextRef: f.contextTempId }
          : {}),
      }));
    return {
      ref,
      profileSlug: String(p.profileSlug ?? ""),
      ...(typeof p.title === "string" ? { title: p.title } : {}),
      ...(typeof p.description === "string"
        ? { description: p.description }
        : {}),
      ...(typeof p.content === "string" ? { content: p.content } : {}),
      ...(p.properties && typeof p.properties === "object"
        ? { properties: p.properties as Record<string, unknown> }
        : {}),
      ...(typeof p.existingEntityId === "string"
        ? { existingEntityId: p.existingEntityId }
        : {}),
      ...(facets.length ? { facets } : {}),
    };
  });

  const refs = new Set(entities.map((e) => e.ref));
  const relRaw = Array.isArray(structure.relations) ? structure.relations : [];
  const relations: CaptureGraphRelation[] = relRaw
    .filter(
      (r) =>
        typeof r.sourceTempId === "string" &&
        typeof r.targetTempId === "string" &&
        typeof r.relationType === "string" &&
        r.relationType
    )
    .map((r) => ({
      sourceRef: r.sourceTempId as string,
      targetRef: r.targetTempId as string,
      type: r.relationType as string,
    }))
    .filter((r) => refs.has(r.sourceRef) && refs.has(r.targetRef));

  return { entities, relations };
}
