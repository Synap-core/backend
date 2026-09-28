/**
 * LANDED — "what did my agents finish, and what did it produce?" — ONE
 * contract, every surface.
 *
 * Two readings of "landed" exist in the V1 specs, and both come from here:
 *
 *   1. OBJECTS that landed (browser Data › Landed) — `outputs.landed`, one row
 *      per produced object, with who made it, the session it came from, and the
 *      decision that let it exist. The pod computes these rows; this module
 *      owns their WIRE SHAPE and the decision-state mapping.
 *   2. SESSIONS that landed (relay Home "Landed since you looked", browser Home
 *      "Landed today") — settled sessions, each carrying its RESULT
 *      (`outputsSummary`). The SELECTION is `landedSince` below, and the pod's
 *      `focusSessions.landed` door applies the same statuses and the same clock
 *      in SQL, so a phone and a desktop cannot disagree about what "landed
 *      since" means.
 *
 * Pure and dependency-free (sibling leaves only), so the pod, the browser,
 * relay and the CLI import the same answer. It returns TONE TOKEN NAMES and
 * GLYPHS, never a colour, and a status TOKEN for `resolveStatusLabel`, never a
 * sentence.
 */

import { TERMINAL_SESSION_STATUSES } from "../focus-sessions/statuses.js";
import {
  resolveUnitState,
  type UnitGlyph,
  type UnitStateView,
  type UnitTone,
} from "../units/state.js";

// ── Decision state of a landed object ────────────────────────────────────────

/**
 * How an object came to exist, as far as governance is concerned.
 *
 *   applied        — written with no decision in between (a person's own write,
 *                    or a legacy row with no receipt).
 *   approved       — an agent PROPOSED it and a person approved it ("Decided
 *                    by"). The reviewer rides on the row.
 *   auto_approved  — a rule let the agent's write through; it applied and can
 *                    still be undone (the Revert door).
 *   pending        — PROPOSED, not applied. "To review" — never landed.
 *   reverted       — it applied, then was undone.
 *
 * The first two are both "applied" in the spec's three-way reading; they are
 * kept apart because "who decided" is exactly what the Lineage row answers.
 */
export const LANDED_DECISION_STATES = [
  "applied",
  "approved",
  "auto_approved",
  "pending",
  "reverted",
] as const;
export type LandedDecisionState = (typeof LANDED_DECISION_STATES)[number];

/**
 * The creating proposal's `proposals.status` → the decision state.
 *
 * `null`/absent = there is no creating proposal: the object was `applied`
 * directly. Any status that is not a decision ABOUT an existing object
 * (`rejected`, `withdrawn`, `expired`, `approval_failed`, an unknown value)
 * also reads `applied`: this is only ever asked about an object that EXISTS
 * (or, for `pending`, one that is proposed), so a live object whose receipt
 * says something else was, as a matter of fact, applied.
 */
export function resolveLandedDecision(
  proposalStatus: string | null | undefined
): LandedDecisionState {
  switch (proposalStatus) {
    case "approved":
    case "partially_approved":
      return "approved";
    case "auto_approved":
      return "auto_approved";
    case "pending":
      return "pending";
    case "reverted":
      return "reverted";
    default:
      return "applied";
  }
}

export interface LandedDecisionView {
  state: LandedDecisionState;
  /** A palette token NAME (see `UnitTone`) — each surface maps it to a colour. */
  tone: UnitTone;
  glyph: UnitGlyph;
  /** Feed to `resolveStatusLabel` (`@synap-core/types/vocabulary`). */
  statusToken: LandedDecisionState;
  /** False only for `pending`: a proposal is "To review", never landed. */
  landed: boolean;
  /** The Revert door is offered on this row (an auto-approved write). */
  undoable: boolean;
}

const DECISION_VIEWS: Record<
  LandedDecisionState,
  Omit<LandedDecisionView, "state" | "statusToken">
> = {
  applied: {
    tone: "textSecondary",
    glyph: "check",
    landed: true,
    undoable: false,
  },
  // A PERSON decided — the mark says so (glyph), success says it held.
  approved: { tone: "success", glyph: "person", landed: true, undoable: false },
  auto_approved: { tone: "info", glyph: "check", landed: true, undoable: true },
  // Same mark as a unit that `needs_review` — it is your judgement it waits on.
  pending: { tone: "primary", glyph: "scales", landed: false, undoable: false },
  reverted: {
    tone: "textMuted",
    glyph: "dashed-circle",
    landed: true,
    undoable: false,
  },
};

export function resolveLandedDecisionView(
  state: LandedDecisionState
): LandedDecisionView {
  return { state, statusToken: state, ...DECISION_VIEWS[state] };
}

// ── Object rows: `outputs.landed` ───────────────────────────────────────────

/** Who the Landed list is filtered to. `me` = the viewer's own writes. */
export const LANDED_ACTOR_FILTERS = ["agents", "me", "all"] as const;
export type LandedActorFilter = (typeof LANDED_ACTOR_FILTERS)[number];

/**
 * WHO made the object. An agent is named when the pod could name it; an
 * agent-produced output with no attributable agent (an artifact that only
 * recorded `originKind: agent`) carries `id: null` rather than a guess.
 * A legacy row with no provenance reads as the owner — a HUMAN — never as an
 * agent (`entities.createdByKind` NULL = human, per its schema comment).
 */
export type LandedActor =
  | { kind: "agent"; id: string | null; name: string | null }
  | { kind: "human"; id: string; name: string | null; isViewer: boolean };

export function matchesLandedActor(
  actor: LandedActor,
  filter: LandedActorFilter
): boolean {
  if (filter === "all") return true;
  if (filter === "agents") return actor.kind === "agent";
  return actor.kind === "human" && actor.isViewer;
}

export interface LandedEntityProfile {
  slug: string;
  displayName: string | null;
  icon: string | null;
}

export interface LandedObjectRef {
  kind: string;
  id: string;
}

export interface LandedDecision {
  state: LandedDecisionState;
  /** The proposal (receipt or decided proposal) behind the state, when one exists. */
  proposalId: string | null;
  /** The person who reviewed it — present on `approved`/`reverted` when recorded. */
  decidedBy: { id: string; name: string | null } | null;
  /** When it was decided (ISO), when recorded. */
  decidedAt: string | null;
}

export interface LandedObjectRow {
  /**
   * Stable row key: `<sessionId>|<kind>:<refId>` for a produced object (the
   * `projects.outputs` key), `proposal:<proposalId>` for a pending one.
   */
  id: string;
  /** Normalized object kind (`entity`, `document`, `view`, …). */
  kind: string;
  title: string;
  /**
   * The DOOR. A produced object opens itself; a PENDING row's door is its
   * proposal (`{ kind: "proposal" }`) — the object does not exist yet.
   */
  ref: LandedObjectRef;
  /** An `entity` row's kind ("Person", "Company"), when known. */
  entityProfile?: LandedEntityProfile;
  /** When it landed — or, for `pending`, when it was proposed (ISO). */
  createdAt: string;
  actor: LandedActor;
  /** The session it came from — the provenance door. */
  session: { id: string; title: string };
  decision: LandedDecision;
}

export interface LandedObjectsPage {
  items: LandedObjectRow[];
  /** Pass back as `cursor` for the next (older) page; `null` = no more. */
  nextCursor: string | null;
  /**
   * More sessions matched than one read scans: the least recently active
   * sessions' outputs are missing from every page — reported, never silent.
   */
  truncated: boolean;
}

// ── Session rows: `focusSessions.landed` ────────────────────────────────────

/** A session has LANDED when it reached one of these. Failures included. */
export const LANDED_SESSION_STATUSES = TERMINAL_SESSION_STATUSES;

/** The Home band's cap ("max 10"), shared so both apps page the same. */
export const LANDED_SINCE_MAX = 10;

export interface LandedSessionLike {
  status: string;
  closedAt?: Date | string | null;
  updatedAt: Date | string;
}

function toMillis(v: Date | string | number | null | undefined): number {
  if (v === null || v === undefined) return Number.NaN;
  return v instanceof Date ? v.getTime() : new Date(v).getTime();
}

/**
 * When a session settled: `coalesce(closed_at, updated_at)` — the same clock
 * the pod's status windows use (`session-status-filter.ts`). `NaN` when the
 * row carries no readable time.
 */
export function landedSettledAt(row: LandedSessionLike): number {
  const closed = toMillis(row.closedAt);
  return Number.isNaN(closed) ? toMillis(row.updatedAt) : closed;
}

export function isLandedSessionStatus(status: string | null | undefined) {
  return (
    status != null &&
    (LANDED_SESSION_STATUSES as readonly string[]).includes(status)
  );
}

/**
 * THE selection: sessions that settled (closed / failed / cancelled) at or
 * after `since`, newest settled first, capped at `limit`
 * (default {@link LANDED_SINCE_MAX}).
 *
 * An unreadable `since` THROWS: returning `[]` would render "nothing landed"
 * for a clock we could not read — the calm-and-wrong answer. A row with no
 * readable settle time is not "since" anything and is left out.
 */
export function landedSince<T extends LandedSessionLike>(
  rows: readonly T[],
  since: Date | string | number,
  opts: { limit?: number } = {}
): T[] {
  const floor = toMillis(since);
  if (Number.isNaN(floor)) {
    throw new RangeError(`landedSince: unreadable since (${String(since)})`);
  }
  const limit = opts.limit ?? LANDED_SINCE_MAX;
  return rows
    .map((row) => ({ row, at: landedSettledAt(row) }))
    .filter(
      ({ row, at }) =>
        isLandedSessionStatus(row.status) && !Number.isNaN(at) && at >= floor
    )
    .sort((a, b) => b.at - a.at)
    .slice(0, Math.max(0, limit))
    .map(({ row }) => row);
}

/**
 * The outcome mark of a landed session — `resolveUnitState`, asked the one
 * way both apps must ask it: `failed` wears the failure tone, every other
 * exit reads done.
 */
export function resolveLandedSessionState(status: string): UnitStateView {
  return resolveUnitState({ terminal: true, failed: status === "failed" });
}

/** What a settled session produced — the Landed card's "12 leads · 1 doc". */
export interface SessionOutputsSummary {
  count: number;
  /**
   * Counts per DISPLAY kind, largest first: an entity counts under its profile
   * (`key` = the profile slug, so "12 leads"), anything else under its object
   * kind (`key` = the kind).
   */
  byKind: Array<{
    key: string;
    kind: string;
    entityProfile?: LandedEntityProfile;
    count: number;
  }>;
  /** The most recently produced object — the card's lead line and door. */
  top: {
    kind: string;
    title: string;
    ref: LandedObjectRef;
    entityProfile?: LandedEntityProfile;
  } | null;
}

/** The fields of one session output the summary reads (the pod's `SessionOutput`). */
export interface SummarizableOutput {
  kind: string;
  refId: string;
  title: string;
  producedAt: Date | string;
  entityProfile?: LandedEntityProfile;
}

export function summarizeSessionOutputs(
  outputs: readonly SummarizableOutput[]
): SessionOutputsSummary {
  const groups = new Map<string, SessionOutputsSummary["byKind"][number]>();
  let top: SummarizableOutput | null = null;
  for (const o of outputs) {
    const key = o.entityProfile?.slug ?? o.kind;
    const group = groups.get(key);
    if (group) group.count += 1;
    else
      groups.set(key, {
        key,
        kind: o.kind,
        ...(o.entityProfile ? { entityProfile: o.entityProfile } : {}),
        count: 1,
      });
    if (!top || toMillis(o.producedAt) > toMillis(top.producedAt)) top = o;
  }
  return {
    count: outputs.length,
    byKind: [...groups.values()].sort(
      (a, b) => b.count - a.count || (a.key < b.key ? -1 : 1)
    ),
    top: top
      ? {
          kind: top.kind,
          title: top.title,
          ref: { kind: top.kind, id: top.refId },
          ...(top.entityProfile ? { entityProfile: top.entityProfile } : {}),
        }
      : null,
  };
}

/**
 * Liveness, on every session list row (`focusSessions.list` / `browse` /
 * `landed`): the last time an AGENT did something in the session — filed a
 * proposal into it, or posted in its room. `null` = no agent activity recorded.
 */
export interface SessionAgentActivity {
  lastAgentActivityAt: Date | string | null;
}
