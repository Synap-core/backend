/**
 * Object-Graph Service — "graph by default" for ANY object kind.
 *
 * The read-side dual of Synap's homoiconic substrate: if everything is ONE
 * typed-JSON graph (entities + config/runtime nodes joined by `relations` and
 * `links`), then every READ should return the object PLUS its local neighbourhood
 * — what it is connected to, typed. One uniform envelope for entity / view /
 * channel / session / playbook / tool / skill / automation / project / document,
 * so a new object kind is a graph citizen for free (no new endpoint).
 *
 * This service owns the CONFIG/RUNTIME half (the `links` graph) + the per-kind
 * NAME/SUBTYPE hydrator — the piece that was missing (`getLinksFor` returned raw
 * edges, `getConnections` hydrated only entities). The ENTITY-DATA half
 * (relations + property + channel) stays in `relations.getConnections` and is
 * merged in at the route layer (which holds the tRPC ctx). Dependency-light like
 * `links-service`: userId-scoped, no governance/event side effects.
 *
 * See team/platform/playbooks-capability-substrate.mdx (the `links` mirror of
 * `relations`) + the homoiconic substrate white-paper.
 */

import {
  getDb,
  inArray,
  and,
  eq,
  ilike,
  entities,
  projects,
  views,
  channels,
  focusSessions,
  playbooks,
  tools,
  skills,
  capabilities,
  automations,
  documents,
  intelligenceCommands,
  loadFacetSlugsBatch,
} from "@synap/database";
import type { LinkEndpointType } from "@synap/playbooks";
import { getLinksFor } from "../links/links-service.js";
import { userVisibleWhere } from "../../utils/user-visible-where.js";

/**
 * Kinds the graph envelope can focus on. Superset of `LinkEndpointType` so
 * entity-data kinds (view, document) are addressable too — they hydrate via the
 * KIND_TABLE registry. ONE source of truth, shared by the REST route, the tRPC
 * procedure, and the MCP tool so the addressable surface can't drift.
 */
export const GRAPH_KINDS = [
  "entity",
  "project",
  "view",
  "channel",
  "session",
  "playbook",
  "tool",
  "skill",
  "automation",
  "document",
  "command",
  "source",
  "participant",
] as const;

export type GraphKind = (typeof GRAPH_KINDS)[number];

/**
 * Entity-backed kinds carry the relations/property/channel DATA graph on top of
 * their links graph — the caller folds in `getConnections` for these (it needs
 * the tRPC ctx, so it can't be fetched inside the dependency-light service).
 */
export const ENTITY_BACKED: ReadonlySet<string> = new Set([
  "entity",
  "project",
]);

/** A node in the pod graph — uniform across every object kind. */
export interface GraphNode {
  /** The object's table/kind (the link-endpoint type). */
  kind: string;
  /** The object's id (uuid or kind short-id). */
  id: string;
  /** Human-facing name — the handle you navigate by (id stays canonical). */
  name: string;
  /** In-kind discriminator: entity→profileSlug, view→viewType, tool/skill→kind… */
  subtype: string | null;
  /**
   * Same discriminator, pluralized: entity→[kind slug, ...facet slugs] (Kind+
   * Facets — an entity can carry multiple role-profiles), other kinds→[subtype]
   * or []. `subtype` is kept for compat; new consumers should prefer this.
   */
  subtypes: string[];
  workspaceId: string | null;
}

/** A neighbour = a node + the edge that connects it to the focused object. */
export interface GraphNeighbor extends GraphNode {
  /** linkType (config edge) or relationType (data edge). */
  edgeType: string;
  direction: "outgoing" | "incoming" | "structural";
  /** Which substrate the edge came from — glass-box provenance. */
  via: "links" | "relations" | "property" | "channel" | "session";
}

/** "Fetch X, get X + everything it's linked to, typed." */
export interface GraphEnvelope {
  object: GraphNode;
  neighbors: GraphNeighbor[];
  counts: {
    total: number;
    byKind: Record<string, number>;
    byVia: Record<string, number>;
  };
}

// ── Per-kind hydrator registry ───────────────────────────────────────────────
// The extensible heart: (kind, ids[]) → batch fetch name+subtype. One entry per
// table-backed kind; a new kind = one row here, and it's a graph citizen
// everywhere. The fall-through (raw-id node) is reserved for endpoint kinds that
// are NOT a single table: `participant` (a user/agent identity — its fromId is a
// userId/agentUserId, pod-global, scoped differently) and `source` (reserved in
// LinkEndpointType, no table/writer yet). Those still SHOW the edge, never drop
// it. Everything table-backed — including `command` (intelligence_commands) — is
// fully hydrated below.

interface KindSpec {
  table: any;
  name: string; // column name for the display name
  subtype?: string; // column name for the in-kind discriminator
}

/**
 * `project` is a `projects` table row — a first-class table, NOT an entity.
 */
const KIND_TABLE: Record<string, KindSpec> = {
  entity: { table: entities, name: "title", subtype: "type" },
  project: { table: projects, name: "name", subtype: "status" },
  view: { table: views, name: "name", subtype: "type" },
  channel: { table: channels, name: "title", subtype: "channelType" },
  session: { table: focusSessions, name: "goal" },
  playbook: { table: playbooks, name: "name" },
  tool: { table: tools, name: "name", subtype: "kind" },
  skill: { table: skills, name: "name", subtype: "kind" },
  capability: { table: capabilities, name: "name" },
  command: { table: intelligenceCommands, name: "title" },
  automation: { table: automations, name: "name", subtype: "triggerType" },
  document: { table: documents, name: "title", subtype: "type" },
};

/**
 * Batch-hydrate a set of (kind, id) refs into named nodes — ONE query per kind,
 * never N+1. Unknown/stub kinds resolve to a raw-id node (name = short id) so
 * the neighbour is still listed.
 */
export async function hydrateNodes(
  userId: string,
  refs: { kind: string; id: string }[]
): Promise<Map<string, GraphNode>> {
  const out = new Map<string, GraphNode>();
  if (refs.length === 0) return out;

  // Group ids by kind for one batched query per table.
  const idsByKind = new Map<string, Set<string>>();
  for (const r of refs) {
    let set = idsByKind.get(r.kind);
    if (!set) idsByKind.set(r.kind, (set = new Set()));
    set.add(r.id);
  }

  const db = await getDb();
  await Promise.all(
    [...idsByKind].map(async ([kind, idSet]) => {
      const ids = [...idSet];
      const spec = KIND_TABLE[kind];
      if (!spec) {
        // Stub kind — no table. Show the edge with a raw-id handle.
        for (const id of ids) {
          out.set(`${kind}:${id}`, {
            kind,
            id,
            name: id.length > 12 ? `${id.slice(0, 8)}…` : id,
            subtype: null,
            subtypes: [],
            workspaceId: null,
          });
        }
        return;
      }
      const t = spec.table;
      // SCOPE the hydration — an edge can be visible while its far endpoint lives
      // in a workspace the user can't see; without this AND, the neighbour's NAME
      // would leak. `userVisibleWhere` is the same floor every pod read uses.
      const rows = await db
        .select()
        .from(t)
        .where(
          and(inArray(t.id, ids), userVisibleWhere(t.workspaceId, userId))
        );

      // Entity kind carries facets on top of its base subtype (kind slug) —
      // batch-load live facet slugs for every entity in this group.
      const facetSlugsByEntity =
        kind === "entity" ? await loadFacetSlugs(db, ids) : null;

      for (const row of rows as Record<string, unknown>[]) {
        const id = row.id as string;
        const subtype = spec.subtype
          ? ((row[spec.subtype] as string | null) ?? null)
          : null;
        const subtypes = subtype ? [subtype] : [];
        if (facetSlugsByEntity)
          subtypes.push(...(facetSlugsByEntity.get(id) ?? []));
        out.set(`${kind}:${id}`, {
          kind,
          id,
          name: (row[spec.name] as string | null) ?? "(untitled)",
          subtype,
          subtypes,
          workspaceId: (row.workspaceId as string | null) ?? null,
        });
      }
    })
  );
  return out;
}

/**
 * Batch-load live facet (role-profile) slugs for a set of entity ids —
 * delegates to the canonical loadFacetSlugsBatch join in @synap/database.
 */
async function loadFacetSlugs(
  db: Awaited<ReturnType<typeof getDb>>,
  entityIds: string[]
): Promise<Map<string, string[]>> {
  return loadFacetSlugsBatch(db, entityIds);
}

/**
 * The CONFIG/RUNTIME neighbours of any object — `getLinksFor` edges hydrated to
 * typed nodes. The other endpoint of each edge (the side that isn't the focused
 * object) becomes a neighbour, tagged with its linkType + direction.
 */
export async function getLinkNeighbors(
  userId: string,
  kind: LinkEndpointType,
  id: string
): Promise<GraphNeighbor[]> {
  const edges = await getLinksFor(userId, kind, id);
  if (edges.length === 0) return [];

  // The "other" endpoint of each edge + the direction relative to the focus.
  const refs = edges.map((e) => {
    const outgoing = e.fromType === kind && e.fromId === id;
    return {
      kind: outgoing ? e.toType : e.fromType,
      id: outgoing ? e.toId : e.fromId,
      edgeType: e.linkType,
      direction: outgoing ? ("outgoing" as const) : ("incoming" as const),
    };
  });

  const nodes = await hydrateNodes(
    userId,
    refs.map((r) => ({ kind: r.kind, id: r.id }))
  );
  return refs.map((r) => {
    const node = nodes.get(`${r.kind}:${r.id}`);
    return {
      kind: r.kind,
      id: r.id,
      name: node?.name ?? r.id,
      subtype: node?.subtype ?? null,
      subtypes: node?.subtypes ?? [],
      workspaceId: node?.workspaceId ?? null,
      edgeType: r.edgeType,
      direction: r.direction,
      via: "links" as const,
    };
  });
}

/**
 * Map the ENTITY-DATA graph (`relations.getConnections` Connection rows) into the
 * uniform neighbour shape, so the route layer can fold it into the envelope. Pure
 * — the caller already fetched the connections (it holds the tRPC ctx). The
 * `source` discriminator becomes our `via`:
 *   graph            → relations
 *   property         → property
 *   thread           → channel  (channel_context_items: messages that touched entity)
 *   context_channel  → channel  (channels.contextObjectId: channel opened ON entity)
 *   focus_session    → session  (focus_sessions.subjectEntityId: session about entity)
 */
export function connectionsToNeighbors(
  connections: {
    entityId: string;
    entity?: {
      title?: string | null;
      type?: string | null;
      workspaceId?: string | null;
      /**
       * Live facet slugs (Kind+Facets), when the caller's Connection row
       * carries them. Optional — callers that don't load facets simply omit
       * it and `subtypes` falls back to `[type]`.
       */
      facetSlugs?: string[] | null;
    } | null;
    label: string;
    direction: "outgoing" | "incoming" | "structural";
    source:
      | "graph"
      | "property"
      | "thread"
      | "context_channel"
      | "focus_session";
    relationType?: string;
    propertySlug?: string;
    channelRelationshipType?: string;
    channelTitle?: string | null;
    focusSessionId?: string;
    focusSessionGoal?: string;
    focusSessionStatus?: string;
  }[]
): GraphNeighbor[] {
  return connections.map((c) => ({
    kind: "entity",
    id: c.entityId,
    name: c.entity?.title ?? c.label ?? c.entityId,
    subtype: c.entity?.type ?? null,
    subtypes: [
      ...(c.entity?.type ? [c.entity.type] : []),
      ...(c.entity?.facetSlugs ?? []),
    ],
    workspaceId: c.entity?.workspaceId ?? null,
    edgeType:
      c.relationType ?? c.propertySlug ?? c.channelRelationshipType ?? c.label,
    direction: c.direction,
    via:
      c.source === "graph"
        ? "relations"
        : c.source === "property"
          ? "property"
          : c.source === "focus_session"
            ? "session"
            : "channel",
  }));
}

/**
 * Assemble the uniform envelope: the focused object (hydrated) + its neighbours.
 * `extraNeighbors` lets the route layer fold in the ENTITY-DATA graph
 * (relations + property + channel from `getConnections`) for entity kinds —
 * that half needs the tRPC ctx, so it's injected, not fetched here.
 */
export async function getObjectGraph(
  userId: string,
  kind: LinkEndpointType,
  id: string,
  extraNeighbors: GraphNeighbor[] = []
): Promise<GraphEnvelope> {
  const [selfMap, linkNeighbors] = await Promise.all([
    hydrateNodes(userId, [{ kind, id }]),
    getLinkNeighbors(userId, kind, id),
  ]);

  const object: GraphNode = selfMap.get(`${kind}:${id}`) ?? {
    kind,
    id,
    name: id,
    subtype: null,
    subtypes: [],
    workspaceId: null,
  };

  // Merge config + data graphs; de-dup on (kind, id, edgeType, via) so an object
  // linked twice the same way isn't double-counted.
  const seen = new Set<string>();
  const neighbors: GraphNeighbor[] = [];
  for (const n of [...linkNeighbors, ...extraNeighbors]) {
    const key = `${n.kind}:${n.id}:${n.edgeType}:${n.via}`;
    if (seen.has(key)) continue;
    seen.add(key);
    neighbors.push(n);
  }

  const byKind: Record<string, number> = {};
  const byVia: Record<string, number> = {};
  for (const n of neighbors) {
    byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
    byVia[n.via] = (byVia[n.via] ?? 0) + 1;
  }

  return {
    object,
    neighbors,
    counts: { total: neighbors.length, byKind, byVia },
  };
}

/**
 * Name-addressing — resolve an object by its NAME (a handle), not its uuid.
 * Names aren't unique pod-wide, so this returns ALL matches (the caller / agent
 * disambiguates by subtype or count). Reuses the same KIND_TABLE registry as
 * hydration — one source of truth for "what column is this kind's name". Scoped
 * via `userVisibleWhere` so you can only resolve names you may see.
 *
 * `subtype` narrows further (entity profileSlug, view type, tool/skill kind).
 * Case-insensitive exact match on the name column. Stub kinds (no table) → [].
 */
export async function resolveByName(
  userId: string,
  kind: string,
  name: string,
  subtype?: string,
  limit = 10
): Promise<GraphNode[]> {
  const spec = KIND_TABLE[kind];
  if (!spec) return [];
  const t = spec.table;
  const db = await getDb();

  const conds = [
    userVisibleWhere(t.workspaceId, userId),
    ilike(t[spec.name], name),
  ];
  if (subtype && spec.subtype) conds.push(eq(t[spec.subtype], subtype));

  const rows = await db
    .select()
    .from(t)
    .where(and(...conds))
    .limit(limit);

  return (rows as Record<string, unknown>[]).map((row) => {
    const rowSubtype = spec.subtype
      ? ((row[spec.subtype] as string | null) ?? null)
      : null;
    return {
      kind,
      id: row.id as string,
      name: (row[spec.name] as string | null) ?? "(untitled)",
      subtype: rowSubtype,
      subtypes: rowSubtype ? [rowSubtype] : [],
      workspaceId: (row.workspaceId as string | null) ?? null,
    };
  });
}
