/**
 * The STATE MARK of one node-neighbourhood row — through the ONE derivation.
 *
 * `graph.getObjectGraph` neighbours carry the far end's RAW lifecycle `status`
 * (session / track / project / proposal / run column, an entity's `status`
 * property). This maps that raw value onto `resolveUnitState`'s input using
 * each kind's EXISTING adapter — `sessionUnitInput`, `trackUnitInput`,
 * `unitStateInputOfRunStatus`, the proposal `STATUS_ATTENTION` table, the
 * dependency module's `isDependencyBlockerCleared` — so a row wears the same
 * mark the object wears on its own surface. No local status table.
 *
 * A row gets a mark ONLY when its lifecycle alone settles it. An open entity,
 * an active track or project, a capture: `null` — their live state is an
 * aggregate this read does not carry (an active track's state is its
 * sessions'), and claiming "working" or "not started" there would be invented.
 *
 * Measured limit: the graph does not read a session's OWED slots, so a closed
 * session that still owes the person reads `done` here while its own page
 * reads "needs you". The row mark is the lifecycle; the page is the verdict.
 *
 * Pure and Hermes-safe: value imports are leaves only (`../units/state`,
 * `../units/session`, `../focus-sessions/statuses`, `../units/track`, `../proposals/attention`, `./dependency`).
 */

import {
  STATUS_ATTENTION,
  type ProposalStatusValue,
} from "../proposals/attention.js";
import { SESSION_STATUSES } from "../focus-sessions/statuses.js";
import { sessionUnitInput } from "../units/session.js";
import {
  resolveUnitState,
  unitStateInputOfRunStatus,
  type UnitStateInput,
  type UnitStateView,
} from "../units/state.js";
import { trackUnitInput } from "../units/track.js";
import {
  DEPENDENCY_LINK_TYPE,
  REPLACES_LINK_TYPE,
  isBlocked,
  isDependencyBlockerCleared,
  isDependencyEndpointKind,
  type DependencyEdge,
  type DependencyNodeRef,
  type DependencyNodeState,
} from "./dependency.js";

/** A track / project row status that settles the mark by itself. */
const PROJECT_SETTLED: Readonly<Record<string, UnitStateInput>> = {
  completed: { terminal: true },
  archived: { terminal: true },
};

/**
 * The unit-state input for a neighbour of `graphKind` in `status`, or `null`
 * when the lifecycle alone does not settle a mark. `blockedBy` (a title) is
 * set when the dependency rule says this row waits on an open blocker.
 */
export function neighbourUnitInput(
  graphKind: string,
  status: string | null | undefined,
  blockedBy?: string | null
): UnitStateInput | null {
  const blocked = blockedBy ? { blockedBy } : null;
  switch (graphKind) {
    case "session":
      // An unknown status would fall to `sessionUnitInput`'s default arm
      // (working) — a claim of motion nobody measured.
      if (
        !status ||
        !(SESSION_STATUSES as readonly string[]).includes(status)
      ) {
        return blocked;
      }
      // Owed slots are NOT read by the graph (see the header): 0 = "not read
      // here", so the lifecycle reading stands.
      return sessionUnitInput({
        status,
        owedFromYou: 0,
        blockedBy: blockedBy ?? null,
      });
    case "track": {
      // Only the statuses `trackUnitInput` settles WITHOUT the sessions: an
      // active track's state is its sessions' aggregate, not read here.
      if (
        status !== "completed" &&
        status !== "archived" &&
        status !== "paused"
      ) {
        return blocked;
      }
      const input = trackUnitInput({ status }, []);
      return blocked && !input.terminal ? { ...input, ...blocked } : input;
    }
    case "project":
      return (status && PROJECT_SETTLED[status]) || null;
    case "proposal": {
      const attention =
        status && Object.prototype.hasOwnProperty.call(STATUS_ATTENTION, status)
          ? STATUS_ATTENTION[status as ProposalStatusValue]
          : undefined;
      if (attention === undefined) return null;
      return attention === "decide"
        ? { pendingDecisions: 1 }
        : { terminal: true };
    }
    case "run":
      return status ? unitStateInputOfRunStatus(status) : null;
    case "entity":
      if (status && isDependencyBlockerCleared("entity", status)) {
        return { terminal: true };
      }
      return blocked;
    default:
      return blocked;
  }
}

/** {@link neighbourUnitInput} through `resolveUnitState`; `null` = no mark. */
export function neighbourUnitState(
  graphKind: string,
  status: string | null | undefined,
  blockedBy?: string | null
): UnitStateView | null {
  const input = neighbourUnitInput(graphKind, status, blockedBy);
  return input ? resolveUnitState(input) : null;
}

/** The one-hop slice of a neighbour the blocked rule reads. */
export interface DependencyNeighbourFact {
  graphKind: string;
  id: string;
  edgeType: string;
  direction: string;
  via: string | null;
  /** Raw status; `undefined` = not read (an older pod). */
  status?: string | null;
}

/**
 * Which neighbours are BLOCKED BY THE FOCUS right now — `X --blocked_by-->
 * focus` while the focus (or, when the focus was replaced, its replacement)
 * is still open, by {@link isBlocked}. Keys are `${graphKind}:${id}`.
 *
 * Decided only when the focus's own status was read (`focus.status !==
 * undefined`); otherwise the empty set — an unread focus never makes a row
 * claim "blocked". One hop: a replacement of the focus that was itself
 * replaced is read as a leaf.
 */
export function neighboursBlockedByFocus(
  focus: { kind: string; id: string; status?: string | null },
  neighbours: readonly DependencyNeighbourFact[]
): Set<string> {
  const out = new Set<string>();
  if (focus.status === undefined || !isDependencyEndpointKind(focus.kind)) {
    return out;
  }
  const states = new Map<string, DependencyNodeState>();
  states.set(`${focus.kind}:${focus.id}`, { status: focus.status });
  const replaces: DependencyEdge[] = [];
  for (const n of neighbours) {
    if (n.via !== "links") continue;
    if (n.edgeType === REPLACES_LINK_TYPE && n.direction === "incoming") {
      replaces.push({
        fromType: n.graphKind,
        fromId: n.id,
        toType: focus.kind,
        toId: focus.id,
        linkType: REPLACES_LINK_TYPE,
      });
      if (n.status !== undefined) {
        states.set(`${n.graphKind}:${n.id}`, { status: n.status });
      }
    }
  }
  const stateOf = (ref: DependencyNodeRef) =>
    states.get(`${ref.kind}:${ref.id}`);
  for (const n of neighbours) {
    if (
      n.via !== "links" ||
      n.edgeType !== DEPENDENCY_LINK_TYPE ||
      n.direction !== "incoming"
    ) {
      continue;
    }
    const node = { kind: n.graphKind, id: n.id };
    const edges: DependencyEdge[] = [
      {
        fromType: n.graphKind,
        fromId: n.id,
        toType: focus.kind,
        toId: focus.id,
        linkType: DEPENDENCY_LINK_TYPE,
      },
      ...replaces,
    ];
    if (isBlocked(node, edges, stateOf)) out.add(`${n.graphKind}:${n.id}`);
  }
  return out;
}
