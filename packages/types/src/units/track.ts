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
import {
  resolveObjectNoun,
  resolveStatusLabel,
  resolveTrackStatusLabel,
  type TRACK_STATUS_LABELS,
  type TRACK_VERDICT_LABELS,
} from "../vocabulary/index.js";
import {
  TERMINAL_LIFECYCLE_CATEGORIES,
  type LifecycleCategory,
  type LifecycleOption,
} from "../lifecycle/index.js";
import type { UnitStateInput, UnitTone } from "./state.js";
import type { TrackWorkKind } from "./goal.js";
import {
  projectAggregateInput,
  type ProjectAggregateSessionFact,
} from "./session.js";

/** Every stage position, in path order — the ONE list a reader validates against. */
export const TRACK_STAGE_POSITIONS = ["done", "active", "not_started"] as const;
export type TrackStagePosition = (typeof TRACK_STAGE_POSITIONS)[number];

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
  /**
   * ISO-8601 — present only on an EMERGENT stage: one added to the running
   * track (`addTrackStage`) rather than pinned from its method at start.
   */
  addedAt?: string;
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
  if (typeof r.addedAt === "string" && r.addedAt) out.addedAt = r.addedAt;
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
  /**
   * The verdict of the entered step's `check` ENTRY gate, which measured the
   * step LEFT (`fromStage`). Present only when such a gate ran on this move;
   * absent = no check gate ran (or the move predates the stamp, U5).
   */
  check?: TrackStageCheckVerdict;
}

/** A check gate's verdict on one move (`stage_history[].check`). */
export interface TrackStageCheckVerdict {
  passed: boolean;
  /** Required criteria / outcomes not met; `CHECK_GATE_UNEVALUATED` = not measured. */
  failing: string[];
  reason?: string;
}

function readCheckVerdict(raw: unknown): TrackStageCheckVerdict | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.passed !== "boolean") return undefined;
  const failing = Array.isArray(r.failing)
    ? r.failing.filter((f): f is string => typeof f === "string")
    : [];
  return {
    passed: r.passed,
    failing,
    ...(typeof r.reason === "string" && r.reason ? { reason: r.reason } : {}),
  };
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
      ...(readCheckVerdict(r.check)
        ? { check: readCheckVerdict(r.check)! }
        : {}),
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
 * A track's status — the stored option keys of its SYSTEM LIFECYCLE (work
 * model D1, 2026-10-23). The DB column (`project_tracks.status`,
 * `PROJECT_TRACK_STATUSES` in `@synap/database`) holds exactly these — the
 * pod's tracks service pins the two lists equal at COMPILE time.
 *
 * Machine values are contracts (the CLI, IS, Control Plane, Relay and the
 * browser send them): `completed` and `archived` keep their keys; people read
 * them as "Closed" and "Dropped" (`resolveTrackStatusLabel`).
 */
export const TRACK_STATUSES = [
  "proposed",
  "agreed",
  "ready",
  "active",
  "paused",
  "completed",
  "archived",
] as const;
export type TrackStatus = (typeof TRACK_STATUSES)[number];

/**
 * THE track lifecycle, declared ONCE like a kind's lifecycle: each status's
 * fixed CATEGORY, and which one only a person may enter. Keyed by every
 * status, so a status added to {@link TRACK_STATUSES} and not classified here
 * stops the build.
 *
 *   open    proposed → agreed (criteria and bounds agreed with the doers) →
 *           ready (prerequisites clear) — R3, before work starts. `agreed`
 *           is HUMAN-ONLY: agreeing is a person's act; an agent's move into
 *           it is always a proposal (code-core F11);
 *   active  active (a new track's default);
 *   paused  paused (chosen; a check gate may also hold it);
 *   done    completed — "Closed": HUMAN-ONLY, an agent's close always
 *           becomes a proposal, whatever rule the pod has;
 *   lost    archived — "Dropped": an agent's drop proposes by default, as
 *           a move into lost does for any kind.
 * How it ended is a separate VERDICT ({@link TRACK_VERDICTS}), never more
 * statuses.
 */
export const TRACK_STATUS_DECLARATION = {
  proposed: { category: "open" },
  agreed: { category: "open", humanOnly: true },
  ready: { category: "open" },
  active: { category: "active" },
  paused: { category: "paused" },
  completed: { category: "done", humanOnly: true },
  archived: { category: "lost" },
} as const satisfies Record<
  TrackStatus,
  { category: LifecycleCategory; humanOnly?: true }
>;

/** The statuses whose category is `C` — derived from the declaration. */
export type TrackStatusIn<C extends LifecycleCategory> = {
  [K in TrackStatus]: (typeof TRACK_STATUS_DECLARATION)[K]["category"] extends C
    ? K
    : never;
}[TrackStatus];

/**
 * The track lifecycle in the lifecycle model's own shape — what the pod's
 * classifier (`classifyLifecycleMove`, the SAME one every kind's status move
 * goes through) and every surface read. Labels come from the vocabulary.
 */
export const TRACK_LIFECYCLE: {
  propertySlug: "status";
  options: LifecycleOption[];
} = {
  propertySlug: "status",
  options: TRACK_STATUSES.map((key) => {
    const d: { category: LifecycleCategory; humanOnly?: true } =
      TRACK_STATUS_DECLARATION[key];
    return {
      key,
      label: resolveTrackStatusLabel(key),
      category: d.category,
      ...(d.humanOnly ? { humanOnly: true } : {}),
    };
  }),
};

/** The category of a track status; `null` for a value no option declares. */
export function trackStatusCategory(
  status: string | null | undefined
): LifecycleCategory | null {
  if (status == null) return null;
  return Object.hasOwn(TRACK_STATUS_DECLARATION, status)
    ? TRACK_STATUS_DECLARATION[status as TrackStatus].category
    : null;
}

/**
 * THE status transition table, DERIVED from the categories (never hand-listed):
 * from any open, active or paused status a track may move to any other status;
 * a done or lost track is FINAL for the status door. Reopening a closed goal is
 * a NEW version (`reopenTrack`, linked by `replaces`), never a move back — so a
 * closed track keeps its verdict, and a dropped one frees its live NAME
 * (0317) without ever colliding with a newer live track of that name.
 * Order is the order a surface lists the moves in (the status order).
 */
export const TRACK_STATUS_TRANSITIONS: Readonly<
  Record<TrackStatus, readonly TrackStatus[]>
> = deriveTrackTransitions();

function deriveTrackTransitions(): Record<TrackStatus, readonly TrackStatus[]> {
  const table = {} as Record<TrackStatus, readonly TrackStatus[]>;
  for (const from of TRACK_STATUSES) {
    table[from] = TERMINAL_LIFECYCLE_CATEGORIES.includes(
      TRACK_STATUS_DECLARATION[from].category
    )
      ? []
      : TRACK_STATUSES.filter((to) => to !== from);
  }
  return table;
}

/** True when `from → to` is a move the table allows (a no-op is not a move). */
export function canTransitionTrack(from: string, to: string): boolean {
  const moves = TRACK_STATUS_TRANSITIONS[from as TrackStatus];
  return !!moves && (moves as readonly string[]).includes(to);
}

/** An ACTION token for `resolveActionLabel(verb, mood)` — never a hand label. */
export type TrackStatusVerb =
  "pause" | "resume" | "start" | "move" | "close" | "drop" | "reopen";

export interface TrackStatusMove {
  to: TrackStatus;
  verb: TrackStatusVerb;
}

/**
 * The verb of a move that HAPPENED (history, receipts) — named for every move
 * between two known statuses, including one the table no longer allows: a
 * track completed and reopened in place before goals could close (2026-10-23)
 * still reads "Reopened" in its history.
 */
export function trackStatusVerb(
  from: string,
  to: string
): TrackStatusVerb | null {
  if (from === to) return null;
  const fromCat = trackStatusCategory(from);
  const toCat = trackStatusCategory(to);
  if (!fromCat || !toCat) return null;
  return verbFor(fromCat, toCat);
}

function verbFor(
  from: LifecycleCategory,
  to: LifecycleCategory
): TrackStatusVerb {
  if (to === "done") return "close";
  if (to === "lost") return "drop";
  if (TERMINAL_LIFECYCLE_CATEGORIES.includes(from)) return "reopen";
  if (to === "paused") return "pause";
  if (to === "active") return from === "paused" ? "resume" : "start";
  return "move";
}

/**
 * The status moves a surface offers from `status`, in table order. Dropping
 * is final and frees the live name, so it is offered only with
 * `includeArchive: true` — both surfaces ask for it: Relay KEEPS Drop (a
 * decision, 2026-10-24), and who may drop is `goalMayDrop`. Closing
 * IS offered: a goal can stay open as long as it matters, or finish — a
 * person closes it with a verdict ({@link checkTrackClose}). A done or lost
 * track offers nothing; an unknown status offers nothing.
 *
 * FORWARD ONLY into the open stage (founder D-2, 2026-10-26): a move into an
 * open status is offered only when it is later in {@link TRACK_STATUSES}
 * than where the goal stands — draft → agreed → ready → active. An active or
 * paused goal is never offered "Move to draft / agreed / ready". Pause,
 * close, drop and resume are unchanged. This narrows the MENU, not the door:
 * {@link TRACK_STATUS_TRANSITIONS} still allows the move back.
 */
export function trackStatusMoves(
  status: string,
  opts: { includeArchive?: boolean } = {}
): TrackStatusMove[] {
  const moves = TRACK_STATUS_TRANSITIONS[status as TrackStatus];
  if (!moves) return [];
  const from = trackStatusCategory(status)!;
  const at = TRACK_STATUSES.indexOf(status as TrackStatus);
  return moves
    .filter((to) => opts.includeArchive === true || to !== "archived")
    .filter(
      (to) =>
        trackStatusCategory(to) !== "open" || TRACK_STATUSES.indexOf(to) > at
    )
    .map((to) => ({ to, verb: verbFor(from, trackStatusCategory(to)!) }));
}

// ── how a goal ended (R1) ──────────────────────────────────────────────────

/**
 * How a closed or dropped track ENDED — its verdict (R1), stored beside the
 * status (`project_tracks.verdict`), never as more statuses. The DB mirror
 * (`PROJECT_TRACK_VERDICTS`, `@synap/database`) and the `project_tracks`
 * CHECK spell the same set; the tracks service pins the mirror equal at
 * compile time. Words: `resolveTrackVerdictLabel`.
 */
export const TRACK_VERDICTS = [
  "met",
  "partly_met",
  "not_met",
  "retired",
  "no_longer_needed",
  "impossible",
  "replaced",
  "mistake",
] as const;
export type TrackVerdict = (typeof TRACK_VERDICTS)[number];

/**
 * Which ending each verdict belongs to: a CLOSED goal (done) was worked to
 * its end and judged — or, for an operation, retired; a DROPPED one (lost)
 * stopped mattering. Keyed by every verdict, so an unclassified one stops the
 * build.
 */
export const TRACK_VERDICT_CATEGORY = {
  met: "done",
  partly_met: "done",
  not_met: "done",
  retired: "done",
  no_longer_needed: "lost",
  impossible: "lost",
  replaced: "lost",
  mistake: "lost",
} as const satisfies Record<TrackVerdict, "done" | "lost">;

// Every status and every verdict has its words in the vocabulary, and the
// vocabulary names nothing else: a value added on one side only stops the build.
type _SameKeys<A extends string, B extends string> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never;
const _statusWords: _SameKeys<TrackStatus, keyof typeof TRACK_STATUS_LABELS> =
  true;
const _verdictWords: _SameKeys<
  TrackVerdict,
  keyof typeof TRACK_VERDICT_LABELS
> = true;
void _statusWords;
void _verdictWords;

/** Verdicts that need a reason in words (what made it impossible, what replaced it). */
export const TRACK_VERDICTS_NEEDING_REASON = [
  "impossible",
  "replaced",
] as const satisfies readonly TrackVerdict[];

/**
 * The kind of work that never ends `met` (R6): an OPERATION is kept running
 * and assessed per period; when it stops it is RETIRED. `retired` closes an
 * operation only, and an operation closes only `retired`.
 */
const OPERATION_WORK_KIND = "operation" satisfies TrackWorkKind;

/**
 * The verdicts a move INTO `status` accepts, for a goal of `workKind` — none
 * for a status that does not end the goal. Done: `retired` for an operation,
 * met · partly_met · not_met for every other kind (or none set). Lost: the
 * same four for every kind.
 */
export function trackVerdictsFor(
  status: string,
  workKind?: string | null
): readonly TrackVerdict[] {
  const category = trackStatusCategory(status);
  if (category !== "done" && category !== "lost") return [];
  const operation = workKind === OPERATION_WORK_KIND;
  return TRACK_VERDICTS.filter(
    (v) =>
      TRACK_VERDICT_CATEGORY[v] === category &&
      (category === "lost" || (v === "retired") === operation)
  );
}

export function isTrackVerdict(v: unknown): v is TrackVerdict {
  return (
    typeof v === "string" && (TRACK_VERDICTS as readonly string[]).includes(v)
  );
}

/**
 * THE close rule, one answer for the pod's status door and any surface that
 * asks before sending:
 *   - a move into DONE (close) REQUIRES a verdict from met · partly_met ·
 *     not_met — a person judges how it went; an OPERATION (R6, `workKind`)
 *     is never met: it closes `retired`, and only an operation may;
 *   - a move into LOST (drop) SHOULD carry one from no_longer_needed ·
 *     impossible · replaced · mistake, but may come without: the clients
 *     shipped before verdicts (browser Archive, the released CLI, the IS)
 *     drop with no verdict, and such a track reads like one dropped before
 *     0344 (verdict NULL). A verdict that IS sent is validated;
 *   - impossible / replaced need a reason, and a reason needs its verdict;
 *   - any other move carries no verdict;
 *   - with CRITERIA (W2, the derived marks — `deriveGoalCriteria`): `met`
 *     only when every REQUIRED criterion is met (accepted); `partly_met` /
 *     `not_met` only when at least one criterion is not met. A goal with no
 *     criteria closes on its judge's word. Omit `criteria` only where they
 *     cannot be known (a surface asking before it read them). `workKind`
 *     omitted reads as "not an operation".
 * `null` = allowed; otherwise the refusal, in words an agent can act on
 * (machine tokens, so it can resend them).
 */
export function checkTrackClose(
  to: string,
  close: { verdict?: string | null; verdictReason?: string | null },
  criteria?: ReadonlyArray<{
    key: string;
    required?: boolean;
    mark: string;
  }>,
  workKind?: string | null
): string | null {
  const allowed = trackVerdictsFor(to, workKind);
  const verdict = close.verdict ?? null;
  const reason = close.verdictReason?.trim() ?? "";
  if (allowed.length === 0) {
    return verdict !== null || reason
      ? `A verdict is given only when a goal is closed (completed) or dropped (archived) — not when it moves to ${to}.`
      : null;
  }
  const closing = trackStatusCategory(to) === "done";
  const into = closing ? "Closing" : "Dropping";
  if (verdict === null) {
    if (closing)
      return `${into} a goal needs a verdict: ${allowed.join(", ")}.`;
    return reason
      ? `A verdictReason needs its verdict: ${allowed.join(", ")}.`
      : null;
  }
  if (!(allowed as readonly string[]).includes(verdict)) {
    if (closing && workKind === OPERATION_WORK_KIND) {
      return `An operation is never "${verdict}" — it is assessed per period and closes as retired.`;
    }
    if (closing && verdict === "retired") {
      return `Only an operation closes as retired — close this goal as ${allowed.join(", ")}.`;
    }
    return `"${verdict}" is not a verdict for ${into.toLowerCase()} a goal — use ${allowed.join(", ")}.`;
  }
  if (
    (TRACK_VERDICTS_NEEDING_REASON as readonly string[]).includes(verdict) &&
    !reason
  ) {
    return `The verdict "${verdict}" needs a verdictReason — say what ${verdict === "replaced" ? "replaced it" : "made it impossible"}.`;
  }
  if (criteria && criteria.length > 0) {
    if (verdict === "met") {
      const open = criteria.filter(
        (c) => c.required !== false && c.mark !== "met"
      );
      if (open.length > 0) {
        return `Closing a goal as met needs every required criterion met and accepted — not yet: ${open.map((c) => c.key).join(", ")}.`;
      }
    } else if (verdict === "partly_met" || verdict === "not_met") {
      if (criteria.every((c) => c.mark === "met")) {
        return `Every criterion of this goal is met — close it as met, not ${verdict}.`;
      }
    }
  }
  return null;
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

/**
 * What a check gate that HELD the track recorded (`metadata.checkGate`): the
 * step entered (`stageKey`, whose entry gate it is), the step it measured
 * (`fromStage`), what failed and why. Projected on every track read while the
 * track is paused by it — `null` otherwise (the marker is cleared on every
 * status change, so a stale one never leaks).
 */
export interface TrackCheckGate {
  stageKey: string;
  fromStage: string;
  failing: string[];
  reason: string | null;
}

export function readTrackCheckGate(track: {
  status: string;
  metadata?: unknown;
}): TrackCheckGate | null {
  if (trackPausedBy(track) !== "check") return null;
  const raw = (track.metadata as Record<string, unknown>)[
    CHECK_GATE_METADATA_KEY
  ];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.stageKey !== "string" || typeof r.fromStage !== "string") {
    return null;
  }
  return {
    stageKey: r.stageKey,
    fromStage: r.fromStage,
    failing: Array.isArray(r.failing)
      ? r.failing.filter((f): f is string => typeof f === "string")
      : [],
    reason: typeof r.reason === "string" && r.reason ? r.reason : null,
  };
}

/**
 * The words for WHO holds a paused track — ONE phrase for every surface
 * ("Paused · by a check" / "Paused · by a person"), so Relay and the browser
 * never build their own from the raw `pausedBy` token. `null` when the track is
 * not paused (`pausedBy` null): there is nothing to qualify.
 */
export function trackPausedByLabel(pausedBy: TrackPausedBy): string | null {
  if (pausedBy === null) return null;
  const who = pausedBy === "check" ? "a check" : "a person";
  return `${resolveStatusLabel("paused")} \u00b7 by ${who}`;
}

/** A track that takes no new work on a page: its sessions fall to the remainder. */
export function isTrackRetired(track: { status: string }): boolean {
  return trackStatusCategory(track.status) === "lost";
}

/**
 * The CLOSED statuses — the done and lost categories of
 * {@link TRACK_STATUS_DECLARATION}; the complement of the LIVE ones that hold
 * a track's name on its project ({@link LIVE_TRACK_STATUSES}). Pinned to the
 * declaration below; the pod's tracks service pins its own live list
 * (`LIVE_PROJECT_TRACK_STATUSES`, @synap/database) to the same partition.
 */
export const CLOSED_TRACK_STATUSES = [
  "completed",
  "archived",
] as const satisfies readonly TrackStatusIn<"done" | "lost">[];

/**
 * The LIVE statuses: open, active and paused. A live track holds its NAME on
 * its project (`uniq_project_tracks_live_name`, whose predicate spells this
 * set) and takes work.
 */
export const LIVE_TRACK_STATUSES = [
  "proposed",
  "agreed",
  "ready",
  "active",
  "paused",
] as const satisfies readonly TrackStatusIn<"open" | "active" | "paused">[];

// Both lists are EXACTLY their categories: a status added to the declaration
// and listed in neither (or listed in the wrong one) stops the build.
type _ExactlyIn<L extends readonly string[], S extends string> = [
  Exclude<S, L[number]>,
] extends [never]
  ? true
  : never;
const _closedExact: _ExactlyIn<
  typeof CLOSED_TRACK_STATUSES,
  TrackStatusIn<"done" | "lost">
> = true;
const _liveExact: _ExactlyIn<
  typeof LIVE_TRACK_STATUSES,
  TrackStatusIn<"open" | "active" | "paused">
> = true;
void _closedExact;
void _liveExact;

/**
 * A CLOSED track — closed (done) or dropped (lost): it stands on no live
 * stage, so no stage session starts on it, no session is filed into it, and
 * its stages offer no move. (Narrower than "not active": a PAUSED track is
 * still open — it resumes where it stands; a PROPOSED one is being shaped.)
 */
export function isTrackClosed(track: { status: string }): boolean {
  return (CLOSED_TRACK_STATUSES as readonly string[]).includes(track.status);
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
  if (isTrackClosed(track)) {
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

/**
 * THE stage-placement rule for a track's session, shared by every surface
 * that draws a track's sessions by stage (browser Stages + Zoom + track page,
 * Relay's track page): the stage it was FILED at (`focus_sessions.track_stage`)
 * when that names a pinned stage, else `null` — the ONE "not filed at a step"
 * group. Never the track's CURRENT stage as a stand-in: a guess drawn in a
 * column is a claim (orchestrator decision, 2026-10-04 — the Stages board once
 * drew an unstamped session dashed in the current column while the track page
 * listed it apart, so one session sat in two places two clicks apart).
 */
export function filedStageKey(
  trackStage: string | null | undefined,
  stages: ReadonlyArray<{ key: string }>
): string | null {
  if (!trackStage) return null;
  return stages.some((stage) => stage.key === trackStage) ? trackStage : null;
}

/** The heading of that group — ONE spelling on every surface. */
export const NOT_FILED_AT_A_STAGE = `Not filed at a ${resolveObjectNoun(
  "stage"
).toLowerCase()}`;

export interface TrackStagePathStep<R> {
  stage: TrackStage;
  /** The stage mark's tone ({@link trackStageTone}) — a FILL, never text ink. */
  tone: UnitTone;
  /**
   * When the track LAST entered this stage (stages are re-enterable, so the
   * latest history entry is where its current stay began). `null` when never
   * recorded — and always for a stage not yet reached: an old entry recorded
   * before the track moved back is not an honest date for where it stands now.
   */
  enteredAt: string | null;
  /** The track's sessions FILED at this stage ({@link filedStageKey}), in input order. */
  sessions: R[];
}

export interface TrackStagePath<R> {
  steps: TrackStagePathStep<R>[];
  /** Sessions filed at no stage the method declares — {@link NOT_FILED_AT_A_STAGE}. */
  unfiled: R[];
  /** The stage the track stands on (`position === "active"`), or `null`. */
  currentKey: string | null;
}

/**
 * THE stage path of a track's page (browser track page, Relay's track page):
 * each stage with its tone, the date it was last entered and the sessions
 * filed at it. Position is the pod's ({@link deriveTrackStages}); placement is
 * {@link filedStageKey}. No session vanishes: each of `rows` lands at exactly
 * one stage or in `unfiled`. `rows` must already be narrowed to this track.
 */
export function trackStagePath<R extends { trackStage?: string | null }>(
  stages: readonly TrackStage[],
  history: ReadonlyArray<{ stageKey: string; enteredAt: string }>,
  rows: readonly R[]
): TrackStagePath<R> {
  const lastEntered = new Map<string, string>();
  // History is oldest-first; a later entry for the same key overwrites.
  for (const entry of history) lastEntered.set(entry.stageKey, entry.enteredAt);
  const byStage = new Map<string, R[]>(stages.map((s) => [s.key, []]));
  const unfiled: R[] = [];
  for (const row of rows) {
    const key = filedStageKey(row.trackStage, stages);
    const bucket = key ? byStage.get(key) : undefined;
    if (bucket) bucket.push(row);
    else unfiled.push(row);
  }
  let currentKey: string | null = null;
  const steps = stages.map((stage): TrackStagePathStep<R> => {
    if (stage.position === "active") currentKey = stage.key;
    return {
      stage,
      tone: trackStageTone(stage.position),
      enteredAt:
        stage.position === "not_started"
          ? null
          : (lastEntered.get(stage.key) ?? null),
      sessions: byStage.get(stage.key) ?? [],
    };
  });
  return { steps, unfiled, currentKey };
}

// ─────────────────────────────────────────────────────────────────────────────
// EMERGENT STAGES + DIRECTION + KPI (0302, founder decision 2026-10-05: a track
// carries a direction and an optional KPI; stages may be added after it starts;
// no hill chart). The verifiable part of a track lives in its SESSIONS'
// outcomes — the track only steers.
// ─────────────────────────────────────────────────────────────────────────────

/** True when any stage was added after the track started (`addedAt`). */
export function trackStagesEmerged(
  stages: ReadonlyArray<{ addedAt?: string }>
): boolean {
  return stages.some((s) => typeof s.addedAt === "string" && !!s.addedAt);
}

/**
 * The number a track steers by (`project_tracks.kpi`, 0302).
 *
 * `current` is STATED, never measured: nothing in the pod derives "qualified
 * leads per month", so the value always travels with WHEN it was stated
 * (`updatedAt`) and by whom (`updatedBy`). A surface must never present it as
 * a live measurement.
 *
 * The target is REACHED when `current >= target` — a KPI is a number to grow
 * toward. (A lower-is-better KPI is not modelled yet; state it as the number
 * to reach, e.g. "days saved", not "days taken".)
 *
 * The DB mirror is `ProjectTrackKpi` (`@synap/database`, which cannot import
 * this package); the pod pins the two equal at compile time.
 */
export interface TrackKpi {
  label: string;
  unit?: string;
  target: number;
  current?: number;
  /** ISO-8601 — when `current` was last stated. */
  updatedAt?: string;
  /** The user (or agent) id that stated `current`. */
  updatedBy?: string;
}

/** Max length of a KPI label / unit and of a track's direction line. */
export const TRACK_KPI_LABEL_MAX = 80;
export const TRACK_KPI_UNIT_MAX = 24;
export const TRACK_DIRECTION_MAX = 280;

function finite(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Read the untyped jsonb leniently: a KPI needs a non-empty `label` and a
 * finite `target`, else it is not a KPI (`null`) — never a half-drawn bar.
 */
export function readTrackKpi(raw: unknown): TrackKpi | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const label = typeof r.label === "string" ? r.label.trim() : "";
  const target = finite(r.target);
  if (!label || target === undefined) return null;
  const out: TrackKpi = { label, target };
  if (typeof r.unit === "string" && r.unit.trim()) out.unit = r.unit.trim();
  const current = finite(r.current);
  if (current !== undefined) out.current = current;
  if (typeof r.updatedAt === "string" && r.updatedAt) {
    out.updatedAt = r.updatedAt;
  }
  if (typeof r.updatedBy === "string" && r.updatedBy) {
    out.updatedBy = r.updatedBy;
  }
  return out;
}

/** True when a stated `current` has reached the `target` (see {@link TrackKpi}). */
export function trackKpiReached(kpi: TrackKpi | null | undefined): boolean {
  return (
    !!kpi &&
    typeof kpi.current === "number" &&
    Number.isFinite(kpi.current) &&
    kpi.current >= kpi.target
  );
}

/**
 * Did THIS write make the KPI reach its target? True only on the crossing —
 * not reached before, reached after — so a re-statement of an already-reached
 * value (or a label edit) never nudges again.
 */
export function trackKpiJustReached(
  before: TrackKpi | null | undefined,
  after: TrackKpi | null | undefined
): boolean {
  return trackKpiReached(after) && !trackKpiReached(before);
}

/** Read the direction line: trimmed, or `null` when unsaid. */
export function readTrackDirection(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}
