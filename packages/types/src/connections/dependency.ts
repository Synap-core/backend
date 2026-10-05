/**
 * Dependency — THE one rule for "is this unit of work waiting on something".
 *
 * There is ONE dependency edge in Synap: a `links` row
 * `X --blocked_by--> Y` ("X waits on Y"), across kinds — a task blocked by a
 * task, an entity by a session, a session by a track, a track by a track. The
 * entity relation slugs `blocks` / `depends_on` used to be a second, never-read
 * copy of the same fact; they are now NORMALISED onto this edge at the relation
 * create door (see {@link normaliseDependencyRelation}) and migration 0301
 * moved the stored rows.
 *
 * Blocked-ness is DERIVED, never stored ("flag, don't status" — a status can
 * hold one value, so storing `blocked` destroys the real state and then drifts
 * from the blockers). A unit is blocked while at least one of its blockers is
 * still OPEN by its own kind's status vocabulary:
 *
 *   session  open while `status` ∈ OPEN_SESSION_STATUSES (the same set the
 *            pod's session reader `openBlockerIds` filters on)
 *   track    open unless `completed` / `archived`
 *   entity   open unless its `status` property reads as cleared
 *            ({@link ENTITY_CLEARED_STATUSES}); an entity with no status
 *            property is open — a dependency on a note nobody can finish
 *            stays declared until someone removes it.
 *
 * `replaces` — `A --replaces--> B` ("this step replaces that one": B failed or
 * was dropped, A is the attempt instead). A REPLACED blocker no longer decides
 * anything: whoever waited on B now waits on B's replacement(s), followed
 * transitively (cycle-safe). So a dependent of a failed-and-replaced step is
 * blocked exactly while the replacement is open — the failure of B can neither
 * hold it forever nor clear it early.
 *
 * A blocker whose row no longer exists (deleted) does not block — the pod's
 * session reader drops it the same way (inner join). A blocker the reader
 * cannot SEE is still a blocker: hiding it would read as "free to go", a calm
 * wrong answer. Callers report it as `hidden`, never omit it.
 *
 * Pure and dependency-free apart from the session status leaf.
 */

import { OPEN_SESSION_STATUSES } from "../focus-sessions/statuses.js";

/** `X --blocked_by--> Y`: X waits on Y. */
export const DEPENDENCY_LINK_TYPE = "blocked_by" as const;
/** `A --replaces--> B`: A is the attempt that replaces B. */
export const REPLACES_LINK_TYPE = "replaces" as const;

/** The link types this module reads — the user/agent-authorable work edges. */
export const DEPENDENCY_LINK_TYPES = [
  DEPENDENCY_LINK_TYPE,
  REPLACES_LINK_TYPE,
] as const;
export type DependencyLinkType = (typeof DEPENDENCY_LINK_TYPES)[number];

/**
 * The endpoint kinds a dependency / replacement edge may join — the units of
 * work that have a status to clear. Any pair of these is allowed.
 */
export const DEPENDENCY_ENDPOINT_KINDS = [
  "session",
  "entity",
  "track",
] as const;
export type DependencyEndpointKind = (typeof DEPENDENCY_ENDPOINT_KINDS)[number];

export function isDependencyEndpointKind(
  kind: string | null | undefined
): kind is DependencyEndpointKind {
  return (
    kind != null &&
    (DEPENDENCY_ENDPOINT_KINDS as readonly string[]).includes(kind)
  );
}

export function isDependencyLinkType(
  type: string | null | undefined
): type is DependencyLinkType {
  return (
    type != null && (DEPENDENCY_LINK_TYPES as readonly string[]).includes(type)
  );
}

/** A `project_tracks.status` that no longer holds anyone up. */
export const TRACK_CLEARED_STATUSES = ["completed", "archived"] as const;

/**
 * Entity `status` property values that read as finished. Compared after
 * lower-casing and folding `-` / space to `_`, so `Done`, `closed-won` and
 * `Closed won` all match. Deliberately narrow: a value this list does not know
 * keeps the dependent blocked, which is the honest default.
 */
export const ENTITY_CLEARED_STATUSES = [
  "done",
  "completed",
  "complete",
  "closed",
  "resolved",
  "finished",
  "shipped",
  "cancelled",
  "canceled",
  "archived",
  "closed_won",
  "closed_lost",
  "wont_do",
] as const;

function foldStatus(status: string): string {
  return status
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

/**
 * Whether a blocker of this kind, in this status, has stopped blocking.
 * Unknown kinds never clear (a dependency nobody can reason about stays).
 */
export function isDependencyBlockerCleared(
  kind: string,
  status: string | null | undefined
): boolean {
  switch (kind) {
    case "session":
      // Parity with the pod's `openBlockerIds`: blocking ⇔ status is OPEN.
      return !(OPEN_SESSION_STATUSES as readonly string[]).includes(
        status ?? ""
      );
    case "track":
      return (TRACK_CLEARED_STATUSES as readonly string[]).includes(
        status ?? ""
      );
    case "entity":
      return status
        ? (ENTITY_CLEARED_STATUSES as readonly string[]).includes(
            foldStatus(status)
          )
        : false;
    default:
      return false;
  }
}

export interface DependencyNodeRef {
  kind: string;
  id: string;
}

/** One stored edge, as `links` holds it. */
export interface DependencyEdge {
  fromType: string;
  fromId: string;
  toType: string;
  toId: string;
  linkType: string;
}

/**
 * What the caller knows about one node. `missing` = the row is gone (does not
 * block). `hidden` = it exists but the reader may not see it (still blocks,
 * reported without a name).
 */
export interface DependencyNodeState {
  status?: string | null;
  missing?: boolean;
  hidden?: boolean;
}

export interface OpenBlocker extends DependencyNodeRef {
  /** The blocker as declared, when the open one is its replacement. */
  replaces?: DependencyNodeRef;
  hidden: boolean;
}

const keyOf = (n: DependencyNodeRef) => `${n.kind}:${n.id}`;

/**
 * The blockers of `node` that still hold it up, after following `replaces`.
 * Empty ⇒ not blocked. `edges` may be any superset (other nodes' edges are
 * ignored); `stateOf` returning `undefined` means "unknown" and is treated as
 * OPEN — a blocker the caller failed to look up must never read as cleared.
 */
export function deriveOpenBlockers(
  node: DependencyNodeRef,
  edges: readonly DependencyEdge[],
  stateOf: (ref: DependencyNodeRef) => DependencyNodeState | undefined
): OpenBlocker[] {
  const replacementsOf = new Map<string, DependencyNodeRef[]>();
  for (const e of edges) {
    if (e.linkType !== REPLACES_LINK_TYPE) continue;
    const k = `${e.toType}:${e.toId}`;
    const list = replacementsOf.get(k) ?? [];
    list.push({ kind: e.fromType, id: e.fromId });
    replacementsOf.set(k, list);
  }

  const out = new Map<string, OpenBlocker>();
  const resolve = (
    ref: DependencyNodeRef,
    declared: DependencyNodeRef,
    seen: Set<string>
  ): void => {
    const k = keyOf(ref);
    if (seen.has(k)) return; // a replacement cycle settles nothing — stop
    seen.add(k);
    const replacements = replacementsOf.get(k);
    if (replacements && replacements.length > 0) {
      for (const r of replacements) resolve(r, declared, new Set(seen));
      return;
    }
    const state = stateOf(ref);
    if (state?.missing) return;
    // An unknown state (`undefined`) falls through as OPEN on purpose.
    if (
      state &&
      !state.hidden &&
      isDependencyBlockerCleared(ref.kind, state.status)
    )
      return;
    if (!out.has(k)) {
      out.set(k, {
        kind: ref.kind,
        id: ref.id,
        hidden: state?.hidden === true,
        ...(keyOf(declared) !== k
          ? { replaces: { kind: declared.kind, id: declared.id } }
          : {}),
      });
    }
  };

  for (const e of edges) {
    if (e.linkType !== DEPENDENCY_LINK_TYPE) continue;
    if (e.fromType !== node.kind || e.fromId !== node.id) continue;
    const blocker = { kind: e.toType, id: e.toId };
    resolve(blocker, blocker, new Set([keyOf(node)]));
  }
  return [...out.values()];
}

/** Whether `node` is blocked right now — see {@link deriveOpenBlockers}. */
export function isBlocked(
  node: DependencyNodeRef,
  edges: readonly DependencyEdge[],
  stateOf: (ref: DependencyNodeRef) => DependencyNodeState | undefined
): boolean {
  return deriveOpenBlockers(node, edges, stateOf).length > 0;
}

/** Relation slugs that are the dependency edge under another name. */
export const RELATION_DEPENDENCY_TYPES = ["blocks", "depends_on"] as const;
export type RelationDependencyType = (typeof RELATION_DEPENDENCY_TYPES)[number];

export function isRelationDependencyType(
  type: string | null | undefined
): type is RelationDependencyType {
  return (
    type != null &&
    (RELATION_DEPENDENCY_TYPES as readonly string[]).includes(type)
  );
}

/**
 * Map an entity relation `source --type--> target` onto the ONE dependency
 * edge, direction-normalised:
 *
 *   A --blocks-->     B  ⇔  B --blocked_by--> A
 *   A --depends_on--> B  ⇔  A --blocked_by--> B
 *
 * Any other slug ⇒ `null` (it stays a relation).
 */
export function normaliseDependencyRelation(
  type: string | null | undefined,
  sourceId: string,
  targetId: string
): {
  fromId: string;
  toId: string;
  linkType: typeof DEPENDENCY_LINK_TYPE;
} | null {
  if (type === "blocks") {
    return { fromId: targetId, toId: sourceId, linkType: DEPENDENCY_LINK_TYPE };
  }
  if (type === "depends_on") {
    return { fromId: sourceId, toId: targetId, linkType: DEPENDENCY_LINK_TYPE };
  }
  return null;
}

/**
 * The INVERSE of {@link normaliseDependencyRelation}: read a `blocked_by` edge
 * back as the entity relation it replaces, in the given legacy slug.
 *
 *   X --blocked_by--> Y  ⇔  Y --blocks-->     X
 *                        ⇔  X --depends_on--> Y
 *
 * Exists for readers that still SPEAK the relation vocabulary — notably stored
 * automations filtered on `relation.create` + `relationType: blocks` — so an
 * edge that moved onto the link door is not silently invisible to them. Pure;
 * round-trips with `normaliseDependencyRelation` for both slugs.
 */
export function dependencyLinkAsRelation(
  type: RelationDependencyType,
  fromId: string,
  toId: string
): { sourceId: string; targetId: string } {
  return type === "blocks"
    ? { sourceId: toId, targetId: fromId }
    : { sourceId: fromId, targetId: toId };
}
