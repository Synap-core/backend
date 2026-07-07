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

/** Case-folded value → non-empty trimmed strings only. */
function foldKeyValues(value: unknown): string[] {
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    return v ? [v] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) =>
      typeof item === "string" && item.trim() ? [item.trim().toLowerCase()] : []
    );
  }
  return [];
}

/**
 * Every case-folded identity value that should resolve to one subject: its
 * name PLUS `email`, `discord-handle`, and each `aliases[]` entry. Profile-slug
 * agnostic (no prefix) — callers scope by slug. Shared by the within-batch
 * collapse here and the persisted-entity dedup in capture.ts (SSOT for "what
 * counts as the same person").
 */
export function identityValues(
  name: string | null | undefined,
  properties?: Record<string, unknown>
): string[] {
  const values = [
    ...(name && name.trim() ? [name.trim().toLowerCase()] : []),
    // NOTE: `email` is intentionally EXCLUDED as an auto-merge signal — shared/
    // generic inboxes (support@, hello@company.com) would silently collapse two
    // different people. `discord-handle` (near-unique) + `aliases` (same-person
    // surface forms) are the safe signals that fix handle↔name duplicates. The
    // agent can still resolve by email deliberately via the property index.
    ...foldKeyValues(properties?.["discord-handle"]),
    ...foldKeyValues(properties?.aliases),
  ];
  return [...new Set(values)];
}

/**
 * All dedup keys an entity answers to, scoped by profile slug: its title/ref
 * PLUS every identity value (`email`, `discord-handle`, each `aliases[]`). This
 * is what lets "0scr" (aliases: ["Oscar Piveteau"]) collapse into the "Oscar
 * Piveteau" person — they share the `person::oscar piveteau` key.
 */
export function entityDedupKeys(e: CaptureGraphEntity): string[] {
  const prefix = `${e.profileSlug}::`;
  return identityValues(e.title ?? e.ref, e.properties).map((v) => prefix + v);
}

/**
 * Collapse within-batch duplicate entities: among entities WITHOUT an
 * `existingEntityId` (those already pinned to a real row are never touched),
 * two entities are the same when they share ANY dedup key (see
 * `entityDedupKeys` — title/ref plus identity handles/aliases, all profile-slug
 * scoped and case-folded). The FIRST occurrence survives; later ones are
 * dropped. Every reference to a dropped ref (relations' sourceRef/targetRef,
 * bindings' entityRef) is rewritten to the survivor's ref. Relations that
 * become a self-loop as a result (sourceRef === targetRef) are dropped too —
 * they'd otherwise be a no-op relation to itself.
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
    const keys = entityDedupKeys(e);
    // Duplicate if ANY of this entity's keys already points at a survivor.
    let canonicalRef: string | undefined;
    for (const k of keys) {
      const hit = keyToCanonicalRef.get(k);
      if (hit !== undefined) {
        canonicalRef = hit;
        break;
      }
    }
    if (canonicalRef === undefined) {
      // Survivor — register ALL its keys so later dupes match on any of them.
      for (const k of keys) {
        if (!keyToCanonicalRef.has(k)) keyToCanonicalRef.set(k, e.ref);
      }
      survivingEntities.push(e);
    } else {
      // Duplicate — drop it, remember where its references should be rewired.
      // Also fold its still-unclaimed keys into the survivor so a third entity
      // sharing only THIS one's alias still collapses to the same survivor.
      droppedRefToCanonicalRef.set(e.ref, canonicalRef);
      for (const k of keys) {
        if (!keyToCanonicalRef.has(k)) keyToCanonicalRef.set(k, canonicalRef);
      }
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
