/**
 * TRACK STAGES — the stage strip of a track (a method running inside a
 * project, `project_tracks`, 0272), derived from the stages the track PINNED at
 * start and the stage it stands on.
 *
 * ── Vocabulary: REUSED, not minted ─────────────────────────────────────────
 * `position` uses the positional subset of the stepper's `StepState`
 * (`done` | `active` | `not_started`, synap-app
 * `packages/core/session-continuation/src/workbench.ts`). That type lives in
 * synap-app, which this package cannot import, so it is NOT mirrored here as a
 * second type — this returns the minimal positional shape and a surface
 * overlays its own `waiting_on_you` / `blocked` from the packet, exactly as
 * `deriveSteps` does for a session. Never add a word here that the stepper
 * does not already use.
 *
 * ── Stages are RE-ENTERABLE ────────────────────────────────────────────────
 * A track may move back to an earlier stage. Position is therefore derived
 * from WHERE the track stands now, never from a history of stages visited:
 * everything before the current stage reads `done`, everything after reads
 * `not_started`. A current stage that names no pinned stage (or none at all)
 * reads every stage `not_started` rather than guessing.
 *
 * PURE and dependency-free (Relay, browser, CLI and pod import the same answer).
 */

import { CHECK_GATE_METADATA_KEY } from "../focus-sessions/check-gate.js";
import type { UnitStateInput, UnitTone } from "./state.js";
import {
  projectAggregateInput,
  type ProjectAggregateSessionFact,
} from "./session.js";

export type TrackStagePosition = "done" | "active" | "not_started";

export interface TrackStage {
  key: string;
  name: string;
  /** The stage's closed rollup category, when the pinned stage declares one. */
  category: string | null;
  position: TrackStagePosition;
  /** Sessions filed in this track at this stage — only when counts were given. */
  sessionCount?: number;
  // ── What the pinned stage DECLARES (0274). Each key is present only when the
  // snapshot stage carries it — absent means "not declared", never a default.
  /** The stage's own goal — the brief of a session started at this stage. */
  goal?: string;
  description?: string;
  suggestedTasks?: string[];
  /** Deliverables expected from this stage, as pinned (untyped jsonb objects). */
  expectedOutputs?: Array<Record<string, unknown>>;
  /** Acceptance criteria of this stage, as pinned (objects with a `key`). */
  criteria?: Array<Record<string, unknown> & { key: string }>;
  /** The entry gate's kind — a person approves (`human`) or a check measures. */
  gate?: "human" | "check";
  /** May the track sit in this stage indefinitely? */
  indefinite?: boolean;
  /**
   * The DOMAIN this stage is worked in: a workspace TEMPLATE slug
   * (`workspaces.package_slug`), never a workspace id, so a method stays
   * portable across pods. `startStageSession` resolves it to a live workspace.
   */
  domain?: string;
}

type ReadStage = Omit<TrackStage, "position" | "sessionCount">;

function objects(v: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter(
    (e): e is Record<string, unknown> =>
      !!e && typeof e === "object" && !Array.isArray(e)
  );
}

function readStage(raw: unknown): ReadStage | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.key !== "string" || r.key.length === 0) return null;
  const name = typeof r.name === "string" && r.name.trim() ? r.name : r.key;
  const category = typeof r.category === "string" ? r.category : null;
  const out: ReadStage = { key: r.key, name, category };
  if (typeof r.goal === "string" && r.goal.trim()) out.goal = r.goal;
  if (typeof r.description === "string" && r.description.trim()) {
    out.description = r.description;
  }
  if (Array.isArray(r.suggestedTasks)) {
    out.suggestedTasks = r.suggestedTasks.filter(
      (t): t is string => typeof t === "string" && t.trim().length > 0
    );
  }
  const outputs = objects(r.expectedOutputs);
  if (outputs) out.expectedOutputs = outputs;
  const criteria = objects(r.criteria)?.filter(
    (c): c is Record<string, unknown> & { key: string } =>
      typeof c.key === "string" && c.key.length > 0
  );
  if (criteria) out.criteria = criteria;
  const gate = r.gate as { kind?: unknown } | null | undefined;
  if (
    gate &&
    typeof gate === "object" &&
    (gate.kind === "human" || gate.kind === "check")
  ) {
    out.gate = gate.kind;
  }
  if (typeof r.indefinite === "boolean") out.indefinite = r.indefinite;
  if (typeof r.domain === "string" && r.domain.trim()) {
    out.domain = r.domain.trim();
  }
  return out;
}

/** What one pinned stage DECLARES, read by the one rule {@link deriveTrackStages} uses. */
export type TrackStageDeclaration = ReadStage;

/**
 * ONE pinned stage by key, read exactly as {@link deriveTrackStages} reads it
 * (same trimming, same "absent means not declared") — for server code that
 * needs a single stage's goal / tasks / outputs / criteria without re-reading
 * the untyped snapshot by hand. `null` when the snapshot declares no such key.
 */
export function readTrackStage(
  snapshotStages: unknown,
  key: string
): TrackStageDeclaration | null {
  if (!Array.isArray(snapshotStages)) return null;
  for (const raw of snapshotStages) {
    const stage = readStage(raw);
    if (stage?.key === key) return stage;
  }
  return null;
}

/**
 * @param snapshotStages  `project_tracks.definition_snapshot.stages` — an
 *   untyped jsonb bag; malformed entries are skipped, never thrown on.
 * @param currentStage    `project_tracks.current_stage`.
 * @param sessionsByStage optional count of the track's sessions per stage key.
 */
export function deriveTrackStages(
  snapshotStages: unknown,
  currentStage: string | null | undefined,
  sessionsByStage?: Readonly<Record<string, number>>
): TrackStage[] {
  if (!Array.isArray(snapshotStages)) return [];
  const stages = snapshotStages
    .map(readStage)
    .filter((s): s is NonNullable<typeof s> => s !== null);
  const at = currentStage
    ? stages.findIndex((s) => s.key === currentStage)
    : -1;
  return stages.map((stage, i) => ({
    ...stage,
    position: at < 0 || i > at ? "not_started" : i < at ? "done" : "active",
    ...(sessionsByStage
      ? { sessionCount: sessionsByStage[stage.key] ?? 0 }
      : {}),
  }));
}

/**
 * One stage a track ENTERED (`project_tracks.stage_history`, 0274), oldest
 * first. A re-entered stage appears again — this is a timeline, not a map.
 */
export interface TrackStageHistoryEntry {
  stageKey: string;
  /** Where it came from — `null` for the entry recorded at birth/backfill. */
  fromStage: string | null;
  /** ISO-8601. */
  enteredAt: string;
  /** The user (or agent) id that moved it. */
  actor: string;
}

/** Read the untyped jsonb history; malformed entries are skipped, never thrown on. */
export function readTrackStageHistory(raw: unknown): TrackStageHistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: TrackStageHistoryEntry[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object" || Array.isArray(e)) continue;
    const r = e as Record<string, unknown>;
    if (typeof r.stageKey !== "string" || !r.stageKey) continue;
    if (typeof r.enteredAt !== "string" || !r.enteredAt) continue;
    out.push({
      stageKey: r.stageKey,
      fromStage: typeof r.fromStage === "string" ? r.fromStage : null,
      enteredAt: r.enteredAt,
      actor: typeof r.actor === "string" ? r.actor : "",
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED TRACK RULES — one answer for the pod, Relay and the browser.
// Relay (`project-tracks.ts`) and the browser (`ProjectSidebar/sessionGroups.ts`)
// each grew a local copy of these; they live here so neither surface forks them.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A track's lifecycle status. The DB column (`project_tracks.status`,
 * `PROJECT_TRACK_STATUSES` in `@synap/database`) holds exactly these — the
 * pod's tracks service pins the two lists equal at COMPILE time.
 */
export const TRACK_STATUSES = [
  "active",
  "paused",
  "completed",
  "archived",
] as const;
export type TrackStatus = (typeof TRACK_STATUSES)[number];

/**
 * THE status transition table. The pod refuses anything not listed here
 * (`assertTrackTransition`, services/tracks); surfaces offer only these moves
 * (`trackStatusMoves`). Order is the order a surface lists the moves in.
 */
export const TRACK_STATUS_TRANSITIONS: Readonly<
  Record<TrackStatus, readonly TrackStatus[]>
> = {
  active: ["paused", "completed", "archived"],
  paused: ["active", "completed", "archived"],
  completed: ["active", "archived"],
  // Archived is FINAL: it frees the live-method slot, so reviving it could
  // collide with a newer track of the same method. Start the method again.
  archived: [],
};

/** True when `from → to` is a move the table allows (a no-op is not a move). */
export function canTransitionTrack(from: string, to: string): boolean {
  const moves = TRACK_STATUS_TRANSITIONS[from as TrackStatus];
  return !!moves && (moves as readonly string[]).includes(to);
}

/** An ACTION token for `resolveActionLabel(verb, mood)` — never a hand label. */
export type TrackStatusVerb =
  "pause" | "resume" | "reopen" | "complete" | "archive";

export interface TrackStatusMove {
  to: TrackStatus;
  verb: TrackStatusVerb;
}

function verbFor(from: TrackStatus, to: TrackStatus): TrackStatusVerb {
  if (to === "paused") return "pause";
  if (to === "completed") return "complete";
  if (to === "archived") return "archive";
  // → active: a paused track RESUMES; a completed one is REOPENED.
  return from === "completed" ? "reopen" : "resume";
}

/**
 * The status moves a surface offers from `status`, in table order. Archiving
 * is final and frees the method slot — a workbench act, not a supervising one —
 * so it is offered only with `includeArchive: true` (Relay omits it). An
 * unknown status offers nothing.
 */
export function trackStatusMoves(
  status: string,
  opts: { includeArchive?: boolean } = {}
): TrackStatusMove[] {
  const from = status as TrackStatus;
  const moves = TRACK_STATUS_TRANSITIONS[from];
  if (!moves) return [];
  return moves
    .filter((to) => opts.includeArchive === true || to !== "archived")
    .map((to) => ({ to, verb: verbFor(from, to) }));
}

/**
 * WHY a paused track is paused — projected by the pod on every track read.
 *   - `check` — a check stage gate held it (the gate's `metadata.checkGate`
 *     marker, cleared on every status change);
 *   - `human` — a person paused it, or a human stage gate awaits review;
 *   - `null`  — the track is not paused (a stale marker never leaks).
 */
export type TrackPausedBy = "check" | "human" | null;

export function trackPausedBy(track: {
  status: string;
  metadata?: unknown;
}): TrackPausedBy {
  if (track.status !== "paused") return null;
  const meta = track.metadata;
  return meta &&
    typeof meta === "object" &&
    (meta as Record<string, unknown>)[CHECK_GATE_METADATA_KEY]
    ? "check"
    : "human";
}

/** A track that takes no new work on a page: its sessions fall to the remainder. */
export function isTrackRetired(track: { status: string }): boolean {
  return track.status === "archived";
}

/**
 * A stage mark's tone. `active` is the ONE accent (`primary`) — NOT `ai`:
 * the AI colour (--synap-ai) is AI provenance only, and a human-run method's current stage is
 * not AI work. `done` is `success`; a stage not yet reached is `textMuted`.
 */
export function trackStageTone(position: TrackStagePosition): UnitTone {
  switch (position) {
    case "active":
      return "primary";
    case "done":
      return "success";
    default:
      return "textMuted";
  }
}

/**
 * A track card's state input, through the ONE derivation (`resolveUnitState`).
 *
 *   - completed / archived → `terminal` (done), whatever its sessions say;
 *   - paused               → the `paused` arm, reached the way a paused
 *                            SESSION reaches it: `{ cron: "", enabled: false }`
 *                            — an empty cron is a placeholder, never a
 *                            fabricated cadence;
 *   - otherwise            → the project aggregate, over this track's
 *                            sessions only.
 */
export function trackUnitInput(
  track: { status: string },
  sessions: readonly ProjectAggregateSessionFact[]
): UnitStateInput {
  if (track.status === "completed" || isTrackRetired(track)) {
    return { terminal: true };
  }
  if (track.status === "paused") {
    return { schedule: { cron: "", enabled: false } };
  }
  return projectAggregateInput({ sessions, unreadable: false });
}

export interface TrackSessionPartition<T, K> {
  /**
   * One group per LIVE (non-archived) track, in the order `tracks` was given,
   * INCLUDING tracks with no sessions — whether an empty track is drawn is the
   * surface's call (Relay draws a card; the browser sidebar omits it).
   */
  groups: Array<{ track: K; sessions: T[] }>;
  /** Every session in no live, listed track — in the input order. */
  remainder: T[];
}

/**
 * Partition sessions by the track they were filed in. No session ever
 * vanishes: each lands in EXACTLY one place.
 *
 *   - a session whose track is a live track in `tracks` joins its group;
 *   - a session with no track, an ARCHIVED track, or a track `tracks` does
 *     not list (not read, not visible, archived between two reads) falls to
 *     `remainder` — a lookup miss never makes a session disappear;
 *   - a duplicated track id keeps its FIRST sighting.
 *
 * `trackIdOf` defaults to `session.trackId`; pass it when the track id lives
 * elsewhere (Relay reads it off a path index).
 */
export function partitionSessionsByTrack<
  T,
  K extends { id: string; status: string },
>(
  sessions: readonly T[],
  tracks: readonly K[],
  trackIdOf: (session: T) => string | null | undefined = (s) =>
    (s as { trackId?: string | null }).trackId
): TrackSessionPartition<T, K> {
  const live = new Map<string, { track: K; sessions: T[] }>();
  for (const track of tracks) {
    if (isTrackRetired(track) || live.has(track.id)) continue;
    live.set(track.id, { track, sessions: [] });
  }
  const remainder: T[] = [];
  for (const session of sessions) {
    const id = trackIdOf(session);
    const group = id ? live.get(id) : undefined;
    if (group) group.sessions.push(session);
    else remainder.push(session);
  }
  return { groups: [...live.values()], remainder };
}
