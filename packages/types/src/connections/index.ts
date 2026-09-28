/**
 * Connections — THE one rule for how an entity's named ties are grouped,
 * labelled and ordered, shared by web (browser entity page) and phone (relay).
 *
 * Neither surface may fork a RULE (CLAUDE.md), so both map their graph read
 * into {@link ConnectionNeighbor} and call {@link groupConnections}; no mirror,
 * no convergence tripwire needed. Pure and dependency-free apart from the
 * vocabulary leaf — every human word comes from `../vocabulary`, never a local
 * label map.
 *
 * The rule (C-design §3, founder-accepted defaults):
 *   1. PROVENANCE is split out — the capture it was made from, the session it
 *      happened in, the proposal that governed it, its rooms. Those are "where
 *      did it come from", read as a quiet line / the Why pane, never a group.
 *   2. A neighbour already drawn as a KEY FACT on the card is dropped — render
 *      each piece of state once.
 *   3. Data edges group by `(edgeType, direction)`. A symmetric (non-directional)
 *      type merges both directions into one group.
 *   4. Label = def `displayName` outgoing, `inverseLabel` incoming; with no
 *      inverse label an incoming directional group keeps the forward label and
 *      is flagged `reversed` (the renderer draws the arrow mark) — a forward
 *      label read from the wrong end is never presented as if it were right.
 *      Unknown slugs humanize, never leak.
 *   5. Order: groups of people, then groups of organisations, then everything
 *      else; within a rank by count desc, then label alpha. Untyped edges last.
 */

import {
  humanizeToken,
  normalizeObjectKind,
  resolveObjectNoun,
} from "../vocabulary/index.js";

export type ConnectionDirection = "outgoing" | "incoming" | "structural";

/**
 * The minimal neighbour shape both reads map to. Web: `graph.getObjectGraph`
 * neighbours map 1:1 (`kind/subtype/edgeType/direction/via`). Relay: the same
 * read (`useMadeFrom` already uses it).
 */
export interface ConnectionNeighbor {
  id: string;
  name: string;
  /** The graph kind of the far end (`entity`, `session`, `capture`, …). */
  kind: string;
  /** In-kind discriminator — for an entity, its profile slug (`person`, …). */
  subtype?: string | null;
  /** Relation slug / property slug / link type. */
  edgeType: string;
  direction: ConnectionDirection;
  /** Which substrate the edge came from (`relations`, `property`, `links`, `governed`, …). */
  via?: string | null;
  /** Caller override: force this edge into provenance. */
  isProvenance?: boolean;
}

/** One relation-type catalog row (`relations.listTypes` / `relationDefs.list`). */
export interface ConnectionRelationType {
  slug: string;
  displayName?: string | null;
  inverseLabel?: string | null;
  /** `false` = symmetric (both directions read the same). Unknown ⇒ directional. */
  isDirectional?: boolean | null;
}

export interface ConnectionItem {
  id: string;
  name: string;
  /** The OBJECT kind to route/identify by: an entity's profile slug, else the graph kind. */
  kind: string;
  /** The graph kind (routing table key). */
  graphKind: string;
  edgeType: string;
  direction: ConnectionDirection;
  via: string | null;
}

export interface ConnectionGroup {
  /** Stable key: `${edgeType}:${direction}` (`:both` for a merged symmetric type). */
  key: string;
  label: string;
  edgeType: string;
  direction: ConnectionDirection | "both";
  /** Incoming directional edge with no inverse label — draw a reversed mark. */
  reversed: boolean;
  items: ConnectionItem[];
  /** Count before the caller's cap. */
  total: number;
}

export interface ConnectionProvenance {
  /** The capture this was made from (incoming `produced` edge from a capture). */
  madeFrom: ConnectionItem | null;
  /** The session the work happened in. */
  inSession: ConnectionItem | null;
  /** Every provenance edge, in input order — the Why pane body. */
  all: ConnectionItem[];
}

export interface GroupConnectionsInput {
  neighbors: readonly ConnectionNeighbor[];
  relationTypes?: readonly ConnectionRelationType[];
  /** Entity ids already drawn as key facts on the card. */
  keyFactIds?: Iterable<string>;
  /** Max items per group (total still counts all). Omit for no cap. */
  cap?: number;
}

export interface GroupedConnections {
  provenance: ConnectionProvenance;
  groups: ConnectionGroup[];
  /** Data edges remaining after provenance + key facts are removed. */
  total: number;
}

/**
 * Substrates that describe WHERE an object came from, not what it is tied to.
 * `links` is data EXCEPT its `produced` edge (the capture/session lineage).
 */
const PROVENANCE_VIAS: ReadonlySet<string> = new Set([
  "governed",
  "produced-in",
  "body",
  "channel",
  "session",
]);
const PRODUCED_EDGE = "produced";
const CAPTURE_KIND = "capture";

export function isProvenanceEdge(n: ConnectionNeighbor): boolean {
  if (n.isProvenance) return true;
  if (n.via && PROVENANCE_VIAS.has(n.via)) return true;
  return n.via === "links" && n.edgeType === PRODUCED_EDGE;
}

/**
 * Party rank for ordering: people first, organisations second. A RANK, not a
 * label map — the words still come from the vocabulary. Keyed on the
 * normalized kind so aliases (`contact`, `companies`) land on their kind.
 */
export const CONNECTION_PARTY_RANK: Readonly<Record<string, number>> = {
  person: 0,
  contact: 0,
  company: 1,
  organization: 1,
  organisation: 1,
};
const OTHER_RANK = 2;

function partyRank(kind: string): number {
  return CONNECTION_PARTY_RANK[normalizeObjectKind(kind)] ?? OTHER_RANK;
}

function toItem(n: ConnectionNeighbor): ConnectionItem {
  const subtype = n.subtype?.trim();
  return {
    id: n.id,
    name: n.name,
    kind: n.kind === "entity" && subtype ? subtype : n.kind,
    graphKind: n.kind,
    edgeType: n.edgeType,
    direction: n.direction,
    via: n.via ?? null,
  };
}

/** Label + reversed flag for a (type, direction) from THIS side. */
export function resolveConnectionLabel(
  edgeType: string,
  direction: ConnectionDirection | "both",
  def: ConnectionRelationType | undefined
): { label: string; reversed: boolean } {
  const forward = def?.displayName?.trim() || humanizeToken(edgeType);
  if (direction !== "incoming") return { label: forward, reversed: false };
  const inverse = def?.inverseLabel?.trim();
  if (inverse) return { label: inverse, reversed: false };
  // Symmetric type: the forward label is true from both ends.
  if (def && def.isDirectional === false) {
    return { label: forward, reversed: false };
  }
  return { label: forward, reversed: true };
}

export function groupConnections(
  input: GroupConnectionsInput
): GroupedConnections {
  const defs = new Map<string, ConnectionRelationType>();
  for (const d of input.relationTypes ?? []) defs.set(d.slug, d);
  const keyFacts = new Set(input.keyFactIds ?? []);

  const provenance: ConnectionProvenance = {
    madeFrom: null,
    inSession: null,
    all: [],
  };

  // A relation and the entity_id property that auto-created it name the SAME
  // tie — keep the relation, drop the property twin (render once).
  const relationPairs = new Set(
    input.neighbors
      .filter((n) => n.via === "relations")
      .map((n) => `${n.id}:${n.direction}`)
  );

  const buckets = new Map<
    string,
    {
      edgeType: string;
      direction: ConnectionDirection | "both";
      items: ConnectionItem[];
      seen: Set<string>;
    }
  >();

  for (const n of input.neighbors) {
    if (isProvenanceEdge(n)) {
      const item = toItem(n);
      provenance.all.push(item);
      if (
        !provenance.madeFrom &&
        n.edgeType === PRODUCED_EDGE &&
        n.direction === "incoming" &&
        n.kind === CAPTURE_KIND
      ) {
        provenance.madeFrom = item;
      } else if (
        !provenance.inSession &&
        n.kind === "session" &&
        (n.via === "produced-in" || n.edgeType === PRODUCED_EDGE)
      ) {
        provenance.inSession = item;
      }
      continue;
    }
    if (keyFacts.has(n.id)) continue;
    if (n.via === "property" && relationPairs.has(`${n.id}:${n.direction}`)) {
      continue;
    }

    const edgeType = n.edgeType?.trim() ?? "";
    const def = defs.get(edgeType);
    const direction: ConnectionDirection | "both" =
      def && def.isDirectional === false && n.direction !== "structural"
        ? "both"
        : n.direction;
    const key = `${edgeType}:${direction}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { edgeType, direction, items: [], seen: new Set() };
      buckets.set(key, bucket);
    }
    if (bucket.seen.has(n.id)) continue;
    bucket.seen.add(n.id);
    bucket.items.push(toItem(n));
  }

  const cap = input.cap;
  const ranked = [...buckets.entries()].map(([key, b]) => {
    const untyped = b.edgeType === "";
    const { label, reversed } = untyped
      ? { label: "Also linked", reversed: false }
      : resolveConnectionLabel(b.edgeType, b.direction, defs.get(b.edgeType));
    // A group ranks as people only if EVERY item is a person (max, not min):
    // one person among ten tasks must not float a "Relates to" group first.
    const rank = untyped
      ? OTHER_RANK + 1
      : Math.max(...b.items.map((i) => partyRank(i.kind)));
    const group: ConnectionGroup = {
      key,
      label,
      edgeType: b.edgeType,
      direction: b.direction,
      reversed,
      items: cap !== undefined ? b.items.slice(0, Math.max(0, cap)) : b.items,
      total: b.items.length,
    };
    return { group, rank };
  });

  ranked.sort(
    (a, b) =>
      a.rank - b.rank ||
      b.group.total - a.group.total ||
      a.group.label.localeCompare(b.group.label)
  );

  const groups = ranked.map((r) => r.group);
  return {
    provenance,
    groups,
    total: groups.reduce((sum, g) => sum + g.total, 0),
  };
}

// ── Suggestions for an EMPTY entity (C-design §3 "EMPTY (INVITE)") ──────────

/** A kind's entity_id property def (`valueType=entity_id` + `targetProfileId`). */
export interface KindReferenceProperty {
  slug: string;
  /** Profile slug the property points at (resolved from `targetProfileId`). */
  targetKind?: string | null;
  /** The relation def the property auto-creates (`relationDefId` → slug). */
  relationType?: string | null;
  /** Profile slug that owns the property; when set and ≠ kind, it is skipped. */
  ownerKind?: string | null;
}

export interface ConnectionSuggestionCatalog {
  referenceProperties?: readonly KindReferenceProperty[];
}

/** How peers of this kind are connected (aggregated by the caller). */
export interface PeerConnectionUsage {
  edgeType: string;
  targetKind: string;
  count: number;
}

export interface ConnectionSuggestion {
  /** "Company" — the target noun; the renderer adds the `+` mark. */
  label: string;
  targetKind: string;
  relationType: string | null;
  propertySlug: string | null;
  source: "property" | "peers";
}

export const MAX_CONNECTION_SUGGESTIONS = 3;

/**
 * 1–3 suggested link targets for an entity with no connections: the kind's own
 * reference properties first (the schema says so), then relation types its
 * peers actually use (by count). One suggestion per target kind. No input ⇒ [].
 */
export function suggestConnections(
  kind: string,
  catalog: ConnectionSuggestionCatalog,
  peerUsage: readonly PeerConnectionUsage[] = []
): ConnectionSuggestion[] {
  const out: ConnectionSuggestion[] = [];
  const seen = new Set<string>();
  const self = normalizeObjectKind(kind);

  for (const p of catalog.referenceProperties ?? []) {
    if (out.length >= MAX_CONNECTION_SUGGESTIONS) break;
    if (p.ownerKind && normalizeObjectKind(p.ownerKind) !== self) continue;
    const target = p.targetKind?.trim();
    if (!target) continue;
    const key = normalizeObjectKind(target);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      label: resolveObjectNoun(target),
      targetKind: target,
      relationType: p.relationType ?? null,
      propertySlug: p.slug,
      source: "property",
    });
  }

  const peers = [...peerUsage]
    .filter((u) => u.count > 0 && u.targetKind?.trim())
    .sort(
      (a, b) =>
        b.count - a.count ||
        a.targetKind.localeCompare(b.targetKind) ||
        a.edgeType.localeCompare(b.edgeType)
    );
  for (const u of peers) {
    if (out.length >= MAX_CONNECTION_SUGGESTIONS) break;
    const key = normalizeObjectKind(u.targetKind);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      label: resolveObjectNoun(u.targetKind),
      targetKind: u.targetKind,
      relationType: u.edgeType || null,
      propertySlug: null,
      source: "peers",
    });
  }
  return out;
}
