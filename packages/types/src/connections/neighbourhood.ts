/**
 * Node neighbourhood — THE one role table for "where does each tie of this
 * object sit", shared by the browser Navigator canvas, the browser Why spine
 * (`LineageSection`), and relay's node page.
 *
 * Every neighbour the graph door returns (`graph.getObjectGraph` →
 * `neighbors[]`) lands in exactly ONE of six zones, read from the FOCUSED
 * object's side:
 *
 *   cameFrom         what made it / what it was made from (provenance)
 *   became           what it made, spawned, promoted into, runs
 *   blockedBy        what it waits on
 *   servesAndBlocks  what it serves, is part of, or blocks
 *   workingOnIt      the work pointed AT it — sessions / tracks / rules / runs
 *                    whose edge targets, is about, serves, is part of or
 *                    activates it
 *   related          everything else, labelled by its edge
 *
 * The role of an edge is a function of (substrate, edge type, direction) only —
 * plus, for the `work` rule, whether the far end is a WORKER kind. It is
 * DECLARED per edge type in three tables below (stored `links` types, the
 * default `relations` defs, and the read-time `via` substrates). Each table's
 * key set is pinned to its source union by a compile-time coverage floor in the
 * pod (`api/src/services/object-graph/edge-role-coverage.ts`): adding a
 * `LinkType`, a default relation def or a `via` without classifying it here
 * stops the build. An UNKNOWN edge at runtime (a user-defined relation slug)
 * reads as `related` — never dropped, never a crash.
 *
 * Pure and dependency-free apart from the vocabulary leaf: every human word
 * comes from `../vocabulary` (`resolveLineageEdgeLabel`, `humanizeToken`,
 * `resolveProposalKindLabel`) or the relation def catalog — no local label map.
 */

import {
  LINEAGE_EDGE_LABELS,
  humanizeToken,
  resolveLineageEdgeLabel,
  resolveProposalKindLabel,
} from "../vocabulary/index.js";
import {
  resolveConnectionLabel,
  type ConnectionDirection,
  type ConnectionRelationType,
} from "./index.js";
import {
  toConnectionNeighbors,
  toRelationTypeCatalog,
  type WireGraphNeighbor,
  type WireRelationType,
} from "./wire.js";
import { isDependencyEndpointKind } from "./dependency.js";
import {
  neighbourUnitState,
  neighboursBlockedByFocus,
} from "./neighbour-state.js";
import type { UnitStateView } from "../units/state.js";

/** The six zones, in the Navigator's reading order. */
export const NODE_ZONES = [
  "cameFrom",
  "became",
  "blockedBy",
  "servesAndBlocks",
  "workingOnIt",
  "related",
] as const;
export type NodeZone = (typeof NODE_ZONES)[number];

/** Items per zone before "Show all N" (ui-composition §4). */
export const NODE_ZONE_CAP = 5;

/**
 * What a zone answers when it is EMPTY (ui-composition §2). Only two answers
 * occur: a zone the person cannot fill from the node page OMITS (absence
 * already says zero); "Blocked by" REASSURES — nothing waiting is the good
 * outcome — but only on a focus that can be blocked ({@link nodeZoneEmpty}).
 * The whole neighbourhood empty is each host's own INVITE, not a zone answer.
 */
export type NodeZoneEmpty =
  | { readonly answer: "omit" }
  | { readonly answer: "reassure"; readonly title: string };

export interface NodeZoneSpec {
  /** Section heading — product copy, the same on every surface. */
  readonly heading: string;
  readonly empty: NodeZoneEmpty;
}

const OMIT: NodeZoneEmpty = { answer: "omit" };

/**
 * THE zone headings + empty answers, for the browser Navigator / `ObjectGraph`
 * stack AND relay's node page — one table, so the two surfaces cannot name a
 * zone differently. Paired readings: Came from / Became (lineage, both ends),
 * Blocked by / Serves & blocks (the dependency edge, both ends). Keyed by
 * `NodeZone` (`satisfies Record<NodeZone, …>`), so a seventh zone that is not
 * named here stops the build.
 */
export const NODE_ZONE_SPECS = {
  cameFrom: { heading: "Came from", empty: OMIT },
  became: { heading: "Became", empty: OMIT },
  blockedBy: {
    heading: "Blocked by",
    empty: { answer: "reassure", title: "Nothing blocks it" },
  },
  servesAndBlocks: { heading: "Serves & blocks", empty: OMIT },
  workingOnIt: { heading: "Working on it", empty: OMIT },
  related: { heading: "Related", empty: OMIT },
} as const satisfies Record<NodeZone, NodeZoneSpec>;

/** Heading per zone — DERIVED from {@link NODE_ZONE_SPECS}, never a second table. */
export const NODE_ZONE_HEADINGS = Object.fromEntries(
  NODE_ZONES.map((zone) => [zone, NODE_ZONE_SPECS[zone].heading])
) as Readonly<Record<NodeZone, string>>;

/**
 * The read state of a node neighbourhood — ONE rule for every surface:
 *
 *   failed   the graph read failed (anything but NOT_FOUND)
 *   missing  the graph said NOT_FOUND: the object does not exist or is not
 *            visible — a different answer from "it has no ties"
 *   loading  the graph is in flight, OR it landed but the relation vocabulary
 *            is still pending (zone placement and labels read the vocabulary;
 *            drawing before it lands paints user relations as "Related" and
 *            then moves them). A FAILED vocabulary read does not hold the page:
 *            the zones fall back to humanized slugs.
 *   ready    draw the zones
 */
export type NodeNeighbourhoodState = "loading" | "failed" | "missing" | "ready";

export function nodeNeighbourhoodState(input: {
  query: {
    isError: boolean;
    isLoading?: boolean;
    hasData: boolean;
    /** The tRPC error code (`error.data.code`) when `isError`. */
    errorCode?: string | null;
  };
  vocab: { pending: boolean };
}): NodeNeighbourhoodState {
  const { query, vocab } = input;
  if (query.isError)
    return query.errorCode === "NOT_FOUND" ? "missing" : "failed";
  if (query.isLoading || !query.hasData) return "loading";
  if (vocab.pending) return "loading";
  return "ready";
}

/**
 * The empty answer of `zone` for THIS focus. "Nothing blocks it" is only true
 * news about a unit of work: a session or track, or an entity carrying a
 * `status` (a task, a deal). On a person or a note it is noise — OMIT.
 * `focus.status`: the envelope object's raw status (`undefined` = not read).
 */
export function nodeZoneEmpty(
  zone: NodeZone,
  focus: { kind: string; status?: string | null } | null | undefined
): NodeZoneEmpty {
  const spec: NodeZoneSpec = NODE_ZONE_SPECS[zone];
  if (spec.empty.answer !== "reassure") return spec.empty;
  if (!focus || !isDependencyEndpointKind(focus.kind)) return OMIT;
  if (focus.kind === "entity" && !focus.status) return OMIT;
  return spec.empty;
}

/**
 * Where the far end lands for one direction. `work` = `workingOnIt` when the
 * far end is a {@link NODE_WORKER_KINDS worker}, else `related` — a capability's
 * member tools are its parts, not work on it; a session member of a track is.
 */
export type EdgeZoneRule = NodeZone | "work";

export interface EdgeRole {
  /** The focus is the edge's FROM end; the neighbour is its TO end. */
  readonly outgoing: EdgeZoneRule;
  /** The focus is the edge's TO end; the neighbour is its FROM end. */
  readonly incoming: EdgeZoneRule;
  /**
   * Part of the entity page's quiet provenance line (`isProvenanceEdge`) — the
   * connections rule reads this flag from here, so the two models cannot
   * disagree on what "where it came from" is.
   */
  readonly provenance?: true;
}

/** A tie that carries no lineage, dependency or work meaning. */
const RELATED: EdgeRole = { outgoing: "related", incoming: "related" };

/**
 * Kinds that DO work. An incoming `work` edge from one of these reads
 * "Working on it"; from anything else it reads "Related".
 */
export const NODE_WORKER_KINDS: ReadonlySet<string> = new Set([
  "session",
  "track",
  "project",
  "automation",
  "run",
  "agent",
]);

/**
 * Stored `links` edge types (`LinkType`, schema `links.ts`). Read as
 * `from --type--> to`. Key set pinned to `LinkType` at compile time.
 */
export const LINK_EDGE_ROLES = {
  grants: RELATED,
  requires: RELATED,
  // session --instantiated_from--> playbook
  instantiated_from: { outgoing: "cameFrom", incoming: "became" },
  // session --used--> tool: a tool the run touched, not lineage.
  used: RELATED,
  // session|project --targets--> entity|project
  targets: { outgoing: "servesAndBlocks", incoming: "work" },
  // document|session --produced--> entity: the lineage edge.
  produced: { outgoing: "became", incoming: "cameFrom", provenance: true },
  // tool --member_of--> capability, automation --member_of--> playbook,
  // session|track --member_of--> track|project (the `structure` FK fold).
  member_of: { outgoing: "servesAndBlocks", incoming: "work" },
  feeds: RELATED,
  // session --promoted_to--> playbook
  promoted_to: { outgoing: "became", incoming: "cameFrom" },
  provided_by: RELATED,
  about: { outgoing: "related", incoming: "work" },
  documents: RELATED,
  concerns: RELATED,
  // automation --activates--> playbook: the rule runs it.
  activates: { outgoing: "became", incoming: "work" },
  // session --spawned_from--> session (fork / rerun)
  spawned_from: { outgoing: "cameFrom", incoming: "became" },
  provides_credential: RELATED,
  // X --blocked_by--> Y: X waits on Y.
  blocked_by: { outgoing: "blockedBy", incoming: "servesAndBlocks" },
  // A --replaces--> B: A is the attempt that took B's place. Neither end waits
  // on the other, so it is a plain tie ("Replaces" / "Replaced by").
  replaces: RELATED,
  uses: RELATED,
  // participant(agent) --dispatched_via--> tool: the agent's dispatch binding
  // — configuration of how it is reached, not work or lineage.
  dispatched_via: RELATED,
} as const satisfies Readonly<Record<string, EdgeRole>>;

/**
 * Default `relations` defs (`DEFAULT_RELATION_DEFS` + `SYSTEM_RELATION_TYPES`).
 * Key set pinned to those slugs at compile time. A workspace-defined slug that
 * is not here is `related`.
 */
export const RELATION_EDGE_ROLES = {
  assigned_to: RELATED,
  // A --blocks--> B: B waits on A.
  blocks: { outgoing: "servesAndBlocks", incoming: "blockedBy" },
  // A --depends_on--> B: A waits on B.
  depends_on: { outgoing: "blockedBy", incoming: "servesAndBlocks" },
  relates_to: RELATED,
  mentions: RELATED,
  links_to: RELATED,
  // parent --parent_of--> child: from the child, the parent is what it is part of.
  parent_of: { outgoing: "related", incoming: "servesAndBlocks" },
  tagged_with: RELATED,
  created_by: RELATED,
  attended_by: RELATED,
  belongs_to_project: { outgoing: "servesAndBlocks", incoming: "related" },
  founder_brand_of: RELATED,
  references: RELATED,
  works_at: RELATED,
  deal_for: RELATED,
  advances: { outgoing: "servesAndBlocks", incoming: "work" },
  met_at: RELATED,
  // person --works_on--> X: a PERSON is not a worker kind, but this edge says
  // outright that they work on it.
  works_on: { outgoing: "servesAndBlocks", incoming: "workingOnIt" },
  has_skill: RELATED,
  affiliated_with: RELATED,
  knows: RELATED,
  discussed_with: RELATED,
  embedded_in: RELATED,
  visualized_in: RELATED,
} as const satisfies Readonly<Record<string, EdgeRole>>;

/**
 * The read-time substrates (`GraphNeighbor["via"]`). `"edgeType"` defers to the
 * per-type table of that substrate. Key set pinned to the `via` union at compile
 * time.
 */
export const VIA_EDGE_ROLES = {
  links: "edgeType",
  relations: "edgeType",
  // An entity_id property value — a typed reference, no lineage meaning.
  property: RELATED,
  // A room that touched it / was opened on it.
  channel: { ...RELATED, provenance: true },
  // focus_sessions.subjectEntityId — a session ABOUT this entity.
  session: {
    outgoing: "workingOnIt",
    incoming: "workingOnIt",
    provenance: true,
  },
  // vault_grants bindings (agent ↔ tool/skill/command).
  grant: RELATED,
  // automations.createdBy — what an agent authored.
  automation: { outgoing: "became", incoming: "cameFrom" },
  // incoming: the proposal that authorized a change to it (events spine /
  // receipt). outgoing (a PROPOSAL focus): what that proposal governed.
  governed: { outgoing: "became", incoming: "cameFrom", provenance: true },
  // The session the change happened in (events spine).
  "produced-in": {
    outgoing: "cameFrom",
    incoming: "cameFrom",
    provenance: true,
  },
  // entities.documentId — the entity this document is the body of.
  body: { ...RELATED, provenance: true },
  // Plain FK columns read as edges (track ↔ project / sessions / playbook,
  // run → automation / subject). Their edge types reuse the links vocabulary.
  structure: "edgeType",
} as const satisfies Readonly<Record<string, EdgeRole | "edgeType">>;

type ViaKey = keyof typeof VIA_EDGE_ROLES;

function viaRule(
  via: string | null | undefined
): EdgeRole | "edgeType" | undefined {
  return via && Object.prototype.hasOwnProperty.call(VIA_EDGE_ROLES, via)
    ? VIA_EDGE_ROLES[via as ViaKey]
    : undefined;
}

function lookup<T extends object>(table: T, key: string): EdgeRole | undefined {
  return Object.prototype.hasOwnProperty.call(table, key)
    ? (table as Record<string, EdgeRole>)[key]
    : undefined;
}

/**
 * The role of one edge, from its substrate + type. An unknown substrate or an
 * unclassified type (a workspace-defined relation slug) ⇒ `related`.
 */
export function edgeRoleOf(
  via: string | null | undefined,
  edgeType: string | null | undefined
): EdgeRole {
  const rule = viaRule(via);
  if (rule === undefined) return RELATED;
  if (rule !== "edgeType") return rule;
  const table = via === "relations" ? RELATION_EDGE_ROLES : LINK_EDGE_ROLES;
  return lookup(table, edgeType?.trim() ?? "") ?? RELATED;
}

/** Whether this edge belongs to the quiet "where it came from" provenance line. */
export function isProvenanceRole(
  via: string | null | undefined,
  edgeType: string | null | undefined
): boolean {
  return edgeRoleOf(via, edgeType).provenance === true;
}

function resolveZone(rule: EdgeZoneRule, farGraphKind: string): NodeZone {
  if (rule !== "work") return rule;
  return NODE_WORKER_KINDS.has(farGraphKind) ? "workingOnIt" : "related";
}

/** The zone a neighbour lands in, from the focus's side. */
export function zoneOf(n: {
  kind: string;
  edgeType?: string | null;
  direction?: string | null;
  via?: string | null;
}): NodeZone {
  const role = edgeRoleOf(n.via, n.edgeType);
  if (n.direction === "incoming") return resolveZone(role.incoming, n.kind);
  if (n.direction === "outgoing") return resolveZone(role.outgoing, n.kind);
  // `structural` (or unknown): only a direction-free role places it.
  return role.incoming === role.outgoing
    ? resolveZone(role.outgoing, n.kind)
    : "related";
}

/**
 * "Powered by" — the substrate an object runs ON: a capability reached through
 * a grant, or a tool / skill reached through a stored link. Orthogonal to the
 * zone (the Why spine draws it as its own group); moved here from the browser's
 * retired `lineage-model.ts` so there is one copy of the rule.
 */
export function isPoweredByEdge(n: {
  kind: string;
  via?: string | null;
}): boolean {
  if (n.via === "grant" && n.kind === "capability") return true;
  return n.via === "links" && (n.kind === "tool" || n.kind === "skill");
}

export interface NodeNeighbourItem {
  id: string;
  /** The OBJECT kind to name/draw by: an entity's profile slug, else the graph kind. */
  kind: string;
  /** The graph kind — the route-table key (`objectNavTarget` / `objectRouteFor`). */
  graphKind: string;
  subtype: string | null;
  title: string;
  edgeType: string;
  direction: ConnectionDirection;
  via: string | null;
  zone: NodeZone;
  /** The edge, read from the focus's side, from the vocabulary / def catalog. */
  label: string;
  /**
   * An incoming directional edge with no curated inverse label: `label` is the
   * FORWARD reading, so the renderer draws the reversed-arrow mark (the
   * connections rule's convention) instead of presenting it as if it were right.
   */
  reversed: boolean;
  /** See {@link isPoweredByEdge}. */
  poweredBy: boolean;
  /** The far end's raw lifecycle status; `null` = none or not read. */
  status: string | null;
  /** The far end's last change, ISO-8601; `null` = none or not read. */
  updatedAt: string | null;
  /**
   * The far end's STATE MARK through the one derivation
   * ({@link neighbourUnitState} → `resolveUnitState`), including `blocked`
   * when it waits on the focus while the focus is open. `null` = its
   * lifecycle alone settles nothing — draw no mark, never a guess.
   */
  state: UnitStateView | null;
  /**
   * The far end is on the edge but the reader cannot see it. `title` is then
   * {@link hiddenNeighbourTitle}, and status / state are withheld (a hidden
   * blocker never reveals whether it is done). It still counts where it sits —
   * a hidden blocker still blocks — and the owner of the waiting end may
   * remove the edge (the pod floors that delete on the waiting end only).
   */
  hidden?: true;
}

/** What a hidden far end is called — never its name, never its state. */
export function hiddenNeighbourTitle(zone: NodeZone): string {
  return zone === "blockedBy" ? "Hidden blocker" : "Hidden item";
}

export interface NodeZoneSlice {
  /** At most `cap` items, in input order. */
  items: NodeNeighbourItem[];
  /** Count before the cap — "Show all N". */
  total: number;
}

export type NodeNeighbourhood = Record<NodeZone, NodeZoneSlice> & {
  /** Distinct neighbours across every zone. */
  total: number;
};

export interface NodeFocus {
  kind: string;
  id: string;
  /**
   * The focus's raw status (the envelope `object.status`). Only when it was
   * READ (`!== undefined`) can a neighbour be marked blocked BY the focus.
   */
  status?: string | null;
  /** The focus's name — what a blocked neighbour waits on. */
  title?: string | null;
}

export interface DeriveNodeNeighbourhoodOptions {
  /** `relations.listTypes` rows — labels relation edges from this side. */
  relationTypes?: readonly WireRelationType[];
  /** Items kept per zone (total still counts all). Default {@link NODE_ZONE_CAP}. */
  cap?: number;
}

/**
 * When the same far end reaches the focus by several edges, it renders ONCE,
 * in the zone that says the most: a dependency first, then lineage, then what
 * it serves, then work, then a plain tie.
 */
const ZONE_PRECEDENCE: readonly NodeZone[] = [
  "blockedBy",
  "cameFrom",
  "became",
  "servesAndBlocks",
  "workingOnIt",
  "related",
];

function labelFor(
  via: string | null,
  edgeType: string,
  direction: ConnectionDirection,
  defs: ReadonlyMap<string, ConnectionRelationType>
): { label: string; reversed: boolean } {
  if (via === "relations" || via === "property") {
    return resolveConnectionLabel(edgeType, direction, defs.get(edgeType));
  }
  if (via === "governed") {
    // The proposal that touched it: its edgeType is the proposal TYPE.
    return { label: resolveProposalKindLabel(edgeType), reversed: false };
  }
  const rule = viaRule(via);
  if (rule !== undefined && rule !== "edgeType") {
    // Derived substrates name their edge from the focus's side already
    // (`produced_in`, `granted_to`, `documentId`, `created`).
    return { label: humanizeToken(edgeType), reversed: false };
  }
  // Stored link types (and the track fold, which reuses their vocabulary).
  if (direction === "incoming") {
    const curated = LINEAGE_EDGE_LABELS[edgeType.toLowerCase()]?.incoming;
    return curated
      ? { label: curated, reversed: false }
      : {
          label: resolveLineageEdgeLabel(edgeType, "outgoing"),
          reversed: true,
        };
  }
  return {
    label: resolveLineageEdgeLabel(edgeType, "outgoing"),
    reversed: false,
  };
}

/**
 * Fold a graph read into the six zones. `wireEdges` is `getObjectGraph`'s
 * `neighbors` as the wire sends them; the focus itself (a self-loop) is never
 * its own neighbour.
 */
export function deriveNodeNeighbourhood(
  focus: NodeFocus | null | undefined,
  wireEdges: readonly WireGraphNeighbor[] | undefined,
  options: DeriveNodeNeighbourhoodOptions = {}
): NodeNeighbourhood {
  const cap = options.cap ?? NODE_ZONE_CAP;
  const defs = new Map<string, ConnectionRelationType>();
  for (const d of toRelationTypeCatalog(options.relationTypes)) {
    defs.set(d.slug, d);
  }
  const neighbors = toConnectionNeighbors(wireEdges);

  // A relation and the entity_id property that auto-created it name the SAME
  // tie — keep the relation (the connections rule's render-once, reused).
  const relationPairs = new Set(
    neighbors
      .filter((n) => n.via === "relations")
      .map((n) => `${n.id}:${n.direction}`)
  );

  // Rows that wait on the focus while it is still open — the dependency rule.
  const blockedByFocus = focus
    ? neighboursBlockedByFocus(
        focus,
        neighbors.map((n) => ({
          graphKind: n.kind,
          id: n.id,
          edgeType: n.edgeType?.trim() ?? "",
          direction: n.direction,
          via: n.via ?? null,
          ...(n.status !== undefined ? { status: n.status } : {}),
        }))
      )
    : new Set<string>();
  const focusName = focus?.title?.trim() || "this";

  const best = new Map<string, NodeNeighbourItem>();
  const order: string[] = [];
  for (const n of neighbors) {
    if (focus && n.kind === focus.kind && n.id === focus.id) continue;
    if (n.via === "property" && relationPairs.has(`${n.id}:${n.direction}`)) {
      continue;
    }
    const edgeType = n.edgeType?.trim() ?? "";
    const via = n.via ?? null;
    const zone = zoneOf({
      kind: n.kind,
      edgeType,
      direction: n.direction,
      via,
    });
    const subtype = n.subtype?.trim() || null;
    const { label, reversed } = edgeType
      ? labelFor(via, edgeType, n.direction, defs)
      : { label: "Also linked", reversed: false };
    const item: NodeNeighbourItem = {
      id: n.id,
      kind: n.kind === "entity" && subtype ? subtype : n.kind,
      graphKind: n.kind,
      subtype,
      title: n.hidden ? hiddenNeighbourTitle(zone) : n.name,
      edgeType,
      direction: n.direction,
      via,
      zone,
      label,
      reversed,
      poweredBy: isPoweredByEdge({ kind: n.kind, via }),
      status: n.hidden ? null : (n.status ?? null),
      updatedAt: n.hidden ? null : (n.updatedAt ?? null),
      state: n.hidden
        ? null
        : neighbourUnitState(
            n.kind,
            n.status,
            blockedByFocus.has(`${n.kind}:${n.id}`) ? focusName : null
          ),
      ...(n.hidden ? { hidden: true as const } : {}),
    };
    const key = `${n.kind}:${n.id}`;
    const prev = best.get(key);
    if (!prev) {
      best.set(key, item);
      order.push(key);
    } else if (
      ZONE_PRECEDENCE.indexOf(zone) < ZONE_PRECEDENCE.indexOf(prev.zone)
    ) {
      best.set(key, item);
    }
  }

  const all: Record<NodeZone, NodeNeighbourItem[]> = {
    cameFrom: [],
    became: [],
    blockedBy: [],
    servesAndBlocks: [],
    workingOnIt: [],
    related: [],
  };
  for (const key of order) {
    const item = best.get(key)!;
    all[item.zone].push(item);
  }

  const slice = (items: NodeNeighbourItem[]): NodeZoneSlice => ({
    items: items.slice(0, Math.max(0, cap)),
    total: items.length,
  });
  return {
    cameFrom: slice(all.cameFrom),
    became: slice(all.became),
    blockedBy: slice(all.blockedBy),
    servesAndBlocks: slice(all.servesAndBlocks),
    workingOnIt: slice(all.workingOnIt),
    related: slice(all.related),
    total: order.length,
  };
}

/** Whether every zone is empty. */
export function isNeighbourhoodEmpty(nb: NodeNeighbourhood): boolean {
  return nb.total === 0;
}
