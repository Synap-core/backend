/**
 * THE WORK GRAPH — every session a surface draws as one map, in ONE read.
 *
 * Founder decision 1 A (2026-10-26). Four readers (the browser Work map, relay
 * stands, the devbox map, agents) on three transports (tRPC, Hub REST, MCP)
 * were assembling the graph from `focusSessions.list`: newest 50 rows, edges
 * opt-in, and one `synap_get_session` per card on the agent doors. Measured
 * that day, the pod-wide map's 50 newest-started rows held 14 of the 49 open
 * work sessions, and the devbox map spent ~35 calls per 15 min on per-card
 * reads. A graph is a different SHAPE from a page (a window, not "newest N",
 * plus the far end of every edge), so it has a door of its own — but no rule
 * of its own:
 *
 *   - WHICH sessions: `sessionListConditions`, the list's ONE WHERE, with two
 *     widenings added there (`openOrSettledSince`, `ids`) rather than here.
 *   - WHAT a node carries: `projectSessionRows` (lineage, triage, kind,
 *     participants, verdict) + `attachNextMove` + `attachSessionLiveness` +
 *     `withViewerRole` — exactly what `focusSessions.list({ nextMove })`
 *     returns for the same row.
 *   - WHICH edges: the list's attach helpers — `attachSessionEdges`
 *     (declared `blocked_by`), `attachSessionOutputDependencies` (derived
 *     waits on an output), `attachSessionInteractions` (derived `triggered` /
 *     `updated`) — plus lineage (`spawned_from`) from `projectSessionRows`.
 *     Flattened to one list; nothing is derived here.
 *
 * ── THE WINDOW ──────────────────────────────────────────────────────────────
 * Open work, whatever its age, plus work settled in the last `windowHours`
 * (`coalesce(closed_at, updated_at)`, the settle clock every door uses), plus
 * the FAR END of every edge of those sessions — so "blocked by X" never points
 * at a session the map does not have. Far ends are fetched through the same
 * WHERE (same owner/roster floor, `ids` narrow, no lens), one hop: their own
 * edges are not followed, and an edge whose other end the caller cannot read
 * is not drawn. Lineage is followed child → parent only (an off-window child
 * of a window parent is not fetched: lineage is read by the child's id).
 *
 * ── HONEST TRUNCATION ───────────────────────────────────────────────────────
 * At most `WORK_GRAPH_CEILING` window sessions, open ones first (the order
 * `list({ order: "open_first" })` uses), and at most as many far ends. When
 * either is cut, `window.truncated` is true and `window.omitted` says how many
 * sessions were left out, counted with the same WHERE. A window session that
 * was cut but is the far end of an edge comes back as a far end
 * (`inWindow: false`) and is still counted in `omitted`: `omitted` counts the
 * window's sessions not returned AS window sessions.
 *
 * ── A FAILED READ IS NOT AN EMPTY ONE ───────────────────────────────────────
 * Each edge read is settled on its own (`settle`): a failure marks its
 * `sections` entry `unavailable` and contributes no edge, so "no line" and
 * "could not look" never render the same. `nextMove` and `live` carry their
 * own unavailable states per node. The node read itself (and lineage) has no
 * partial answer: if it fails, the read fails.
 */

import type { FocusSession } from "@synap/database/schema";
import type { SessionActivityLive } from "@synap-core/types/run-activity";
import type { ResolvedScope } from "../../utils/scope-filter.js";
import type {
  SessionKindFilter,
  SessionLens,
  SessionListQuery,
} from "./session-list-conditions.js";
import {
  attachSessionLiveness,
  countUserSessions,
  projectSessionRows,
  queryUserSessions,
} from "./session-list-rows.js";
import { attachSessionEdges } from "./session-blocked-by.js";
import { attachSessionOutputDependencies } from "./session-output-edges.js";
import {
  attachSessionInteractions,
  type SessionInteractionType,
} from "./session-interactions.js";
import {
  attachNextMove,
  settle,
  type SessionUnitCounts,
} from "./session-path-sections.js";
import type { ContinuationNextMove } from "./continuation-packet.js";
import { withViewerRole, type SessionViewerRole } from "./viewer-role.js";

import {
  WORK_GRAPH_CEILING,
  WORK_GRAPH_DEFAULT_WINDOW_HOURS,
  WORK_GRAPH_MAX_WINDOW_HOURS,
} from "./work-graph-window.js";

export {
  WORK_GRAPH_CEILING,
  WORK_GRAPH_DEFAULT_WINDOW_HOURS,
  WORK_GRAPH_MAX_WINDOW_HOURS,
};

/**
 * One edge, flat. Direction follows the stored or derived relation:
 *   - `blocked_by`      from = the waiting session, to = its blocker. The
 *                       same edge IS the blocker's "unblocks": one edge, read
 *                       from either end, never listed twice.
 *   - `spawned_from`    from = the child, to = the parent.
 *   - `waits_on_output` from = the session taking the output as input, to = the
 *                       open session producing it; `entityId` = the output.
 *   - `triggered`       from = the session whose write fired the run, to = the run.
 *   - `updated`         from = the producer, to = the session that wrote to its
 *                       output (`session-interactions.ts`).
 */
export const WORK_GRAPH_EDGE_KINDS = [
  "blocked_by",
  "spawned_from",
  "waits_on_output",
  "triggered",
  "updated",
] as const satisfies ReadonlyArray<
  "blocked_by" | "spawned_from" | "waits_on_output" | SessionInteractionType
>;
export type WorkGraphEdgeKind = (typeof WORK_GRAPH_EDGE_KINDS)[number];
// A new interaction type the graph does not list stops the build: it would
// otherwise reach the wire as an edge kind no schema declares.
type _InteractionsCovered = [
  Exclude<SessionInteractionType, WorkGraphEdgeKind>,
] extends [never]
  ? true
  : never;
const _interactionsCovered: _InteractionsCovered = true;
void _interactionsCovered;

export interface WorkGraphEdge {
  kind: WorkGraphEdgeKind;
  from: string;
  to: string;
  /** `waits_on_output`: the entity waited on. */
  entityId?: string;
  /** `triggered` / `updated`: how many events back the relation. */
  count?: number;
  /** `triggered` / `updated`: the latest of them, ISO. */
  lastAt?: string | null;
}

export type WorkGraphSection =
  { status: "ok" } | { status: "unavailable"; reason: string };

/** Whether each edge read answered. `unavailable` = no edge of that kind was drawn because the read FAILED. */
export interface WorkGraphSections {
  /** Declared `blocked_by` edges. */
  blockedBy: WorkGraphSection;
  /** Derived waits on another open session's output. */
  waitsOnOutputs: WorkGraphSection;
  /** Derived `triggered` / `updated` interactions. */
  interactions: WorkGraphSection;
  /** The off-window sessions at the far end of an edge. */
  farEnds: WorkGraphSection;
}

export interface WorkGraphWindow {
  /** ISO: settled work is in the window from this instant on. */
  since: string;
  hours: number;
  ceiling: number;
  /** True when sessions were left out — `omitted` says how many. */
  truncated: boolean;
  /** Sessions the window (or an edge) selected that this read did not return. */
  omitted: number;
}

/** One node: the list row (`focusSessions.list({ nextMove: true })`), plus whether it is IN the window or only the far end of an edge. */
export type WorkGraphNode = Awaited<
  ReturnType<typeof projectSessionRows>
>[number] & {
  nextMove: ContinuationNextMove;
  unitFacts: SessionUnitCounts;
  live: SessionActivityLive | null;
  viewerRole: SessionViewerRole;
  inWindow: boolean;
};

export interface WorkGraph {
  nodes: WorkGraphNode[];
  edges: WorkGraphEdge[];
  sections: WorkGraphSections;
  window: WorkGraphWindow;
}

export interface BuildWorkGraphInput {
  /** The person whose graph this is (the floor). */
  userId: string;
  /** Workspace and/or project lens; both absent = pod-wide. */
  scope: ResolvedScope;
  /** Settled work from this many hours back. Clamped to 1…`WORK_GRAPH_MAX_WINDOW_HOURS`. */
  windowHours?: number;
  /** Population of the WINDOW (far ends are any kind). */
  kind: SessionKindFilter;
  /** Triage lens of the WINDOW (far ends are any lens). */
  lens: SessionLens;
  /** Honour the human-roster branch — `rosterReadFor(ctx)`, as the list does. */
  roster: boolean;
}

const LOG = { door: "focusSessions.graph" };

/** A settled read's status, without its value. */
function sectionOf(
  s: { status: "ok" } | { status: "unavailable"; reason: string }
): WorkGraphSection {
  return s.status === "ok"
    ? { status: "ok" }
    : { status: "unavailable", reason: s.reason };
}

export async function buildWorkGraph(
  input: BuildWorkGraphInput
): Promise<WorkGraph> {
  const { userId, scope, kind, lens, roster } = input;
  const hours = Math.min(
    Math.max(
      Math.floor(input.windowHours ?? WORK_GRAPH_DEFAULT_WINDOW_HOURS),
      1
    ),
    WORK_GRAPH_MAX_WINDOW_HOURS
  );
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();

  // ── The window: one WHERE, open first, at most the ceiling; a full page
  // asks the count (same WHERE) how many it left out.
  const windowQuery: SessionListQuery = {
    userId,
    scope,
    status: "all",
    openOrSettledSince: since,
    kind,
    lens,
    roster,
  };
  const windowRows = await queryUserSessions(
    windowQuery,
    WORK_GRAPH_CEILING,
    "open_first"
  );
  const windowTotal =
    windowRows.length < WORK_GRAPH_CEILING
      ? windowRows.length
      : await countUserSessions(windowQuery);
  const windowNodes = await projectSessionRows(windowRows, userId);

  // ── The edges of the window, each read settled on its own.
  const ids = windowRows.map((r) => ({ id: r.id }));
  const [declared, outputs] = await Promise.all([
    settle(
      LOG,
      "blockedBy",
      "Which sessions wait on which could not be read.",
      () => attachSessionEdges(ids)
    ),
    settle(
      LOG,
      "waitsOnOutputs",
      "Which sessions wait on another's output could not be read.",
      () => attachSessionOutputDependencies(ids, userId)
    ),
  ]);

  const edges: WorkGraphEdge[] = [];
  const seen = new Set<string>();
  const push = (edge: WorkGraphEdge) => {
    const key = `${edge.kind}|${edge.from}|${edge.to}|${edge.entityId ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(edge);
  };
  for (const n of windowNodes) {
    if (n.parentSessionId) {
      push({ kind: "spawned_from", from: n.id, to: n.parentSessionId });
    }
  }
  if (declared.status === "ok") {
    for (const r of declared.value) {
      for (const b of r.blockedBy)
        push({ kind: "blocked_by", from: r.id, to: b });
      for (const w of r.unblocks)
        push({ kind: "blocked_by", from: w, to: r.id });
    }
  }
  if (outputs.status === "ok") {
    for (const r of outputs.value) {
      for (const w of r.waitsOnOutputs) {
        push({
          kind: "waits_on_output",
          from: r.id,
          to: w.producerSessionId,
          entityId: w.entityId,
        });
      }
      for (const d of r.outputsWaitedOnBy) {
        push({
          kind: "waits_on_output",
          from: d.dependentSessionId,
          to: r.id,
          entityId: d.entityId,
        });
      }
    }
  }

  // ── The far ends: through the same WHERE, any kind, any lens, no lens scope.
  const inWindow = new Set(windowRows.map((r) => r.id));
  const farIds = [...new Set(edges.flatMap((e) => [e.from, e.to]))].filter(
    (id) => !inWindow.has(id)
  );
  let omitted = windowTotal - windowRows.length;
  let farRows: FocusSession[] = [];
  let farEnds: WorkGraphSection = { status: "ok" };
  if (farIds.length > 0) {
    const farQuery: SessionListQuery = {
      userId,
      scope: { workspaceLens: undefined, projectLens: undefined },
      status: "all",
      kind: "all",
      lens: "all",
      roster,
      ids: farIds,
    };
    const far = await settle(
      LOG,
      "farEnds",
      "The sessions at the other end of these edges could not be read.",
      async () => {
        const rows = await queryUserSessions(
          farQuery,
          WORK_GRAPH_CEILING,
          "open_first"
        );
        const readable =
          rows.length < WORK_GRAPH_CEILING
            ? rows.length
            : await countUserSessions(farQuery);
        return { rows, cut: readable - rows.length };
      }
    );
    if (far.status === "ok") {
      farRows = far.value.rows;
      omitted += far.value.cut;
    } else {
      farEnds = { status: "unavailable", reason: far.reason };
    }
  }
  const farNodes = await projectSessionRows(farRows, userId);
  // A far end's own lineage is drawn when its parent is held too (one hop:
  // the parent is never fetched for it).
  for (const n of farNodes) {
    if (n.parentSessionId) {
      push({ kind: "spawned_from", from: n.id, to: n.parentSessionId });
    }
  }

  // ── Every node gets the list's per-row projections, in one batch each.
  const all = [
    ...windowNodes.map((n) => ({ ...n, inWindow: true })),
    ...farNodes.map((n) => ({ ...n, inWindow: false })),
  ];
  const withMove = await attachNextMove(all, { userId, logContext: LOG });
  const withLive = await attachSessionLiveness<
    (typeof withMove)[number] & { live?: SessionActivityLive | null }
  >(withMove, { userId, roster });
  const nodes: WorkGraphNode[] = withLive.map((n) =>
    withViewerRole({ ...n, live: n.live ?? null }, userId)
  );

  // Interactions are derived among the nodes (both ends on the read).
  const withInteractions = await attachSessionInteractions(
    nodes.map((n) => ({ id: n.id }))
  );
  // One read for every row: a failure marks every row, so the first says it.
  const interactions = sectionOf(
    withInteractions[0]?.interactions ?? { status: "ok" }
  );
  for (const r of withInteractions) {
    if (r.interactions.status !== "ok") continue;
    for (const i of r.interactions.items) {
      push({
        kind: i.type,
        from: i.fromSessionId,
        to: i.toSessionId,
        count: i.count,
        lastAt: i.lastAt,
      });
    }
  }

  // An edge is drawn only between two nodes the caller holds.
  const held = new Set(nodes.map((n) => n.id));
  const drawn = edges.filter((e) => held.has(e.from) && held.has(e.to));

  return {
    nodes,
    edges: drawn,
    sections: {
      blockedBy: sectionOf(declared),
      waitsOnOutputs: sectionOf(outputs),
      interactions,
      farEnds,
    },
    window: {
      since,
      hours,
      ceiling: WORK_GRAPH_CEILING,
      truncated: omitted > 0,
      omitted,
    },
  };
}
