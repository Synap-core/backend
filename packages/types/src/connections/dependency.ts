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
 * from the blockers). Each blocker is in ONE of three outcomes, by its own
 * kind's status vocabulary ({@link classifyDependencyBlocker}):
 *
 *            DELIVERED (clears)     DROPPED (still holds)   OPEN (holds)
 *   session  `closed`               `cancelled` · `failed`  anything else —
 *                                                           incl. `stale`
 *   track    `completed`            `archived` (the goal    `active` · `paused`
 *                                   was dropped)
 *   entity   lifecycle category     category `lost`, or     anything else; no
 *            `done`, or a           a dropped status        status ⇒ open
 *            delivered status       ({@link ENTITY_DROPPED_STATUSES})
 *            ({@link ENTITY_DELIVERED_STATUSES})
 *
 * ONLY A DELIVERED BLOCKER CLEARS (founder decision, 2026-10-22). A blocker
 * that ended WITHOUT delivering — cancelled, failed, archived, lost — used to
 * settle exactly like a delivered one, so its dependent went ahead as if the
 * work it waited on existed. It now stays a blocker marked `dropped: true`,
 * and the dependent must RE-PLAN: remove the edge (the work no longer needs
 * it), or link the attempt that replaces it (`replaces`, below). A `stale`
 * session (the reaper found it quiet; resumable) has not ended, so it holds as
 * OPEN. An entity's lifecycle CATEGORY, when the reader knows it, outranks its
 * option key; a key no list knows holds as OPEN — the honest default.
 *
 * `replaces` — `A --replaces--> B` ("this step replaces that one": B failed or
 * was dropped, A is the attempt instead). A REPLACED blocker no longer decides
 * anything: whoever waited on B now waits on B's replacement(s), followed
 * transitively (cycle-safe). So a dependent of a failed-and-replaced step is
 * blocked exactly while the replacement is open — the failure of B can neither
 * hold it forever nor clear it early. Linking a replacement is therefore one
 * of the two ways a DROPPED blocker stops holding its dependent.
 *
 * A blocker whose row no longer exists (deleted) does not block — the pod's
 * session reader drops it the same way (inner join). A blocker the reader
 * cannot SEE is still a blocker: hiding it would read as "free to go", a calm
 * wrong answer. Callers report it as `hidden`, never omit it.
 *
 * Pure and dependency-free (type-only imports of the session status and the
 * lifecycle category).
 */

import type { TerminalSessionStatus } from "../focus-sessions/statuses.js";
import type { LifecycleCategory } from "../lifecycle/option.js";

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

/** What became of a blocker — see the table at the top of this module. */
export type DependencyOutcome = "open" | "delivered" | "dropped";

/** A `focus_sessions.status` that DELIVERED — the only one that clears. */
export const SESSION_DELIVERED_STATUSES = [
  "closed",
] as const satisfies readonly TerminalSessionStatus[];
/** A `focus_sessions.status` that ENDED without delivering. */
export const SESSION_DROPPED_STATUSES = [
  "cancelled",
  "failed",
] as const satisfies readonly TerminalSessionStatus[];

/** A `project_tracks.status` that delivered. */
export const TRACK_DELIVERED_STATUSES = ["completed"] as const;
/** A `project_tracks.status` that ended without delivering ("archive it when the goal is dropped"). */
export const TRACK_DROPPED_STATUSES = ["archived"] as const;

/**
 * Entity `status` property values that read as DELIVERED, when the reader does
 * not know the kind's lifecycle category. Compared after lower-casing and
 * folding `-` / space to `_`, so `Done`, `closed-won` and `Closed won` all
 * match. Deliberately narrow: a value no list knows keeps the dependent
 * blocked, which is the honest default.
 */
export const ENTITY_DELIVERED_STATUSES = [
  "done",
  "completed",
  "complete",
  "closed",
  "resolved",
  "finished",
  "shipped",
  "closed_won",
] as const;

/**
 * Entity `status` values that read as ENDED WITHOUT DELIVERING (same folding).
 * `archived` is here, not above: an archived thing may or may not have been
 * finished, and claiming a delivery nobody can see is the defect this rule
 * exists to stop — the dependent re-plans instead.
 */
export const ENTITY_DROPPED_STATUSES = [
  "cancelled",
  "canceled",
  "archived",
  "closed_lost",
  "wont_do",
] as const;

/** Every entity status that has ENDED, either way — the "no longer live" test. */
export const ENTITY_ENDED_STATUSES = [
  ...ENTITY_DELIVERED_STATUSES,
  ...ENTITY_DROPPED_STATUSES,
] as const;

function foldStatus(status: string): string {
  return status
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

const has = (list: readonly string[], v: string | null | undefined) =>
  v != null && list.includes(v);

/**
 * THE classification — what became of a blocker of this kind, in this status
 * (and, for an entity, this lifecycle category when the reader resolved it).
 * Unknown kinds and unknown values are OPEN: a dependency nobody can reason
 * about stays declared.
 */
export function classifyDependencyBlocker(
  kind: string,
  status: string | null | undefined,
  category?: LifecycleCategory | null
): DependencyOutcome {
  switch (kind) {
    case "session":
      if (has(SESSION_DELIVERED_STATUSES, status)) return "delivered";
      return has(SESSION_DROPPED_STATUSES, status) ? "dropped" : "open";
    case "track":
      if (has(TRACK_DELIVERED_STATUSES, status)) return "delivered";
      return has(TRACK_DROPPED_STATUSES, status) ? "dropped" : "open";
    case "entity": {
      if (category === "done") return "delivered";
      if (category === "lost") return "dropped";
      if (category) return "open";
      if (!status) return "open";
      const folded = foldStatus(status);
      if (has(ENTITY_DELIVERED_STATUSES, folded)) return "delivered";
      return has(ENTITY_DROPPED_STATUSES, folded) ? "dropped" : "open";
    }
    default:
      return "open";
  }
}

/**
 * Whether a unit of this kind, in this status, has ENDED — delivered OR
 * dropped. The "is it still live" test (a row's terminal mark, a dependent
 * still waiting, a task still pickable); NOT "has it stopped blocking" — a
 * dropped blocker has ended and still blocks. That question is
 * {@link deriveOpenBlockers}'s.
 */
export function isDependencyEnded(
  kind: string,
  status: string | null | undefined,
  category?: LifecycleCategory | null
): boolean {
  return classifyDependencyBlocker(kind, status, category) !== "open";
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
 * reported without a name). `category` = an entity's lifecycle category, when
 * the reader resolved its kind's lifecycle. `title` = its display name.
 */
export interface DependencyNodeState {
  status?: string | null;
  category?: LifecycleCategory | null;
  title?: string | null;
  missing?: boolean;
  hidden?: boolean;
}

export interface OpenBlocker extends DependencyNodeRef {
  /** The blocker as declared, when the open one is its replacement. */
  replaces?: DependencyNodeRef;
  hidden: boolean;
  /**
   * It ENDED without delivering (cancelled, failed, archived, lost) and still
   * holds the dependent: the work it waited on never happened, so the
   * dependent re-plans — remove the edge, or link a replacement.
   */
  dropped: boolean;
  /** Its own raw status, when the reader may see it. */
  status?: string | null;
  /** Its display name, when the reader may see it. */
  title?: string | null;
}

const keyOf = (n: DependencyNodeRef) => `${n.kind}:${n.id}`;

/**
 * The blockers of `node` that still hold it up, after following `replaces` —
 * OPEN ones and DROPPED ones (`dropped: true`); only a DELIVERED blocker
 * clears ({@link classifyDependencyBlocker}). Empty ⇒ not blocked. `edges`
 * may be any superset (other nodes' edges are
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
    // An unknown state (`undefined`) and a hidden one fall through as OPEN on
    // purpose: what the reader cannot see is never called delivered.
    const visible = state && !state.hidden ? state : undefined;
    const outcome = visible
      ? classifyDependencyBlocker(ref.kind, visible.status, visible.category)
      : "open";
    if (outcome === "delivered") return;
    if (!out.has(k)) {
      out.set(k, {
        kind: ref.kind,
        id: ref.id,
        hidden: state?.hidden === true,
        dropped: outcome === "dropped",
        ...(visible && visible.status !== undefined
          ? { status: visible.status }
          : {}),
        ...(visible?.title != null ? { title: visible.title } : {}),
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

/**
 * Whether `node` is held up right now — by an open OR a dropped blocker; see
 * {@link deriveOpenBlockers}.
 */
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

/**
 * Marker on a relation-shaped row that is really THE dependency edge (a
 * `links` `blocked_by` row): `id` is the LINK id, so a reader that writes back
 * (delete, undo) goes through the link door, never the relation table.
 */
export const DEPENDENCY_STORED_AS = "link" as const;

/** A `blocked_by` link as the relation readers see it. */
export interface DependencyRelationRow {
  /** The LINK id. */
  id: string;
  storedAs: typeof DEPENDENCY_STORED_AS;
  type: RelationDependencyType;
  sourceEntityId: string;
  targetEntityId: string;
  /**
   * The relation row this edge was migrated from (0301), when there was one —
   * so a reader that held the old id (a whiteboard arrow) can re-key to `id`.
   */
  legacyRelationId: string | null;
  workspaceId: string | null;
  metadata: Record<string, unknown>;
  createdBy: string | null;
  createdAt: Date | string;
}

/**
 * Read ONE `blocked_by` link (entity ↔ entity) back as the relation row every
 * relation reader returns. The slug is the one the edge was WRITTEN under
 * (`metadata.relationType`, stamped by the relation door and migration 0301),
 * so a `blocks` arrow reads back as `blocks` in the same direction; an edge
 * written on the link door itself reads as `depends_on` (blocked → blocker).
 * Any other link (non-entity end, other type) ⇒ `null`: it is not a relation.
 */
export function dependencyLinkAsRelationRow(link: {
  id: string;
  fromType: string;
  fromId: string;
  toType: string;
  toId: string;
  linkType: string;
  workspaceId?: string | null;
  metadata?: unknown;
  createdBy?: string | null;
  createdAt: Date | string;
}): DependencyRelationRow | null {
  if (link.linkType !== DEPENDENCY_LINK_TYPE) return null;
  if (link.fromType !== "entity" || link.toType !== "entity") return null;
  const metadata =
    link.metadata &&
    typeof link.metadata === "object" &&
    !Array.isArray(link.metadata)
      ? (link.metadata as Record<string, unknown>)
      : {};
  const type: RelationDependencyType =
    metadata.relationType === "blocks" ? "blocks" : "depends_on";
  const { sourceId, targetId } = dependencyLinkAsRelation(
    type,
    link.fromId,
    link.toId
  );
  const legacy = metadata.migratedFromRelationId;
  return {
    id: link.id,
    storedAs: DEPENDENCY_STORED_AS,
    type,
    sourceEntityId: sourceId,
    targetEntityId: targetId,
    legacyRelationId: typeof legacy === "string" ? legacy : null,
    workspaceId: link.workspaceId ?? null,
    metadata,
    createdBy: link.createdBy ?? null,
    createdAt: link.createdAt,
  };
}
