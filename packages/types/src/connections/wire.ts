/**
 * Wire adapters into the connections rule — shared by web and phone.
 *
 * Both hosts read the SAME wire (`graph.getObjectGraph` neighbours,
 * `relations.listTypes` rows, the kind-card model the face draws, the kind's
 * effective property defs). These adapters used to be written twice, once per
 * host, pinned only by a golden that proved the two copies AGREED — sameness,
 * not correctness. They live here once; each host keeps only its UI constants
 * and its route/door mapping.
 *
 * Pure: no React / RN / tRPC imports.
 */

import {
  groupConnections,
  drawnNameKey,
  suggestConnections,
  type ConnectionNeighbor,
  type ConnectionRelationType,
  type ConnectionSuggestion,
  type GroupedConnections,
  type KindReferenceProperty,
} from "./index.js";

/** One `graph.getObjectGraph` neighbour, as the wire sends it. */
export interface WireGraphNeighbor {
  id: string;
  name?: string | null;
  kind: string;
  subtype?: string | null;
  edgeType?: string | null;
  direction?: string | null;
  via?: string | null;
}

export function toConnectionNeighbors(
  neighbors: readonly WireGraphNeighbor[] | undefined
): ConnectionNeighbor[] {
  return (neighbors ?? []).map((n) => ({
    id: n.id,
    name: n.name ?? "",
    kind: n.kind,
    subtype: n.subtype ?? null,
    edgeType: n.edgeType ?? "",
    direction:
      n.direction === "incoming" || n.direction === "structural"
        ? n.direction
        : "outgoing",
    via: n.via ?? null,
  }));
}

/** One `relations.listTypes` row, as the wire sends it. */
export interface WireRelationType {
  type: string;
  label?: string | null;
  inverseLabel?: string | null;
  directionality?: string | null;
}

/**
 * `directionality` absent ⇒ DIRECTIONAL — the leaf's own default, so a def the
 * wire under-describes is never read as symmetric and its forward label never
 * claimed from the wrong end.
 */
export function toRelationTypeCatalog(
  types: readonly WireRelationType[] | undefined
): ConnectionRelationType[] {
  return (types ?? []).map((t) => ({
    slug: t.type,
    displayName: t.label ?? null,
    inverseLabel: t.inverseLabel ?? null,
    isDirectional: t.directionality !== "bidirectional",
  }));
}

/** The kind-card model fields this reads (structural — no import of the kit). */
interface KindCardFactLike {
  renderKind?: string;
  value: unknown;
  empty?: true;
}
export interface KindCardModelLike {
  keyFacts: readonly KindCardFactLike[] | null;
  hero: {
    subtitle:
      | { kind: "facts"; facts: readonly KindCardFactLike[] }
      | { kind: "range"; start: KindCardFactLike; end: KindCardFactLike | null }
      | null;
  };
}

const REF_KINDS: ReadonlySet<string> = new Set([
  "entity-ref",
  "multi-entity-ref",
]);
/** Facts whose value NAMES a thing in words (a company typed as text). */
const NAMING_KINDS: ReadonlySet<string> = new Set(["text", "select"]);

function refIds(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap(refIds);
  if (value && typeof value === "object") {
    const id = (value as { id?: unknown }).id;
    return typeof id === "string" && id ? [id] : [];
  }
  return [];
}

/**
 * What the card already DRAWS as a fact — in the key facts AND the hero
 * subtitle — as `groupConnections({ keyFactIds })` keys, so the section drops
 * the tie and it renders once:
 *   - an `entity-ref` / `multi-entity-ref` fact → the referenced entity ids;
 *   - a text/select fact → its name key ({@link drawnNameKey}). The live
 *     person shape: `company: "Probeworks SAS"` is TEXT in the subtitle while
 *     the tie is a `works_at` relation to the entity "Probeworks SAS" — an
 *     id-only match could never see it.
 * Invites (`empty`) and range subtitles (dates) draw nothing to match.
 * Read off the model the page computes; never recomputed from a key list.
 */
export function keyFactEntityIds(
  model: KindCardModelLike | null | undefined
): string[] {
  if (!model) return [];
  const sub = model.hero.subtitle;
  const facts: KindCardFactLike[] = [
    ...(model.keyFacts ?? []),
    ...(sub?.kind === "facts" ? sub.facts : []),
  ];
  const keys: string[] = [];
  for (const f of facts) {
    if (f.empty || !f.renderKind) continue;
    if (REF_KINDS.has(f.renderKind)) keys.push(...refIds(f.value));
    else if (NAMING_KINDS.has(f.renderKind) && typeof f.value === "string") {
      const key = drawnNameKey(f.value);
      if (key) keys.push(key);
    }
  }
  return [...new Set(keys)];
}

/** One effective property def, as the pod sends it. */
export interface WirePropertyDef {
  slug?: string;
  valueType?: string | null;
  targetProfileId?: string | null;
  uiHints?: Record<string, unknown> | null;
}

/**
 * The kind's entity-reference properties, for `suggestConnections`. The pod
 * resolves `targetProfileId` to `uiHints.linkedProfileSlug` at read time
 * (ProfileResolutionService.resolveLinkTargets); a def without it names no
 * target kind and suggests nothing.
 */
export function referencePropertiesFrom(
  defs: readonly unknown[] | undefined
): KindReferenceProperty[] {
  return (defs ?? []).flatMap((raw) => {
    const d = raw as WirePropertyDef;
    if (!d?.slug || d.valueType !== "entity_id") return [];
    const target = d.uiHints?.linkedProfileSlug;
    return typeof target === "string" && target
      ? [{ slug: d.slug, targetKind: target, relationType: null }]
      : [];
  });
}

export type ConnectionsState = "loading" | "failed" | "ready";

/**
 * The section's read state. A NOT_FOUND graph focus (a freshly made object
 * with no node yet) is an honest EMPTY, not a failure. Every other error is
 * FAILED — never read as "no connections" (empty ≠ failed). A failed REFETCH
 * over a good read keeps showing that read (it was true).
 */
export function connectionsState(read: {
  data: unknown;
  isError: boolean;
  error?: unknown;
}): { state: ConnectionsState; missing: boolean } {
  const code = (read.error as { data?: { code?: string } } | null | undefined)
    ?.data?.code;
  if (read.isError && code === "NOT_FOUND")
    return { state: "ready", missing: true };
  if (read.data === undefined) {
    return { state: read.isError ? "failed" : "loading", missing: false };
  }
  return { state: "ready", missing: false };
}

/** Wire → groups in one call (the adapters above + {@link groupConnections}). */
export function groupWireConnections(input: {
  neighbors: readonly WireGraphNeighbor[] | undefined;
  relationTypes: readonly WireRelationType[] | undefined;
  keyFactIds?: readonly string[];
  cap?: number;
}): GroupedConnections {
  return groupConnections({
    neighbors: toConnectionNeighbors(input.neighbors),
    relationTypes: toRelationTypeCatalog(input.relationTypes),
    keyFactIds: input.keyFactIds ?? [],
    ...(input.cap !== undefined ? { cap: input.cap } : {}),
  });
}

/** Suggested link targets for an entity with no connections, from its wire defs. */
export function suggestWireConnections(
  kind: string | null | undefined,
  defs: readonly unknown[] | undefined
): ConnectionSuggestion[] {
  if (!kind) return [];
  return suggestConnections(kind, {
    referenceProperties: referencePropertiesFrom(defs),
  });
}
