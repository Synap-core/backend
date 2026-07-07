/**
 * Hub Protocol REST — /capture/graph within-batch duplicate collapse.
 *
 * Pure helper extracted from capture.ts so it's unit-testable in isolation.
 * See capture.ts's "IDEMPOTENCY" comment for the full picture: this handles
 * the WITHIN-BATCH half (same proposal lists the same person under two
 * `ref`s); the persisted-entity half (already exists in the DB) is a
 * separate block in the handler.
 */

export interface CaptureGraphEntity {
  ref: string;
  profileSlug: string;
  title?: string;
  properties?: Record<string, unknown>;
  existingEntityId?: string;
}

export interface CaptureGraphRelation {
  sourceRef: string;
  targetRef: string;
  type: string;
}

export interface CaptureGraphBinding {
  externalChannelId: string;
  entityRef: string;
  branchPurpose?: "client-comms" | "team";
  title?: string;
}

/**
 * Collapse within-batch duplicate entities: among entities WITHOUT an
 * `existingEntityId` (those already pinned to a real row are never touched),
 * group by `${profileSlug}::${(title ?? ref).trim().toLowerCase()}`. The
 * FIRST occurrence of each key survives; later ones are dropped. Every
 * reference to a dropped ref (relations' sourceRef/targetRef, bindings'
 * entityRef) is rewritten to the survivor's ref. Relations that become a
 * self-loop as a result (sourceRef === targetRef) are dropped too — they'd
 * otherwise be a no-op relation to itself.
 *
 * Returns NEW arrays; inputs are not mutated.
 */
export function collapseDuplicateEntities(
  entities: CaptureGraphEntity[],
  relations: CaptureGraphRelation[],
  bindings: CaptureGraphBinding[]
): {
  entities: CaptureGraphEntity[];
  relations: CaptureGraphRelation[];
  bindings: CaptureGraphBinding[];
} {
  const keyToCanonicalRef = new Map<string, string>();
  const droppedRefToCanonicalRef = new Map<string, string>();
  const survivingEntities: CaptureGraphEntity[] = [];

  for (const e of entities) {
    // Entities already pinned to a real row are never subject to within-batch
    // collapse — they're not "duplicates to merge", they're already resolved.
    if (e.existingEntityId) {
      survivingEntities.push(e);
      continue;
    }
    const key = `${e.profileSlug}::${(e.title ?? e.ref).trim().toLowerCase()}`;
    const canonicalRef = keyToCanonicalRef.get(key);
    if (canonicalRef === undefined) {
      keyToCanonicalRef.set(key, e.ref);
      survivingEntities.push(e);
    } else {
      // Duplicate — drop it, remember where its references should be rewired.
      droppedRefToCanonicalRef.set(e.ref, canonicalRef);
    }
  }

  if (droppedRefToCanonicalRef.size === 0) {
    // Nothing collapsed — return as-is (still new arrays, per contract).
    return {
      entities: survivingEntities,
      relations: [...relations],
      bindings: [...bindings],
    };
  }

  const resolveRef = (ref: string): string =>
    droppedRefToCanonicalRef.get(ref) ?? ref;

  const rewrittenRelations: CaptureGraphRelation[] = [];
  for (const r of relations) {
    const sourceRef = resolveRef(r.sourceRef);
    const targetRef = resolveRef(r.targetRef);
    // Drop relations that became self-loops as a result of the collapse.
    if (sourceRef === targetRef) continue;
    rewrittenRelations.push({ ...r, sourceRef, targetRef });
  }

  const rewrittenBindings: CaptureGraphBinding[] = bindings.map((b) => ({
    ...b,
    entityRef: resolveRef(b.entityRef),
  }));

  return {
    entities: survivingEntities,
    relations: rewrittenRelations,
    bindings: rewrittenBindings,
  };
}
