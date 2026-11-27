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
 *     `attachSessionHolder` + `withViewerRole` — exactly what
 *     `focusSessions.list({ nextMove })` returns for the same row.
 *   - WHICH edges: the list's attach helpers — `attachSessionEdges`
 *     (declared `blocked_by`), `attachSessionOrchestration` (declared
 *     `orchestrated_by`), `attachSessionOutputDependencies` (derived
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
 * With no `kind` named, the window leaves out CLOSED automation runs
 * (`closedAutomationRunWhere`): open, failed and cancelled runs stay, and a
 * run at the far end of an edge is still fetched (far ends are any kind).
 * A `kind` named explicitly, `all` included, keeps them.
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
 * ── A KEY NARROWED BY ITS GRANT ─────────────────────────────────────────────
 * A pod app reads the graph through its grant (`workGraphReach`, founder
 * decision D1, 17 Nov 2026): the WHERE's floor already ANDs the grant, so its
 * nodes are the sessions it reads; `window.omittedByGrant` counts the ones the
 * person sees in the same window that it does not (also in `omitted`). The
 * parts that read past the grant (next move, interactions, waits on an
 * output, PR facts, goals; holder and liveness without `agent.read`) are
 * withheld: a section `unavailable` with `WORK_GRAPH_WITHHELD_REASON`, a node
 * move `unknown`, never an empty answer. An edge is drawn only when the key
 * reads BOTH ends (`orchestrated_by` included), and a node's
 * `parentSessionId` is kept only when that parent is a node too: a parent
 * the key does not hold reads `null`, so its id never leaks (a far end's
 * parent is never fetched, one hop, so it reads `null` as well).
 *
 * ── ONE GOAL OR ONE WAVE ────────────────────────────────────────────────────
 * `focus` narrows the WINDOW (design rule 8: graph one goal or wave, list the
 * fleet): `{ trackId }` keeps the sessions filed in that goal (the list's own
 * `trackId` narrow), `{ rootSessionId }` keeps a wave, the root and every
 * session spawned under it (`spawned_from`, followed parent → child; the
 * list's `waveRootId` narrow). Far ends
 * are still fetched, so a wave blocked by another goal's session still says so.
 * Under a focus the SETTLE WINDOW is lifted (a pathway, B4): a year-long plan
 * keeps the steps it closed long ago, so every session of the goal or wave
 * comes back whatever its age, open first, still bounded by the ceiling and
 * said by `window.allSettled` (`truncated` / `omitted` as ever).
 *
 * ── ONE PLAYBOOK OR ONE THING ──────────────────────────────────────────────
 * Two more narrows of the WINDOW, both clauses of the list's ONE WHERE (never
 * a filter here), combinable with `focus` and with each other:
 *   - `playbookId`: the sessions that FOLLOW that playbook, run from it OR
 *     filed in a goal whose method it is (`sessionFollowsPlaybookWhere`,
 *     founder decision D2). Each window node then says which way it matched
 *     (`playbookMatch`: `session` = its own playbook, `goal` = only through
 *     its goal's method), so a board places the first by the session's
 *     `currentStage` and the second by its `trackStage` on the goal's stages.
 *   - `subjectEntityId`: the sessions ON that thing, its subject or a worker
 *     targeting it (`sessionSubjectWhere`, the list's `subject` narrow).
 * Far ends are not narrowed: an edge still says what it points at.
 *
 * ── WHAT THE SESSIONS POINT AT ──────────────────────────────────────────────
 * Besides sessions, the read carries three kinds of node, each derived by the
 * rule that already owns it (`work-graph-nodes.ts`), never here:
 *   - `pullRequests`: one per PR any node recorded as an outcome
 *     (`workUnitsSection`), with the PR's own state (`withPullRequestStates`,
 *     `foldPullRequestState`), read ONCE for every node;
 *   - `holds`: the standing hold of each paused node (`listHolds`): what it
 *     waits on, why, and what resumes it;
 *   - `goals`: the goal (track) each node is filed into, under the track floor,
 *     plus the goal at the far end of a goal edge below (one hop);
 *   - `decisions` and `entities` (a pathway, B4): the decision entities and
 *     other things the nodes wait on (`blocked_by`) or are about (subject),
 *     under the entity floor; a decision carries its options and whether the
 *     person answered or is asked.
 *
 * ── EDGES BEYOND SESSIONS (B4) ──────────────────────────────────────────────
 * `blocked_by` joins any two units of work (`dependency-links.ts`). The
 * session-to-session ones come from `attachSessionEdges` as before; the
 * others (a session waiting on a decision, a thing or a goal; a goal on a
 * goal) come from `readDependencyFacts`' declared blockers, THE dependency
 * read, and `serves` (a session or goal done FOR a goal) from `readServes`.
 * Each names the kind of an end that is not a session (`fromKind`, `toKind`;
 * absent = a session, as every edge before), and is drawn only when that end
 * is in `goals`, `decisions` or `entities`. Withheld from a narrowed key.
 *
 * ── A FAILED READ IS NOT AN EMPTY ONE ───────────────────────────────────────
 * Each edge read is settled on its own (`settle`): a failure marks its
 * `sections` entry `unavailable` and contributes no edge, so "no line" and
 * "could not look" never render the same. The PR, hold and goal reads do the
 * same. `nextMove` and `live` carry their own unavailable states per node. The
 * node read itself (and lineage) has no partial answer: if it fails, the read
 * fails.
 */

import type { FocusSession } from "@synap/database/schema";
import {
  WORK_GRAPH_EDGE_KINDS,
  closedNotDoneRecorded,
  sessionClosedAs,
  type SessionClosedAs,
  type WorkGraphEdgeKind,
} from "@synap-core/types/focus-sessions";
import { stepTimeOf } from "@synap-core/types/units";
import type { WorkGraphReach } from "../../access/grant-door-fence.js";
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
  countUserSessionsForPerson,
  projectSessionRows,
  queryUserSessions,
} from "./session-list-rows.js";
import { attachSessionEdges } from "./session-blocked-by.js";
import { attachSessionOrchestration } from "./session-orchestration.js";
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
import {
  readGraphGoals,
  readGraphHolds,
  readGraphPullRequests,
  readGraphServes,
  readGraphThings,
  type WorkGraphDecision,
  type WorkGraphEntity,
  type WorkGraphGoal,
  type WorkGraphHold,
  type WorkGraphPullRequest,
} from "./work-graph-nodes.js";
import {
  followReplacements,
  readDependencyFacts,
} from "../links/dependency-links.js";
import { withViewerRole, type SessionViewerRole } from "./viewer-role.js";
import { projectTriage } from "./triage.js";
import { notTakenRecorded } from "./session-closed-as.js";
import {
  attachSessionHolder,
  type SessionHolderSection,
} from "./session-holder.js";

import { resolveSessionSubject } from "./session-subject.js";

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
export type {
  WorkGraphDecision,
  WorkGraphEntity,
  WorkGraphGoal,
  WorkGraphHold,
  WorkGraphPullRequest,
};

/**
 * One edge, flat. Direction follows the stored or derived relation:
 *   - `blocked_by`      from = the waiting session, to = its blocker. The
 *                       same edge IS the blocker's "unblocks": one edge, read
 *                       from either end, never listed twice. Either end may
 *                       be a goal, and the blocker a decision or a thing
 *                       (`fromKind` / `toKind`).
 *   - `spawned_from`    from = the child, to = the parent.
 *   - `orchestrated_by` from = the coordinated session, to = its orchestrator
 *                       (`start-orchestrator.ts`): the orchestrator holds it
 *                       until the person approves the merged plan.
 *   - `waits_on_output` from = the session taking the output as input, to = the
 *                       open session producing it; `entityId` = the output.
 *   - `triggered`       from = the session whose write fired the run, to = the run.
 *   - `updated`         from = the producer, to = the session that wrote to its
 *                       output (`session-interactions.ts`).
 *   - `serves`          from = a session or a goal (`fromKind: "track"`), to =
 *                       the goal it is done for (`toKind: "track"`).
 *   - `replaces`        from = the REPLACEMENT step, to = the step it replaces
 *                       (`X --replaces--> blocker`). Only the walk INTO the
 *                       declared session blockers of the window
 *                       (`followReplacements`, THE walk `deriveOpenBlockers`
 *                       reads), session to session.
 */
export { WORK_GRAPH_EDGE_KINDS, type WorkGraphEdgeKind };
// The list is declared once in `@synap-core/types/focus-sessions` (the apps
// import it); a kind this read cannot produce stops the build here.
const _kindsKnown: ReadonlyArray<
  | "blocked_by"
  | "spawned_from"
  | "orchestrated_by"
  | "waits_on_output"
  | SessionInteractionType
  | "serves"
  | "replaces"
> = WORK_GRAPH_EDGE_KINDS;
void _kindsKnown;
// A new interaction type the graph does not list stops the build: it would
// otherwise reach the wire as an edge kind no schema declares.
type _InteractionsCovered = [
  Exclude<SessionInteractionType, WorkGraphEdgeKind>,
] extends [never]
  ? true
  : never;
const _interactionsCovered: _InteractionsCovered = true;
void _interactionsCovered;

/** What an edge end is when it is not a session (B4). */
export type WorkGraphEndKind = "entity" | "track";

export interface WorkGraphEdge {
  kind: WorkGraphEdgeKind;
  from: string;
  to: string;
  /** ABSENT = `from` is a session (every edge an older pod sent). `track` = a goal in `goals`. */
  fromKind?: "track";
  /**
   * ABSENT = `to` is a session. `entity` = a decision in `decisions` or a
   * thing in `entities`; `track` = a goal in `goals`.
   */
  toKind?: WorkGraphEndKind;
  /** `waits_on_output`: the entity waited on. */
  entityId?: string;
  /** `triggered` / `updated`: how many events back the relation. */
  count?: number;
  /** `triggered` / `updated`: the latest of them, ISO. */
  lastAt?: string | null;
  /** `serves`: the goal criterion the session serves, when the edge names one. */
  criterionKey?: string;
  /**
   * `blocked_by` to a decision (`toKind: "entity"`): the option this step is
   * the ARM of (`links.metadata.option`, decision arms P5). Taken when the
   * decision chooses it; another choice skips the step. Absent = a plain wait.
   */
  option?: string;
}

export type WorkGraphSection =
  { status: "ok" } | { status: "unavailable"; reason: string };

/** Whether each edge read answered. `unavailable` = no edge of that kind was drawn because the read FAILED. */
export interface WorkGraphSections {
  /** Declared `blocked_by` edges. */
  blockedBy: WorkGraphSection;
  /** Declared `orchestrated_by` edges (who coordinates whom). */
  orchestration: WorkGraphSection;
  /** Derived waits on another open session's output. */
  waitsOnOutputs: WorkGraphSection;
  /** Derived `triggered` / `updated` interactions. */
  interactions: WorkGraphSection;
  /** The off-window sessions at the far end of an edge. */
  farEnds: WorkGraphSection;
  /** The PRs the nodes recorded, and their state. */
  pullRequests: WorkGraphSection;
  /** The standing holds of the nodes. */
  holds: WorkGraphSection;
  /** The goals the nodes are filed into, and those at the far end of a goal edge. */
  goals: WorkGraphSection;
  /** Declared `blocked_by` edges with an end that is not a session (B4). */
  crossKind: WorkGraphSection;
  /** `serves` edges: the goals the nodes and their goals are done for (B4). */
  serves: WorkGraphSection;
  /** The decisions the nodes wait on or are about (B4). */
  decisions: WorkGraphSection;
  /** The other things the nodes wait on or are about (B4). */
  entities: WorkGraphSection;
}

export interface WorkGraphWindow {
  /** ISO: settled work is in the window from this instant on (not with `allSettled`). */
  since: string;
  hours: number;
  /**
   * True under a goal or wave focus: settled work of ANY age is in the
   * window (a pathway keeps its old steps), and `since` / `hours` limit
   * nothing. Still bounded by `ceiling`.
   */
  allSettled: boolean;
  ceiling: number;
  /** True when sessions were left out — `omitted` says how many. */
  truncated: boolean;
  /** Sessions the window (or an edge) selected that this read did not return. */
  omitted: number;
  /**
   * Of `omitted`, the sessions the PERSON could see here that the calling
   * key's grant does not cover (`workGraphReach`): never returned, only
   * counted. 0 for a person and for a key that reads the graph whole.
   */
  omittedByGrant: number;
}

/** One node: the list row (`focusSessions.list({ nextMove: true })`), plus whether it is IN the window or only the far end of an edge. */
export type WorkGraphNode = Awaited<
  ReturnType<typeof projectSessionRows>
>[number] & {
  nextMove: ContinuationNextMove;
  unitFacts: SessionUnitCounts;
  live: SessionActivityLive | null;
  /**
   * Who has it now (`readSessionHolder`'s derivation, `attachSessionHolder`):
   * `unavailable` when a fact it needs could not be read, never "nobody".
   */
  holder: SessionHolderSection;
  viewerRole: SessionViewerRole;
  inWindow: boolean;
  /**
   * The step's time, lifted off `metadata` (`stepTimeOf`; only a valid date).
   * ABSENT = none declared (or a pod from before these fields).
   */
  plannedFor?: string;
  dueBy?: string;
  /**
   * How it ended (`sessionClosedAs`, one derivation with the dependency rule:
   * `done`, or `not_done` for a close-anyway / a failed or cancelled end).
   * ABSENT = not ended (or a pod from before this field: a reader then reads a
   * closed step as done, as `deriveStepReadiness` does).
   */
  closedAs?: SessionClosedAs;
  /**
   * With the `playbookId` narrow, how this window node follows it: `session`
   * = its own `playbookId` is the playbook, `goal` = only through the method
   * of the goal it is filed in; `null` on a far end (far ends are not
   * narrowed). ABSENT without the narrow: there is nothing to match.
   */
  playbookMatch?: WorkGraphPlaybookMatch | null;
  /**
   * It ended as a decision's arm NOT taken (P5, `notTakenRecorded`): the
   * readiness rule's `skipped`, never a plain cancel. Absent otherwise.
   */
  skipped?: true;
};

/** How a node follows the graph's `playbookId` narrow (see {@link WorkGraphNode.playbookMatch}). */
export type WorkGraphPlaybookMatch = "session" | "goal";

/**
 * THE APP NODE — what the apps' tRPC door (`focusSessions.graph`) sends per
 * node. A full node is the whole list row (~6.5 KB measured on the founder's
 * pod, 26 Nov 2026: `expectedOutputs` 1.5 KB, `metadata` 0.9 KB, `stages`
 * 0.5 KB, `criteria` 0.4 KB), and the apps draw the map from a handful of its
 * fields (`@synap-core/headless/work-graph` `WorkGraphNodeInput`, the browser
 * work map, the session packet's siblings). The read still builds the full
 * node (its next move, holder and PR facts need those fields); only the
 * tRPC wire is narrowed. Hub REST forwards the full node (a pod app reads
 * `stages`, `expectedOutputs`, `criteria` and `metadata` from it); MCP has
 * its own lean projection.
 *
 * Every node field is CLASSIFIED below, kept or left off, so a new field
 * stops the build until someone decides which (`_appNodeClassified`).
 */
export const WORK_GRAPH_APP_NODE_FIELDS = [
  "id",
  "title",
  // The name's fallback (`resolveSessionTitle`).
  "goal",
  "status",
  "kind",
  "workspaceId",
  "projectId",
  "trackId",
  "trackStage",
  "playbookId",
  "currentStage",
  "parentSessionId",
  "subjectEntityId",
  "progress",
  "startedAt",
  "updatedAt",
  "closedAt",
  "nextMove",
  "unitFacts",
  "live",
  "holder",
  "viewerRole",
  "inWindow",
  "playbookMatch",
  "skipped",
  "plannedFor",
  "dueBy",
  "closedAs",
] as const satisfies ReadonlyArray<keyof WorkGraphNode>;

/** Read by the graph itself, never by an app from a node: left off the tRPC wire. */
const WORK_GRAPH_APP_NODE_LEFT_OFF = [
  "expectedOutputs",
  "metadata",
  "stages",
  "criteria",
  "stageHistory",
  "verificationReport",
  "verdict",
  "participants",
  "triage",
  "origin",
  "userId",
  "correlationId",
  "templateId",
  "channelId",
  "agentIds",
  "oneLivePerSubject",
  "createdAt",
] as const satisfies ReadonlyArray<keyof WorkGraphNode>;
type _AppNodeClassified =
  Exclude<
    keyof WorkGraphNode,
    | (typeof WORK_GRAPH_APP_NODE_FIELDS)[number]
    | (typeof WORK_GRAPH_APP_NODE_LEFT_OFF)[number]
  > extends never
    ? true
    : never;
const _appNodeClassified: _AppNodeClassified = true;
void _appNodeClassified;

export type WorkGraphAppNode = Pick<
  WorkGraphNode,
  (typeof WORK_GRAPH_APP_NODE_FIELDS)[number]
>;

/** One node as the apps' tRPC door sends it: the kept fields, an absent one stays absent. */
export function toWorkGraphAppNode(node: WorkGraphNode): WorkGraphAppNode {
  const out: Record<string, unknown> = {};
  for (const key of WORK_GRAPH_APP_NODE_FIELDS) {
    if (key in node) out[key] = node[key];
  }
  return out as WorkGraphAppNode;
}

export interface WorkGraph {
  nodes: WorkGraphNode[];
  edges: WorkGraphEdge[];
  pullRequests: WorkGraphPullRequest[];
  holds: WorkGraphHold[];
  goals: WorkGraphGoal[];
  /** The decisions the nodes wait on or are about (B4). */
  decisions: WorkGraphDecision[];
  /** The other things the nodes wait on or are about: subjects, blockers (B4). */
  entities: WorkGraphEntity[];
  sections: WorkGraphSections;
  window: WorkGraphWindow;
}

/** ONE goal's sessions, or ONE wave: a root and every session spawned under it. */
export type WorkGraphFocus = { trackId: string } | { rootSessionId: string };

export interface BuildWorkGraphInput {
  /** The person whose graph this is (the floor). */
  userId: string;
  /** Workspace and/or project lens; both absent = pod-wide. */
  scope: ResolvedScope;
  /** Settled work from this many hours back. Clamped to 1…`WORK_GRAPH_MAX_WINDOW_HOURS`. */
  windowHours?: number;
  /**
   * Population of the WINDOW (far ends are any kind). ABSENT = the default
   * window: every kind EXCEPT closed automation runs
   * (`closedAutomationRunWhere`, founder default 26 Nov 2026: one automation
   * closing ~2,000 runs a day buried the map's other work under the
   * ceiling). Named explicitly, `all` included, the window keeps them.
   */
  kind?: SessionKindFilter;
  /** Triage lens of the WINDOW (far ends are any lens). */
  lens: SessionLens;
  /** Honour the human-roster branch — `rosterReadFor(ctx)`, as the list does. */
  roster: boolean;
  /**
   * The workspace a workspace-bound key is pinned to (`keyWorkspaceId`). The
   * door already clamps the window's lens to it; this keeps the FAR ENDS in
   * it too, so an edge never carries a bound key into another space. Absent
   * for an unbound key: its far ends are read with no lens.
   */
  boundWorkspaceId?: string;
  /** Narrow the window to one goal or one wave (see the header). */
  focus?: WorkGraphFocus;
  /**
   * Narrow the window to the sessions that follow this playbook: run from it,
   * or filed in a goal whose method it is (see the header).
   */
  playbookId?: string;
  /** Narrow the window to the sessions on this thing (see the header). */
  subjectEntityId?: string;
  /**
   * What the calling key's grant lets the graph draw (`workGraphReach`).
   * Absent = whole (a person, or a key that reads every subject). Narrowed:
   * the nodes are the sessions the grant reads, and the parts that read past
   * it are withheld, each said so (see `workGraphReach`).
   */
  reach?: WorkGraphReach;
}

/** The reason every part withheld from a narrowed key carries. */
export const WORK_GRAPH_WITHHELD_REASON =
  "Withheld: this key's grant does not read everything this part needs.";

const LOG = { door: "focusSessions.graph" };

/** A settled read's status, without its value. */
/**
 * What a step's readiness reads off its row, beside `status` and `skipped`:
 * `plannedFor` / `dueBy` (`stepTimeOf`, valid dates only) and `closedAs`
 * (`sessionClosedAs`: ONE derivation with the dependency rule). Each is left
 * out when it has nothing to say.
 */
function stepFactsOf(row: {
  status: string | null;
  metadata?: unknown;
  verificationReport?: unknown;
}): { plannedFor?: string; dueBy?: string; closedAs?: SessionClosedAs } {
  const time = stepTimeOf(row.metadata);
  const closedAs = sessionClosedAs(
    row.status,
    closedNotDoneRecorded(row.verificationReport)
  );
  return {
    ...(time.plannedFor ? { plannedFor: time.plannedFor } : {}),
    ...(time.dueBy ? { dueBy: time.dueBy } : {}),
    ...(closedAs ? { closedAs } : {}),
  };
}

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
  const { userId, scope, lens, roster } = input;
  const kind = input.kind ?? "all";
  const narrowed = input.reach && !input.reach.whole ? input.reach : null;
  const withheld = {
    status: "unavailable" as const,
    reason: WORK_GRAPH_WITHHELD_REASON,
  };
  const hours = Math.min(
    Math.max(
      Math.floor(input.windowHours ?? WORK_GRAPH_DEFAULT_WINDOW_HOURS),
      1
    ),
    WORK_GRAPH_MAX_WINDOW_HOURS
  );
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();

  // ── The window: one WHERE, open first, at most the ceiling; a full page
  // asks the count (same WHERE) how many it left out. A goal or a wave keeps
  // its settled work of any age (B4): no settle window under a focus.
  const focus = input.focus;
  const allSettled = !!focus;
  const windowQuery: SessionListQuery = {
    userId,
    scope,
    status: "all",
    ...(allSettled ? {} : { openOrSettledSince: since }),
    kind,
    lens,
    roster,
    ...(input.kind === undefined ? { withoutClosedAutomationRuns: true } : {}),
    ...(focus && "trackId" in focus ? { trackId: focus.trackId } : {}),
    ...(focus && "rootSessionId" in focus
      ? { waveRootId: focus.rootSessionId }
      : {}),
    ...(input.playbookId ? { followsPlaybookId: input.playbookId } : {}),
    ...(input.subjectEntityId
      ? {
          subject: await resolveSessionSubject({
            entityIds: [input.subjectEntityId],
          }),
        }
      : {}),
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
  // A narrowed key: how many sessions the PERSON sees in this window that the
  // grant does not, counted with the same WHERE without the grant. A count,
  // never a row (`countUserSessionsForPerson`). Counted over
  // the WINDOW, the map's population: a far end the grant does not read is
  // a window session (counted here) or settled before the window (not part
  // of the map); either way the edge to it is not drawn.
  const omittedByGrant = narrowed
    ? Math.max(0, (await countUserSessionsForPerson(windowQuery)) - windowTotal)
    : 0;

  // ── The edges of the window, each read settled on its own.
  const ids = windowRows.map((r) => ({ id: r.id }));
  const [declared, orchestration, outputs] = await Promise.all([
    settle(
      LOG,
      "blockedBy",
      "Which sessions wait on which could not be read.",
      () => attachSessionEdges(ids)
    ),
    // Session to session only: drawn for a narrowed key between two
    // sessions it reads, like `blocked_by`.
    settle(
      LOG,
      "orchestration",
      "Which sessions an orchestrator coordinates could not be read.",
      () => attachSessionOrchestration(ids)
    ),
    // Names the output entity: withheld from a narrowed key.
    narrowed
      ? Promise.resolve(withheld)
      : settle(
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
  // `replaces`: THE walk INTO each declared session blocker of the window
  // (`followReplacements`, the one `deriveOpenBlockers` reads), so a reader
  // applying the rule sees a re-planned blocker released. A failed walk
  // marks the `blockedBy` section unavailable: the blockers are then
  // unknown, never cleared.
  const windowIds = new Set(ids.map((r) => r.id));
  const declaredBlockers =
    declared.status === "ok"
      ? [
          ...new Set(
            declared.value.flatMap((r) =>
              windowIds.has(r.id) ? r.blockedBy : []
            )
          ),
        ]
      : [];
  const replaces = await settle(
    LOG,
    "blockedBy",
    "Which blockers were replaced could not be read.",
    () => {
      const seen = new Set(declaredBlockers.map((id) => `session:${id}`));
      return followReplacements(
        declaredBlockers.map((id) => ({ kind: "session", id })),
        seen
      );
    }
  );
  if (replaces.status === "ok") {
    for (const e of replaces.value) {
      if (e.fromType !== "session" || e.toType !== "session") continue;
      push({ kind: "replaces", from: e.fromId, to: e.toId });
    }
  }
  if (orchestration.status === "ok") {
    for (const r of orchestration.value) {
      for (const o of r.orchestratedBy)
        push({ kind: "orchestrated_by", from: r.id, to: o });
      for (const c of r.orchestrates)
        push({ kind: "orchestrated_by", from: c, to: r.id });
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

  // ── The far ends: through the same WHERE, any kind, any lens, no lens scope
  // (a bound key's far ends stay in its workspace).
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
      scope: {
        workspaceLens: input.boundWorkspaceId,
        projectLens: undefined,
      },
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
  // The next move reads proposals, room inboxes and cross-kind blockers:
  // withheld from a narrowed key (`unknown`, counts `null` = not read).
  const withMove = narrowed
    ? all.map((n) => ({
        ...n,
        nextMove: {
          kind: "unknown" as const,
          actor: "none" as const,
          label: "Not shown to this app",
          reason: WORK_GRAPH_WITHHELD_REASON,
        },
        unitFacts: {
          owedFromYou: null,
          pendingDecisions: null,
          awaitingReview: false,
          draft: projectTriage(n).pending,
        } satisfies SessionUnitCounts,
      }))
    : await attachNextMove(all, {
        userId,
        roster,
        lens: input.boundWorkspaceId,
        logContext: LOG,
      });
  // Who has it, through the session read's own derivation; the liveness just
  // attached is reused, never read twice. A narrowed key reads both only when
  // it reads the person's agents (`sessionHolderReadable`).
  const withHolder =
    narrowed && !narrowed.holder
      ? withMove.map((n) => ({
          ...n,
          live: null,
          holder: withheld as SessionHolderSection,
        }))
      : await attachSessionHolder(
          (
            await attachSessionLiveness<
              (typeof withMove)[number] & { live?: SessionActivityLive | null }
            >(withMove, { userId, roster })
          ).map((n) => ({ ...n, live: n.live ?? null })),
          // A bound key's PR facts stay in its workspace, as the PR nodes' do.
          { userId, roster, lens: input.boundWorkspaceId }
        );
  // A window node passed the WHERE, so it follows the playbook one way or
  // the other: its own playbook first, else its goal's method. Without the
  // narrow there is nothing to match, and the field is left out.
  const playbookId = input.playbookId;
  const projected: WorkGraphNode[] = withHolder.map((n) => ({
    ...withViewerRole(n, userId),
    ...(notTakenRecorded(n) ? { skipped: true as const } : {}),
    ...stepFactsOf(n),
    ...(playbookId
      ? {
          playbookMatch: !n.inWindow
            ? null
            : n.playbookId === playbookId
              ? ("session" as const)
              : ("goal" as const),
        }
      : {}),
  }));

  // A narrowed key keeps a node's parent only when it holds that parent: a
  // parent it does not read is never named (its edge is not drawn either).
  const projectedIds = new Set(projected.map((n) => n.id));
  const nodes: WorkGraphNode[] = narrowed
    ? projected.map((n) =>
        n.parentSessionId && !projectedIds.has(n.parentSessionId)
          ? { ...n, parentSessionId: null }
          : n
      )
    : projected;

  // Interactions are derived among the nodes (both ends on the read), from
  // events and automation runs: withheld from a narrowed key.
  const withInteractions = narrowed
    ? []
    : await attachSessionInteractions(nodes.map((n) => ({ id: n.id })));
  // One read for every row: a failure marks every row, so the first says it.
  const interactions: WorkGraphSection = narrowed
    ? withheld
    : sectionOf(withInteractions[0]?.interactions ?? { status: "ok" });
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

  // ── What the nodes point at: PRs, holds, the edges beyond sessions, then
  // the goals, decisions and things at their ends, each read settled on its
  // own.
  const sessionIds = nodes.map((n) => n.id);
  const filedTrackIds = [
    ...new Set(nodes.flatMap((n) => (n.trackId ? [n.trackId] : []))),
  ];
  const [prs, holds, dependencies, serves] = await Promise.all([
    // The PR facts are events: a workspace-bound key reads them under its own
    // workspace floor, the one the far ends already use.
    readGraphPullRequests(
      nodes,
      { userId, roster, lens: input.boundWorkspaceId },
      narrowed ? WORK_GRAPH_WITHHELD_REASON : undefined
    ),
    settle(
      LOG,
      "holds",
      "What the paused sessions wait on could not be read.",
      () => readGraphHolds(sessionIds)
    ),
    // THE dependency read (`readDependencyFacts`, the batch of
    // `readDependencyState`): every blocker the nodes and their goals
    // declared. Reads entities and goals: withheld from a narrowed key.
    narrowed
      ? Promise.resolve(withheld)
      : settle(
          LOG,
          "crossKind",
          "What these sessions and goals wait on, beside sessions, could not be read.",
          () =>
            readDependencyFacts(
              [
                ...sessionIds.map((id) => ({ kind: "session", id })),
                ...filedTrackIds.map((id) => ({ kind: "track", id })),
              ],
              userId
            )
        ),
    narrowed
      ? Promise.resolve(withheld)
      : settle(
          LOG,
          "serves",
          "Which goals these sessions and goals serve could not be read.",
          () => readGraphServes(sessionIds, filedTrackIds, userId)
        ),
  ]);

  // The edges beyond sessions. Session to session `blocked_by` is drawn
  // above (`attachSessionEdges`); only an edge with another kind of end is
  // added here, each end named by its kind.
  const beyond: WorkGraphEdge[] = [];
  if (dependencies.status === "ok") {
    for (const [key, facts] of dependencies.value) {
      const i = key.indexOf(":");
      const fromKind = key.slice(0, i);
      const from = key.slice(i + 1);
      for (const b of facts.declared) {
        // Drawn above (`attachSessionEdges`), or a kind no node draws.
        if (fromKind === "session" && b.kind === "session") continue;
        if (b.kind !== "session" && b.kind !== "entity" && b.kind !== "track")
          continue;
        beyond.push({
          kind: "blocked_by",
          from,
          to: b.id,
          ...(fromKind === "track" ? { fromKind: "track" as const } : {}),
          ...(b.kind === "entity"
            ? { toKind: "entity" as const }
            : b.kind === "track"
              ? { toKind: "track" as const }
              : {}),
          ...(b.option ? { option: b.option } : {}),
        });
      }
    }
  }
  if (serves.status === "ok") {
    for (const sv of serves.value) {
      beyond.push({
        kind: "serves",
        from: sv.from,
        to: sv.to,
        ...(sv.fromKind === "track" ? { fromKind: "track" as const } : {}),
        toKind: "track",
        ...(sv.criterionKey ? { criterionKey: sv.criterionKey } : {}),
      });
    }
  }
  // The ends they need, one hop: the goals, and the decisions and things
  // (with each node's subject).
  const trackIds = [
    ...new Set([
      ...filedTrackIds,
      ...beyond.flatMap((e) => [
        ...(e.fromKind === "track" ? [e.from] : []),
        ...(e.toKind === "track" ? [e.to] : []),
      ]),
    ]),
  ];
  const entityIds = [
    ...new Set([
      ...beyond.flatMap((e) => (e.toKind === "entity" ? [e.to] : [])),
      ...nodes.flatMap((n) => (n.subjectEntityId ? [n.subjectEntityId] : [])),
    ]),
  ];
  const [goals, things] = await Promise.all([
    narrowed && !narrowed.goals
      ? Promise.resolve(withheld)
      : settle(
          LOG,
          "goals",
          "The goals these sessions serve could not be read.",
          () => readGraphGoals(trackIds, userId)
        ),
    narrowed
      ? Promise.resolve(withheld)
      : settle(
          LOG,
          "decisions",
          "The decisions and things these sessions point at could not be read.",
          () =>
            readGraphThings(entityIds, {
              userId,
              lens: input.boundWorkspaceId,
            })
        ),
  ]);
  // An edge beyond sessions is drawn only when the caller holds both ends.
  const heldEnds = new Set<string>([
    ...[...held].map((id) => `session:${id}`),
    ...(goals.status === "ok" ? goals.value : []).map((g) => `track:${g.id}`),
    ...(things.status === "ok"
      ? [...things.value.decisions, ...things.value.entities]
      : []
    ).map((t) => `entity:${t.id}`),
  ]);
  const drawnBeyond = beyond.filter(
    (e) =>
      heldEnds.has(`${e.fromKind ?? "session"}:${e.from}`) &&
      heldEnds.has(`${e.toKind ?? "session"}:${e.to}`)
  );

  return {
    nodes,
    edges: [...drawn, ...drawnBeyond],
    pullRequests: prs.items,
    holds: holds.status === "ok" ? holds.value : [],
    goals: goals.status === "ok" ? goals.value : [],
    decisions: things.status === "ok" ? things.value.decisions : [],
    entities: things.status === "ok" ? things.value.entities : [],
    sections: {
      blockedBy: sectionOf(declared.status === "ok" ? replaces : declared),
      orchestration: sectionOf(orchestration),
      waitsOnOutputs: sectionOf(outputs),
      interactions,
      farEnds,
      pullRequests: prs.section,
      holds: sectionOf(holds),
      goals: sectionOf(goals),
      crossKind: sectionOf(dependencies),
      serves: sectionOf(serves),
      decisions: sectionOf(things),
      entities: sectionOf(things),
    },
    window: {
      since,
      hours,
      allSettled,
      ceiling: WORK_GRAPH_CEILING,
      truncated: omitted + omittedByGrant > 0,
      omitted: omitted + omittedByGrant,
      omittedByGrant,
    },
  };
}
