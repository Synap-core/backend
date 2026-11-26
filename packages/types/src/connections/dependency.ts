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
 *   session  category `done` and   category `lost`         anything else —
 *            `closedAs` done        (`cancelled`, `failed`), incl. `stale`
 *            (`closed`, nothing     or `closed` with
 *            required left open)    `closedAs` not_done
 *   track    lifecycle category     category `lost`         anything else
 *            `done` (`completed`)   (`archived`: the goal
 *                                   was dropped)
 *   entity   lifecycle category     category `lost`, or     anything else; no
 *            `done`, or a           a dropped status        status ⇒ open
 *            delivered status       ({@link ENTITY_DROPPED_STATUSES})
 *            ({@link ENTITY_DELIVERED_STATUSES})
 *
 * ONLY A DELIVERED BLOCKER CLEARS (founder decision, 2026-10-22). A blocker
 * that ended WITHOUT delivering — cancelled, failed, archived, lost, or a
 * session closed anyway with required work open (founder, 2026-11-20:
 * "delivered" means the work was done, not that the session closed;
 * `sessionClosedAs`, focus-sessions/statuses.ts) — used to
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
 * DECISION ARMS (founder decision P5, 21 Nov 2026) — "every branch is a
 * decision". A `blocked_by` edge to a decision may name ONE of its options in
 * `links.metadata.option` ({@link DECISION_ARM_OPTION_KEY}): the step waits
 * for THAT answer ({@link classifyArmBlocker}). The decision accepted with
 * that option delivers; accepted with another option (or none) the arm is
 * NOT TAKEN: the step still holds (`dropped`, `notTaken`) and the pod closes
 * it as skipped (`decision-arms.ts`); rejected, it holds like any dropped
 * blocker until its owner re-plans. An edge with no option reads as before.
 * A SKIPPED step (ended as an arm not taken) does not hold ITS dependents:
 * for ordering it counts as delivered (`skipped` on the session's state), so
 * a step that joins two exclusive arms waits only on the arm taken.
 *
 * A blocker whose row no longer exists (deleted) does not block — the pod's
 * session reader drops it the same way (inner join). A blocker the reader
 * cannot SEE is still a blocker: hiding it would read as "free to go", a calm
 * wrong answer. Callers report it as `hidden`, never omit it.
 *
 * Pure. Its runtime imports are the session and track status declarations,
 * leaves (`focus-sessions/statuses.ts`, `units/track-status.ts`); the rest are
 * types.
 */

import {
  sessionStatusCategory,
  type SessionClosedAs,
} from "../focus-sessions/statuses.js";
import type { LifecycleCategory } from "../lifecycle/option.js";
import { trackStatusCategory } from "../units/track-status.js";

/** `X --blocked_by--> Y`: X waits on Y. */
export const DEPENDENCY_LINK_TYPE = "blocked_by" as const;
/** `A --replaces--> B`: A is the attempt that replaces B. */
export const REPLACES_LINK_TYPE = "replaces" as const;

/**
 * `links.metadata.option` on a `blocked_by` edge to a decision: the option key
 * (`askOptionKey`: `value ?? label`) the waiting step is the arm of. Written
 * by the session doors (`<id>:<option>`, {@link parseArmRef}) and by a
 * capture plan's cross-kind `links[]` (a step → a decision, `option`).
 */
export const DECISION_ARM_OPTION_KEY = "option" as const;

/** The arm option an edge's metadata names, or `null` (a plain wait). */
export function armOptionOf(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const v = (metadata as Record<string, unknown>)[DECISION_ARM_OPTION_KEY];
  return typeof v === "string" && v.trim() ? v : null;
}

/**
 * The compact form an agent door takes for an arm: `<decision id>:<option>`.
 * A UUID is 36 characters, so a `:` right after them splits (an option may
 * hold more `:`). A bare ref is a plain wait (`option: null`). An empty
 * option is `null`: never read as "no arm". The caller checks the id.
 */
export function parseArmRef(
  ref: string
): { id: string; option: string | null } | null {
  if (ref.length <= ARM_ID_LENGTH || ref[ARM_ID_LENGTH] !== ":") {
    return { id: ref, option: null };
  }
  const option = ref.slice(ARM_ID_LENGTH + 1);
  return option.trim() ? { id: ref.slice(0, ARM_ID_LENGTH), option } : null;
}
const ARM_ID_LENGTH = 36;

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

/**
 * `X --serves--> G`: the work X is done FOR goal G. X is a session (optionally
 * naming ONE of G's criteria in `links.metadata.criterionKey`) or a sub-goal
 * (a track serving its parent goal). G is always a track.
 *
 * NOT a dependency: nothing waits on anything, so every blocker reader (they
 * read {@link DEPENDENCY_LINK_TYPES}) ignores it. Goal rollups follow it: a
 * goal's work counts the sessions filed in it OR serving it, each once.
 */
export const SERVES_LINK_TYPE = "serves" as const;

/**
 * `G --advances--> W`: goal G moves space W of its project forward — W is a
 * PILLAR of the project (the project `uses` W). NOT a dependency: no blocker
 * reader follows it. The pillar health read does
 * (`services/projects/pillar-health.ts`).
 */
export const ADVANCES_LINK_TYPE = "advances" as const;

/**
 * `links.metadata.primary: true` on a `serves` (goal → goal) or `advances`
 * edge: the goal's PRIMARY parent or pillar — at most one of each per goal.
 * A goal rolls up fully to its primary only; elsewhere it is listed.
 */
export const LINK_PRIMARY_KEY = "primary" as const;

/** Does this link metadata mark the edge primary? */
export function isPrimaryLinkMetadata(metadata: unknown): boolean {
  return (
    metadata != null &&
    typeof metadata === "object" &&
    (metadata as Record<string, unknown>)[LINK_PRIMARY_KEY] === true
  );
}

/**
 * The work edges THE dependency door writes: the dependency edges plus
 * `serves` and `advances`. Readers of "what waits on what" keep reading
 * {@link DEPENDENCY_LINK_TYPES}; only the door widens to this list.
 */
export const WORK_LINK_TYPES = [
  ...DEPENDENCY_LINK_TYPES,
  SERVES_LINK_TYPE,
  ADVANCES_LINK_TYPE,
] as const;
export type WorkLinkType = (typeof WORK_LINK_TYPES)[number];

export function isWorkLinkType(
  type: string | null | undefined
): type is WorkLinkType {
  return type != null && (WORK_LINK_TYPES as readonly string[]).includes(type);
}

/** The kinds that may SERVE a goal; the served end is always a track. */
export const SERVES_FROM_KINDS = ["session", "track"] as const;

/** Is `from --serves--> to` a pair the edge allows (session|track → track)? */
export function isServesPair(fromType: string, toType: string): boolean {
  return (
    (SERVES_FROM_KINDS as readonly string[]).includes(fromType) &&
    toType === "track"
  );
}

/** Is `from --advances--> to` the pair the edge allows (track → workspace)? */
export function isAdvancesPair(fromType: string, toType: string): boolean {
  return fromType === "track" && toType === "workspace";
}

/** What became of a blocker — see the table at the top of this module. */
export type DependencyOutcome = "open" | "delivered" | "dropped";

/**
 * Entity `status` property values that read as DELIVERED, when the reader does
 * not know the kind's lifecycle category. A list, not a derivation: a kind
 * that declares no lifecycle has no categories to read, its free `status`
 * property is all there is. Compared after lower-casing and folding `-` /
 * space to `_`, so `Done`, `closed-won` and `Closed won` all match.
 * Deliberately narrow: a value no list knows keeps the dependent blocked,
 * which is the honest default.
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

/** A declared category's outcome: done delivered, lost dropped, else open. */
function outcomeOfCategory(
  category: LifecycleCategory | null | undefined
): DependencyOutcome {
  if (category === "done") return "delivered";
  return category === "lost" ? "dropped" : "open";
}

/**
 * THE classification — what became of a blocker of this kind, in this status
 * (and, for an entity, this lifecycle category when the reader resolved it;
 * for a session, its `closedAs` when the reader read it). Unknown kinds and
 * unknown values are OPEN: a dependency nobody can reason about stays
 * declared.
 */
export function classifyDependencyBlocker(
  kind: string,
  status: string | null | undefined,
  category?: LifecycleCategory | null,
  closedAs?: SessionClosedAs | null,
  skipped?: boolean | null
): DependencyOutcome {
  switch (kind) {
    case "session": {
      // A step skipped as a decision's arm not taken holds nobody (P5).
      if (skipped === true && isEndedSessionStatus(status)) return "delivered";
      // Read off the declaration's categories; a `closed` session delivered
      // only when it closed with nothing required left open.
      const outcome = outcomeOfCategory(sessionStatusCategory(status));
      return outcome === "delivered" && closedAs === "not_done"
        ? "dropped"
        : outcome;
    }
    case "track":
      return outcomeOfCategory(trackStatusCategory(status));
    case "entity": {
      if (category) return outcomeOfCategory(category);
      if (!status) return "open";
      const folded = foldStatus(status);
      if (has(ENTITY_DELIVERED_STATUSES, folded)) return "delivered";
      return has(ENTITY_DROPPED_STATUSES, folded) ? "dropped" : "open";
    }
    default:
      return "open";
  }
}

/** A session that has ended (done or lost) — only such a one can be skipped. */
function isEndedSessionStatus(status: string | null | undefined): boolean {
  const c = sessionStatusCategory(status);
  return c === "done" || c === "lost";
}

/** What became of a decision for ONE arm of it (P5). */
export type ArmOutcome = DependencyOutcome | "not_taken";

/**
 * A blocker's outcome for the edge that waits on it (P5): with no `option`,
 * the blocker's own outcome. With one, a DELIVERED decision delivers only
 * when it chose that option; another choice (or none) is `not_taken`. A
 * dropped (rejected) or open decision keeps its outcome: every arm holds.
 */
export function classifyArmBlocker(
  outcome: DependencyOutcome,
  option: string | null | undefined,
  chosenOption: string | null | undefined
): ArmOutcome {
  if (!option || outcome !== "delivered") return outcome;
  return chosenOption === option ? "delivered" : "not_taken";
}

/**
 * What an ACCEPTED decision does to the steps that are its arms (P5):
 *   · some arm names the chosen option ⇒ that arm is taken; every step on
 *     another arm is SKIPPED ("not taken");
 *   · no arm names it (or nothing was chosen) ⇒ `unmatched`: nothing is
 *     skipped, every arm holds and the person is told — never a silent green
 *     (the n8n trap: a branch that matches nothing must not read as done).
 * Pure; the pod applies it (`decision-arms.ts`).
 */
export function planDecisionArms(
  chosenOption: string | null | undefined,
  arms: ReadonlyArray<{ stepId: string; option: string }>
): { skip: string[]; unmatched: boolean } {
  const taken = !!chosenOption && arms.some((a) => a.option === chosenOption);
  if (!taken) return { skip: [], unmatched: arms.length > 0 };
  return {
    skip: [
      ...new Set(
        arms.filter((a) => a.option !== chosenOption).map((a) => a.stepId)
      ),
    ],
    unmatched: false,
  };
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
  /** A `blocked_by` edge's arm ({@link armOptionOf}); absent = a plain wait. */
  option?: string | null;
}

/**
 * What the caller knows about one node. `missing` = the row is gone (does not
 * block). `hidden` = it exists but the reader may not see it (still blocks,
 * reported without a name). `category` = an entity's lifecycle category, when
 * the reader resolved its kind's lifecycle. `closedAs` = how a session ended
 * (`sessionClosedAs`), when the reader read it; absent on a closed session
 * reads as delivered. `title` = its display name.
 */
export interface DependencyNodeState {
  status?: string | null;
  category?: LifecycleCategory | null;
  closedAs?: SessionClosedAs | null;
  /** A session that ended as a decision's arm not taken (P5): holds nobody. */
  skipped?: boolean;
  /** A decision's chosen option key (`chosenOption`), read by an arm edge. */
  chosenOption?: string | null;
  title?: string | null;
  missing?: boolean;
  hidden?: boolean;
}

export interface OpenBlocker extends DependencyNodeRef {
  /** The blocker as declared, when the open one is its replacement. */
  replaces?: DependencyNodeRef;
  hidden: boolean;
  /**
   * It ENDED without delivering (cancelled, failed, archived, lost, closed
   * with required work open) and still holds the dependent: the work it
   * waited on never happened, so the dependent re-plans — remove the edge,
   * or link a replacement.
   */
  dropped: boolean;
  /**
   * With `dropped`: the step is an arm of this decision that was NOT taken
   * (P5). It holds until the pod closes the step as skipped.
   */
  notTaken?: true;
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
    seen: Set<string>,
    option: string | null
  ): void => {
    const k = keyOf(ref);
    if (seen.has(k)) return; // a replacement cycle settles nothing — stop
    seen.add(k);
    const replacements = replacementsOf.get(k);
    if (replacements && replacements.length > 0) {
      for (const r of replacements) resolve(r, declared, new Set(seen), option);
      return;
    }
    const state = stateOf(ref);
    if (state?.missing) return;
    // An unknown state (`undefined`) and a hidden one fall through as OPEN on
    // purpose: what the reader cannot see is never called delivered.
    const visible = state && !state.hidden ? state : undefined;
    const outcome = visible
      ? classifyArmBlocker(
          classifyDependencyBlocker(
            ref.kind,
            visible.status,
            visible.category,
            visible.closedAs,
            visible.skipped
          ),
          option,
          visible.chosenOption
        )
      : "open";
    if (outcome === "delivered") return;
    if (!out.has(k)) {
      out.set(k, {
        kind: ref.kind,
        id: ref.id,
        hidden: state?.hidden === true,
        dropped: outcome === "dropped" || outcome === "not_taken",
        ...(outcome === "not_taken" ? { notTaken: true as const } : {}),
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
    resolve(blocker, blocker, new Set([keyOf(node)]), e.option ?? null);
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
