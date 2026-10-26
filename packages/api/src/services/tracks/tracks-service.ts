/**
 * TRACKS — a METHOD running inside ONE project (`project_tracks`, 0272).
 *
 * A project is long-lived intent; a track is how one strand of it is worked
 * ("Business model", "Content", "Build" inside "Launch The Architech"). The
 * method is a playbook with `scope: "project"`, reusable by any project; the
 * track PINS the definition it started from (`definitionSnapshot` +
 * `methodVersion`) so editing the method never rewrites a live track.
 *
 * ── THE DOORS, ALL HERE ─────────────────────────────────────────────────────
 *   startTrack        — the ONE way a track is born. The proto-track door
 *                       `projects.instantiateFromPlaybook` was retired (W5c);
 *                       its legacy approval executor calls startTrack directly.
 *   setTrackStatus    — any move of the track's SYSTEM LIFECYCLE
 *                       (`TRACK_LIFECYCLE`, @synap-core/types/units): open
 *                       (proposed · agreed · ready) · active · paused · done
 *                       (completed, "Closed") · lost (archived, "Dropped").
 *                       Governed through the SAME classifier as a kind's
 *                       status move; closing carries a verdict (R1).
 *   reopenTrack       — a closed goal comes back as a NEW version (R8),
 *                       linked `new --replaces--> old`, through startTrack.
 *   advanceTrackStage — the ONE writer of `project_tracks.current_stage` after
 *                       birth. Gate evaluation is the subject-agnostic core in
 *                       `services/playbooks/stage-gate.ts` (`applyStageGate`),
 *                       shared with `advanceSessionStage` — never a copy.
 *                       Entering a stage OFFERS its session (`offer`); it
 *                       never starts one.
 *   setTrackParams    — the method's param answers (0274), governed `track/update`.
 *   setTrackDirection — the track's direction + KPI (0302), governed
 *                       `track/update`. Reaching the KPI target NUDGES
 *                       (`track.kpi_reached`); closing stays a person's act.
 *   addTrackStage     — append an EMERGENT stage to the pinned stage list,
 *                       governed `track/update`. The one writer of
 *                       `definition_snapshot.stages` after birth.
 *   startStageSession — the ONE door that starts a stage's session: a thin
 *                       wrapper over `createFocusSession` (same governance),
 *                       idempotent on an open session already filed there.
 *
 * ── ACCESS ──────────────────────────────────────────────────────────────────
 * READS go through `scopedDb` + the `project_tracks` VisibilityRule (visible iff
 * the parent project is). WRITES gate on the LOADED project's workspace
 * (`assertWorkspaceWrite`), never a request-supplied workspace, and are
 * GOVERNED: `checkPermissionOrPropose({ subjectType: "track", ... })` with the
 * FULL payload the replay needs. `routers/proposals/executors/track.ts` replays
 * an approved proposal through THIS module.
 */

import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import {
  and,
  asc,
  desc,
  eq,
  getDb,
  inArray,
  isNotNull,
  ne,
  or,
  focusSessions,
  playbooks,
  projects,
  projectTracks,
  users,
  links,
  drizzleSql,
  classifyLifecycleMove,
} from "@synap/database";
import {
  DEFAULT_PLAYBOOK_STAGE_CATEGORY,
  readCriteria,
  describeParamTypeError,
  readPlaybookParams,
  validatePlaybookParams,
} from "@synap/playbooks";
import type {
  Playbook,
  ProjectTrack,
  ProjectTrackKpi,
  ProjectTrackStatus,
  ProjectTrackUncertainty,
  ProjectTrackVerdict,
  ProjectTrackWorkKind,
} from "@synap/database/schema";
import { LIVE_PROJECT_TRACK_STATUSES } from "@synap/database/schema";
import { emitSideEffects } from "@synap/events";
import { createLogger } from "@synap-core/core";
import {
  buildObjectActionTitle,
  resolveTrackStatusLabel,
  resolveTrackVerdictLabel,
} from "@synap-core/types/vocabulary";
import { formatKpiFraction } from "@synap-core/types/lens";
import {
  canTransitionTrack,
  checkTrackClose,
  isTrackClosed,
  isTrackVerdict,
  TRACK_LIFECYCLE,
  trackStatusCategory,
  type TrackStatusIn,
  type TrackVerdict,
  deriveTrackStages,
  readTrackDirection,
  readTrackKpi,
  readTrackStage,
  readTrackCheckGate,
  readTrackStageHistory,
  slotKeyBase,
  type CLOSED_TRACK_STATUSES,
  trackKpiJustReached,
  trackPausedBy,
  TRACK_DIRECTION_MAX,
  TRACK_KPI_LABEL_MAX,
  TRACK_KPI_UNIT_MAX,
  type TrackKpi,
  type TrackPausedBy,
  type TrackCheckGate,
  type TrackStage,
  type TrackStageHistoryEntry,
  type TrackStatus,
  goalAcceptanceRefusal,
  mayAcceptGoalCriterion,
  criterionMeaning,
  type GoalAcceptanceDecision,
  type GoalCriterionView,
  type TrackUncertainty,
  type OperationPeriodReading,
  type TrackWorkKind,
  type WaitingOnMark,
  readGoalLoop,
  type GoalLoopSettings,
} from "@synap-core/types/units";
import { z } from "zod";
import {
  CHECK_GATE_METADATA_KEY,
  OPEN_SESSION_STATUSES,
} from "@synap-core/types/focus-sessions";
import type { ActivityActor } from "@synap-core/types/activity";
import { trackRepository } from "./track-repo.js";
import {
  agentSwitchesLoopOn,
  isGoalJudge,
  loadTrackGoalFacts,
  parseTrackGoalInput,
  pickTrackGoalInput,
  readDropConditions,
  readEndState,
  readGoalCriteria,
  readTrackUncertainty,
  readTrackWorkKind,
  resolveTrackGoalPatch,
  withBirthLoopDefault,
  type TrackGoalFacts,
} from "./goal-content.js";
import {
  noticeGoalEndProposed,
  refreshGoalJudgements,
} from "./goal-review-notice.js";
import {
  assertGoalEnder,
  carryGoalParticipants,
  goalParticipantRows,
  loadTrackParticipantViews,
  seedGoalOwner,
} from "./track-participant-store.js";
import { activityActorOf, loadActorRows } from "../activity/activity-actors.js";
import {
  assertGoalSource,
  writeGoalLineage,
  type TrackFromEntity,
} from "./goal-source-entity.js";
import { AccessContext, scopedDb } from "../../access/index.js";
import { grantReadPredicate } from "../../access/grant-read.js";
import { projectVisibleWhere } from "../../access/project-visibility.js";
import { rosterReadFor } from "../../access/session-visibility.js";
import { loadVisibleProject } from "../projects/load-visible-project.js";
import { projectPathConditions } from "../projects/project-path.js";
import type { CreateFocusSessionParams } from "../focus-sessions/create-session.js";
import {
  goalJudge,
  goalOwner,
  type TrackParticipant,
} from "@synap-core/types/units";
import { REPLACES_LINK_TYPE } from "@synap-core/types/connections";
import { createLinks } from "../links/links-service.js";
import { writeDependencyLink } from "../links/dependency-links.js";
import { requestClientKey } from "../focus-sessions/resolve-work-session.js";
import { linkProjectToWorkspace } from "../../utils/project-workspace.js";
import {
  listMissingStageDomains,
  resolveStageDomainWorkspace,
  workspacePackageSlug,
  type StageDomainFallbackReason,
} from "./stage-domain.js";
import {
  checkPermissionOrPropose,
  proposedMessageFor,
} from "../../utils/permission-check.js";
import {
  TRACK_SPACE_GRANT_KEY,
  endTrackSpaceGrant,
  resolveTrackGrantSpaces,
  type TrackSpaceGrant,
} from "./track-space-grant.js";
import { assertWorkspaceWrite } from "../../utils/workspace-write-access.js";
import {
  applyStageGate,
  trackGateSubject,
  type StageGateOutcome,
} from "../playbooks/stage-gate.js";

const logger = createLogger({ module: "tracks" });

/** Who is acting. `agentUserId` set ⇒ an AI drove it (governed ladder). */
export interface TrackActor {
  userId: string;
  agentUserId?: string | null;
  isHubProtocol?: boolean;
  /**
   * The caller's focus session, already resolved by its door — handed to the
   * gate so the write (or its proposal) is filed under that session.
   */
  sessionId?: string | null;
  /** Provenance for the proposal (e.g. `mcp`, `hub-rest`). */
  source?: string;
  reasoning?: string;
}

export interface ProposedOutcome {
  status: "proposed";
  proposalId: string;
  proposalType: string;
  message: string;
  reviewUrl: string;
}

/** The project a track write gates on — the LOADED row, never the request. */
interface GateProject {
  id: string;
  workspaceId: string | null;
  userId: string;
}

// The DB enum (`PROJECT_TRACK_STATUSES`, @synap/database) and the shared
// transition table's statuses (`TRACK_STATUSES`, @synap-core/types/units) are
// two lists because the database package cannot import types. Pinned EQUAL
// here, at compile time: a status added to one and not the other stops the build.
type _SameStatuses = [ProjectTrackStatus] extends [TrackStatus]
  ? [TrackStatus] extends [ProjectTrackStatus]
    ? true
    : never
  : never;
const _sameStatuses: _SameStatuses = true;
void _sameStatuses;

// LIVE (`LIVE_PROJECT_TRACK_STATUSES`, @synap/database — the statuses that
// hold a name, 0317/0344's index predicate) and CLOSED (`CLOSED_TRACK_STATUSES`,
// @synap-core/types/units — `isTrackClosed`) partition the statuses: their
// union is every status and they share none. A status added to the enum and
// classified in neither list, or in both, stops the build.
type _LiveStatus = (typeof LIVE_PROJECT_TRACK_STATUSES)[number];
type _ClosedStatus = (typeof CLOSED_TRACK_STATUSES)[number];
type _LiveClosedPartition = [
  Exclude<ProjectTrackStatus, _LiveStatus | _ClosedStatus>,
] extends [never]
  ? [Extract<_LiveStatus, _ClosedStatus>] extends [never]
    ? true
    : never
  : never;
const _liveClosedPartition: _LiveClosedPartition = true;
void _liveClosedPartition;

// …and the pod's LIVE list is EXACTLY the lifecycle's open, active and paused
// categories (`TRACK_STATUS_DECLARATION`, @synap-core/types/units): a status
// moved to another category on one side only stops the build.
type _LiveIsCategories = [
  Exclude<_LiveStatus, TrackStatusIn<"open" | "active" | "paused">>,
] extends [never]
  ? [
      Exclude<TrackStatusIn<"open" | "active" | "paused">, _LiveStatus>,
    ] extends [never]
    ? true
    : never
  : never;
const _liveIsCategories: _LiveIsCategories = true;
void _liveIsCategories;

// The verdict mirror (`PROJECT_TRACK_VERDICTS`, @synap/database) is EXACTLY
// the shared set (`TRACK_VERDICTS`, @synap-core/types/units).
type _SameVerdicts = [ProjectTrackVerdict] extends [TrackVerdict]
  ? [TrackVerdict] extends [ProjectTrackVerdict]
    ? true
    : never
  : never;
const _sameVerdicts: _SameVerdicts = true;
void _sameVerdicts;

// The kind-of-work and uncertainty mirrors (0345, `@synap/database`) are
// EXACTLY the shared sets (`TRACK_WORK_KINDS`, `TRACK_UNCERTAINTY_LEVELS`).
type _SameWorkKinds = [ProjectTrackWorkKind] extends [TrackWorkKind]
  ? [TrackWorkKind] extends [ProjectTrackWorkKind]
    ? true
    : never
  : never;
const _sameWorkKinds: _SameWorkKinds = true;
void _sameWorkKinds;
type _SameUncertainty = [ProjectTrackUncertainty] extends [TrackUncertainty]
  ? [TrackUncertainty] extends [ProjectTrackUncertainty]
    ? true
    : never
  : never;
const _sameUncertainty: _SameUncertainty = true;
void _sameUncertainty;

// The same pin for the KPI (0302): `ProjectTrackKpi` (@synap/database) and
// `TrackKpi` (@synap-core/types/units) must describe ONE shape.
type _SameKpi = [Required<ProjectTrackKpi>] extends [Required<TrackKpi>]
  ? [Required<TrackKpi>] extends [Required<ProjectTrackKpi>]
    ? [keyof ProjectTrackKpi] extends [keyof TrackKpi]
      ? [keyof TrackKpi] extends [keyof ProjectTrackKpi]
        ? true
        : never
      : never
    : never
  : never;
const _sameKpi: _SameKpi = true;
void _sameKpi;

// ── projection ──────────────────────────────────────────────────────────────

export type TrackViewStageHistoryEntry = TrackStageHistoryEntry & {
  enteredBy?: ActivityActor;
};

export interface TrackView {
  id: string;
  projectId: string;
  name: string;
  playbookId: string | null;
  methodVersion: string;
  currentStage: string | null;
  status: ProjectTrackStatus;
  /** Why it is paused — `null` unless `status === "paused"`. */
  pausedBy: TrackPausedBy;
  /**
   * The PINNED stages, positioned against `currentStage`, with what each
   * declares (goal, gate, criteria…) and — when counted — `sessionCount`.
   */
  stages: TrackStage[];
  /** The method's param answers (0274). */
  params: Record<string, unknown>;
  /**
   * The params the method DECLARED, as pinned at start — what `params`
   * answers. Surfaces render the onboarding form from this, never from the
   * live playbook, whose params may have moved on since the pin.
   */
  declaredParams: unknown[];
  /**
   * Every stage the track entered, oldest first (0274). `enteredBy` names the
   * mover (resolved by the pod — a client cannot); absent when the names could
   * not be read (a write's fallback view), never a guessed name.
   */
  stageHistory: TrackViewStageHistoryEntry[];
  /**
   * What the check gate that HOLDS the track recorded — `null` unless
   * `pausedBy === "check"`. `fromStage` is the step it measured (the one
   * left); `stageKey` the step entered, whose entry gate it is.
   */
  checkGate: TrackCheckGate | null;
  /** Where the track is heading, one line (0302) — `null` when unsaid. */
  direction: string | null;
  /**
   * The number it steers by (0302) — `null` when none. `current` is STATED
   * (with `updatedAt` / `updatedBy`), never measured.
   */
  kpi: TrackKpi | null;
  /**
   * How the track ENDED (0344, R1) — `null` while it is live, and on a track
   * dropped before verdicts existed. Read with its category: done verdicts
   * (met · partly_met · not_met, or retired for an operation) on a closed
   * track, lost ones on a dropped one.
   */
  verdict: TrackVerdict | null;
  /** Why, in words — always present for `impossible` and `replaced`. */
  verdictReason: string | null;
  /** The person who closed it (the approver when an agent proposed it). */
  verdictBy: string | null;
  /** ISO-8601 — when it was closed; `null` when not recorded (before 0344). */
  verdictAt: string | null;
  /** What "done" looks like, in words (0345) — `null` when unsaid. */
  endState: string | null;
  /**
   * The goal's criteria (0345): none (a lasting goal) or 2–5, each with the
   * judge's stored decision and its DERIVED state — `mark` (met · claimed ·
   * under_way · not_met · not_started), `acceptanceState`, `meaning` (R5) and
   * a measured criterion's `currentValue`. `mark` is `null` only on a write's
   * fallback view (the goal's runs could not be read) — never a guess.
   */
  criteria: GoalCriterionView[];
  /** When to stop (0345) — `[]` when none said. */
  dropConditions: string[];
  /**
   * The goal's loop (0350, W4): whether it proposes its next run while a
   * required criterion is unmet, its weekly budget, when a person last
   * switched it on and who. Never set reads as OFF.
   */
  loop: GoalLoopSettings;
  /** The kind of work (decision 4) — `null` when not set. */
  workKind: TrackWorkKind | null;
  /** How well the way is known (decision 4) — `null` when not set. */
  uncertainty: TrackUncertainty | null;
  /**
   * The person who confirmed kind + uncertainty, and when (ISO-8601). Both
   * `null` while they are the AI's proposal, not yet confirmed.
   */
  kindConfirmedBy: string | null;
  kindConfirmedAt: string | null;
  /**
   * DERIVED — every required criterion met or claimed and one at least
   * claimed (a mark inside the active category, never a status). `null` on a
   * write's fallback view.
   */
  inReview: boolean | null;
  /**
   * DERIVED (R6) — an OPERATION's reading for THIS week (Monday 00:00 UTC):
   * met / not met / unmeasured from its required criteria's grades in the
   * week. `null` for any other kind of work, and on a write's fallback view.
   */
  periodReading: OperationPeriodReading | null;
  /**
   * DERIVED (R4) — what the goal waits on, one mark per reason present
   * (input · approval · access · another_work · outside_world) with how many.
   * `[]` = waiting on nothing; `null` on a write's fallback view.
   */
  waitingOn: WaitingOnMark[] | null;
  /**
   * WHO IS ON IT (0348, W3): owner, judge, delegates with their commitment
   * and its state ("silent since" for a delegate who still owes something),
   * integrator. Absent when not read (a write's fallback view) — never a
   * fabricated empty list. Owner first, then judge, delegates, integrator.
   */
  participants?: TrackParticipant[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Project a track. `sessionsByStage` (from {@link countTrackSessionsByStage})
 * fills each stage's `sessionCount`; without it the key is absent — "not
 * counted", never a fabricated 0. Every read door uses {@link loadTrackViews}.
 */
export function toTrackView(
  track: ProjectTrack,
  sessionsByStage?: Readonly<Record<string, number>>,
  /** Names the stage-history movers — absent ⇒ `enteredBy` absent. */
  actorOf?: (actorId: string) => ActivityActor,
  /**
   * The goal's DERIVED facts (`loadTrackGoalFacts`) — absent ⇒ marks,
   * `inReview` and `waitingOn` read `null` ("not read"), never a guess.
   */
  goal?: TrackGoalFacts
): TrackView {
  return {
    id: track.id,
    projectId: track.projectId,
    name: track.name,
    playbookId: track.playbookId,
    methodVersion: track.methodVersion,
    currentStage: track.currentStage,
    status: track.status,
    pausedBy: trackPausedBy(track),
    stages: deriveTrackStages(
      track.definitionSnapshot?.stages,
      track.currentStage,
      sessionsByStage
    ),
    params:
      track.params && typeof track.params === "object" ? track.params : {},
    declaredParams: Array.isArray(track.definitionSnapshot?.params)
      ? track.definitionSnapshot.params
      : [],
    stageHistory: readTrackStageHistory(track.stageHistory).map((e) =>
      actorOf ? { ...e, enteredBy: actorOf(e.actor) } : e
    ),
    checkGate: readTrackCheckGate(track),
    direction: readTrackDirection(track.direction),
    kpi: readTrackKpi(track.kpi),
    verdict: isTrackVerdict(track.verdict) ? track.verdict : null,
    verdictReason: track.verdictReason ?? null,
    verdictBy: track.verdictBy ?? null,
    verdictAt: track.verdictAt ? new Date(track.verdictAt).toISOString() : null,
    endState: readEndState(track.endState),
    criteria:
      goal?.criteria ??
      readGoalCriteria(track.criteria).map((c) => ({
        ...c,
        mark: null,
        acceptanceState: null,
        meaning: criterionMeaning(c),
        currentValue: null,
        claim: null,
      })),
    dropConditions: readDropConditions(track.dropConditions),
    loop: readGoalLoop(track.loop),
    workKind: readTrackWorkKind(track.workKind),
    uncertainty: readTrackUncertainty(track.uncertainty),
    kindConfirmedBy: track.kindConfirmedBy ?? null,
    kindConfirmedAt: track.kindConfirmedAt
      ? new Date(track.kindConfirmedAt).toISOString()
      : null,
    inReview: goal ? goal.inReview : null,
    periodReading: goal ? goal.periodReading : null,
    waitingOn: goal ? goal.waitingOn : null,
    createdAt: new Date(track.createdAt).toISOString(),
    updatedAt: new Date(track.updatedAt).toISOString(),
  };
}

/**
 * Sessions filed at each stage of each track — ONE grouped query for any
 * number of tracks. The counted set is the PROJECT PATH's session set for the
 * track's project (`projectPathConditions`, default lens: the caller's own
 * work + tracked runs, undecided agent drafts hidden), narrowed by
 * `track_stage` — so a stage's count is the number of sessions the project
 * path would list at that stage, not a second population. A failed read
 * THROWS: a count that silently became 0 would read as "nothing was done at
 * this stage".
 *
 * NB this is deliberately NOT the check GATE's population. The gate
 * (`measureTrackStage`) counts EVERY member's sessions filed at the stage, on
 * purpose — the track is the project's, and so is its gate — while this count
 * is what one reader's surface lists. The two may differ, and that is correct.
 */
export async function countTrackSessionsByStage(
  tracks: ReadonlyArray<Pick<ProjectTrack, "id" | "projectId">>,
  userId: string
): Promise<Map<string, Record<string, number>>> {
  const out = new Map<string, Record<string, number>>(
    tracks.map((t) => [t.id, {}])
  );
  if (tracks.length === 0) return out;
  const byProject = new Map<string, string[]>();
  for (const t of tracks) {
    const ids = byProject.get(t.projectId) ?? [];
    if (!ids.includes(t.id)) ids.push(t.id);
    byProject.set(t.projectId, ids);
  }
  const db = await getDb();
  const rows = await db
    .select({
      trackId: focusSessions.trackId,
      trackStage: focusSessions.trackStage,
      n: drizzleSql<number>`count(*)`,
    })
    .from(focusSessions)
    .where(
      and(
        isNotNull(focusSessions.trackStage),
        or(
          ...[...byProject].map(([projectId, ids]) =>
            and(
              inArray(focusSessions.trackId, ids),
              ...projectPathConditions({ userId, projectId, lens: "default" })
            )
          )
        )
      )
    )
    .groupBy(focusSessions.trackId, focusSessions.trackStage);
  for (const r of rows) {
    if (!r.trackId || !r.trackStage) continue;
    const counts = out.get(r.trackId);
    if (counts) counts[r.trackStage] = Number(r.n);
  }
  return out;
}

/** Track views with per-stage session counts — what every track READ returns. */
export async function loadTrackViews(
  tracks: ProjectTrack[],
  actor: Pick<TrackActor, "userId" | "agentUserId" | "isHubProtocol">
): Promise<TrackView[]> {
  const [counts, movers, goals, participants] = await Promise.all([
    countTrackSessionsByStage(tracks, actor.userId),
    loadActorRows(
      tracks.flatMap((t) =>
        readTrackStageHistory(t.stageHistory).map((e) => e.actor)
      )
    ),
    loadTrackGoalFacts(tracks, actor.userId, { roster: rosterReadFor(actor) }),
    loadTrackParticipantViews(tracks),
  ]);
  const actorOf = (id: string) =>
    activityActorOf(id || null, movers.get(id), actor.userId);
  return tracks.map((t) => ({
    ...toTrackView(t, counts.get(t.id) ?? {}, actorOf, goals.get(t.id)),
    participants: participants.get(t.id) ?? [],
  }));
}

/**
 * The view a track WRITE returns. The write already happened, so a failed
 * count read must not turn it into a 500: the view comes back WITHOUT counts
 * (`sessionCount` absent — "not counted", never a fabricated 0), and the
 * failure is logged. Reads keep throwing ({@link loadTrackViews}).
 */
export async function loadWrittenTrackView(
  track: ProjectTrack,
  actor: Pick<TrackActor, "userId" | "agentUserId" | "isHubProtocol">
): Promise<TrackView> {
  try {
    return await loadTrackView(track, actor);
  } catch (err) {
    logger.warn(
      { err, trackId: track.id },
      "track written, but its stage counts could not be read"
    );
    return toTrackView(track);
  }
}

export async function loadTrackView(
  track: ProjectTrack,
  actor: Pick<TrackActor, "userId" | "agentUserId" | "isHubProtocol">
): Promise<TrackView> {
  const [view] = await loadTrackViews([track], actor);
  return view!;
}

/**
 * Resolve param answers against the method's DECLARED params (the pinned
 * snapshot). Refuses a mistyped value and an undeclared key — a stored,
 * rendered bag must have a declared shape. Returns only the keys the caller
 * actually supplied (a default stays the method's, never frozen onto the
 * track), coerced. A REQUIRED param left unanswered is NOT refused here: it
 * becomes an owed slot on the stage session that needs it.
 */
export function resolveTrackParams(
  declaredRaw: unknown,
  supplied: Record<string, unknown>
): Record<string, unknown> {
  const declared = readPlaybookParams(declaredRaw);
  const names = new Set(declared.map((p) => p.name));
  const undeclared = Object.keys(supplied).filter((k) => !names.has(k));
  if (undeclared.length > 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        declared.length === 0
          ? `This method declares no params — cannot store ${undeclared.map((k) => `"${k}"`).join(", ")}.`
          : `Unknown param${undeclared.length > 1 ? "s" : ""} ${undeclared.map((k) => `"${k}"`).join(", ")}. The method declares: ${[...names].join(", ")}.`,
    });
  }
  const resolution = validatePlaybookParams(declared, supplied);
  const [first] = resolution.typeErrors;
  if (first) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: describeParamTypeError(first),
    });
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(supplied)) {
    if (v === undefined || v === null || v === "") continue;
    if (k in resolution.declaredValues) out[k] = resolution.declaredValues[k];
  }
  return out;
}

/** What a track pins from its method. The same fields a run snapshots. */
export function buildTrackSnapshot(playbook: Playbook) {
  return {
    // structuredClone: a spread would share every stage OBJECT with the
    // playbook row (the Odoo "duplicate from template" bug the proto-track's
    // `buildProjectStageSettings` documented).
    stages: structuredClone(
      Array.isArray(playbook.stages) ? playbook.stages : []
    ),
    goalTemplate: playbook.goalTemplate,
    // NOT the method's top-level expectedOutputs / criteria: a track yields
    // nothing of its own (its stages' sessions do, from each stage's pinned
    // outputs + criteria above). Pinned until 2026-10-05, never read.
    // The method's DECLARED params (0274): what `project_tracks.params`
    // answers, pinned like the stages so a method edit never changes what a
    // live track is asked.
    params: structuredClone(
      Array.isArray(playbook.params) ? playbook.params : []
    ),
    version: playbook.version,
  };
}

function firstStageKey(stages: unknown): string | null {
  if (!Array.isArray(stages)) return null;
  const first = stages[0] as { key?: unknown } | undefined;
  return typeof first?.key === "string" && first.key ? first.key : null;
}

function stageKeys(stages: unknown): string[] {
  if (!Array.isArray(stages)) return [];
  return stages
    .map((s) =>
      s && typeof s === "object" ? (s as { key?: unknown }).key : null
    )
    .filter((k): k is string => typeof k === "string" && k.length > 0);
}

function proposed(
  perm: {
    proposalId: string;
    proposalType: string;
    reviewUrl: string;
  },
  fallback: string
): ProposedOutcome {
  return {
    status: "proposed",
    proposalId: perm.proposalId,
    proposalType: perm.proposalType,
    message: proposedMessageFor(perm.proposalType, fallback),
    reviewUrl: perm.reviewUrl,
  };
}

const repo = trackRepository;

/** Editor+ on the project's workspace, or the owner of a pod-personal project. */
async function assertProjectWrite(
  project: GateProject,
  userId: string
): Promise<void> {
  const db = await getDb();
  await assertWorkspaceWrite(db, userId, {
    workspaceId: project.workspaceId,
    ownerId: project.workspaceId ? undefined : project.userId,
  });
}

// ── reads ───────────────────────────────────────────────────────────────────

/** A track ONLY if the caller may see its project. */
export async function getTrack(
  trackId: string,
  actor: TrackActor
): Promise<ProjectTrack | null> {
  const row = await scopedDb(AccessContext.from(actor)).findFirst<ProjectTrack>(
    projectTracks,
    { where: eq(projectTracks.id, trackId) }
  );
  return row ?? null;
}

/**
 * THE track list read. With a `projectId`: that project's tracks, oldest
 * first (the order they were started in) — `null` when the project itself is
 * not visible, NOT `[]`: "no tracks" and "no such project for you" are
 * different facts. Without one: EVERY goal the caller can see, pod-wide (the
 * Goals collection, W5), newest first — floored on the same `project_tracks`
 * VisibilityRule (visible iff its project is), so it can never list a goal
 * the per-project read would hide. `page` bounds the read (a keyset cursor
 * over `created_at, id` in the read's own order); without it every row comes
 * back, as before.
 */
export async function listTracks(params: {
  projectId?: string | null;
  actor: TrackActor;
  includeArchived?: boolean;
  page?: { limit: number; cursor?: TrackListCursor | null };
}): Promise<ProjectTrack[] | null> {
  // A READ: the project is checked through the SAME `projects` VisibilityRule
  // the tracks below are floored on — member branch included (Sites W2 S2: a
  // project member, guest included, sees the project's tracks). NOT
  // `loadVisibleProject`: that floor also gates WRITES, so it deliberately has
  // no member branch.
  const access = AccessContext.from(params.actor);
  const projectId = params.projectId ?? null;
  if (projectId) {
    const project = await scopedDb(access).findFirst<{ id: string }>(projects, {
      where: eq(projects.id, projectId),
      columns: { id: true },
    });
    if (!project) return null;
  }
  // Pod-wide reads newest first (a collection); a project's own list keeps
  // the order its tracks were started in.
  const newestFirst = !projectId;
  const cursor = params.page?.cursor ?? null;
  // The keyset is `created_at` AT THE PRECISION THE CURSOR CARRIES (ms, an
  // ISO string) then the id — in the order AND the comparison (code.md): the
  // column keeps microseconds, so comparing it with a millisecond cursor
  // repeated or skipped rows started within the same millisecond.
  const createdMs = drizzleSql`date_trunc('milliseconds', ${projectTracks.createdAt})`;
  const at = cursor ? new Date(cursor.createdAt).toISOString() : null;
  const after =
    cursor && at
      ? newestFirst
        ? drizzleSql`(${createdMs} < ${at}::timestamptz OR (${createdMs} = ${at}::timestamptz AND ${projectTracks.id} < ${cursor.id}))`
        : drizzleSql`(${createdMs} > ${at}::timestamptz OR (${createdMs} = ${at}::timestamptz AND ${projectTracks.id} > ${cursor.id}))`
      : undefined;
  return scopedDb(access).findMany<ProjectTrack>(projectTracks, {
    where: and(
      projectId ? eq(projectTracks.projectId, projectId) : undefined,
      params.includeArchived ? undefined : ne(projectTracks.status, "archived"),
      after
    ),
    orderBy: newestFirst
      ? [drizzleSql`${createdMs} desc`, desc(projectTracks.id)]
      : [drizzleSql`${createdMs} asc`, asc(projectTracks.id)],
    ...(params.page ? { limit: params.page.limit } : {}),
  });
}

/** Where a paged track list resumes: the last row's `created_at` and id. */
export interface TrackListCursor {
  createdAt: string;
  id: string;
}

/** The opaque cursor a client hands back — never parsed outside this file. */
export function encodeTrackListCursor(row: {
  createdAt: Date | string;
  id: string;
}): string {
  return Buffer.from(
    JSON.stringify({
      createdAt: new Date(row.createdAt).toISOString(),
      id: row.id,
    })
  ).toString("base64url");
}

/** `null` for a cursor that does not decode — a refused input, never page 1. */
export function decodeTrackListCursor(
  raw: string | null | undefined
): TrackListCursor | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as {
      createdAt?: unknown;
      id?: unknown;
    };
    if (
      typeof v.createdAt === "string" &&
      Number.isFinite(Date.parse(v.createdAt)) &&
      typeof v.id === "string" &&
      v.id.length > 0
    ) {
      return { createdAt: v.createdAt, id: v.id };
    }
  } catch {
    // Not base64url JSON: the caller refuses it (400).
  }
  return null;
}

/** The default and the ceiling of a page of the pod-wide goals read. */
export const TRACK_LIST_PAGE_DEFAULT = 50;
export const TRACK_LIST_PAGE_MAX = 100;

/**
 * One PAGE of {@link listTracks} — the same read, asked for one row more than
 * the page so the next cursor exists only when a next page does. `null` as
 * the read's own `null` (an invisible project).
 */
export async function listTracksPage(params: {
  projectId?: string | null;
  actor: TrackActor;
  includeArchived?: boolean;
  limit: number;
  cursor?: TrackListCursor | null;
}): Promise<{ rows: ProjectTrack[]; nextCursor: string | null } | null> {
  const limit = Math.max(1, Math.min(TRACK_LIST_PAGE_MAX, params.limit));
  const rows = await listTracks({
    projectId: params.projectId,
    actor: params.actor,
    includeArchived: params.includeArchived,
    page: { limit: limit + 1, cursor: params.cursor ?? null },
  });
  if (!rows) return null;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    rows: page,
    nextCursor:
      rows.length > limit && last ? encodeTrackListCursor(last) : null,
  };
}

/**
 * How many projects use each method — DISTINCT projects over non-archived
 * tracks, counted only over projects the caller can SEE (a count of invisible
 * projects would disclose their existence). ONE grouped query for any number
 * of methods; a method no visible project uses is absent from the map (read
 * it as 0).
 */
export async function countProjectsUsingMethods(
  playbookIds: string[],
  actor: TrackActor
): Promise<Map<string, number>> {
  const ids = [...new Set(playbookIds)];
  if (ids.length === 0) return new Map();
  const db = await getDb();
  const access = AccessContext.from(actor);
  const rows = await db
    .select({
      playbookId: projectTracks.playbookId,
      n: drizzleSql<number>`count(distinct ${projectTracks.projectId})`,
    })
    .from(projectTracks)
    .where(
      and(
        inArray(projectTracks.playbookId, ids),
        ne(projectTracks.status, "archived"),
        // A key's grant narrows the count like any read of these rows (a
        // scoped key reads `GET /playbooks/:id` through the seams).
        grantReadPredicate(projectTracks),
        inArray(
          projectTracks.projectId,
          db
            .select({ id: projects.id })
            .from(projects)
            .where(
              and(projectVisibleWhere(access), grantReadPredicate(projects))
            )
        )
      )
    )
    .groupBy(projectTracks.playbookId);
  return new Map(
    rows
      .filter((r): r is { playbookId: string; n: number } => !!r.playbookId)
      .map((r) => [r.playbookId, Number(r.n)])
  );
}

export async function countProjectsUsingMethod(
  playbookId: string,
  actor: TrackActor
): Promise<number> {
  return (
    (await countProjectsUsingMethods([playbookId], actor)).get(playbookId) ?? 0
  );
}

// ── start ───────────────────────────────────────────────────────────────────

export interface StartTrackInput {
  projectId: string;
  /**
   * REOPEN (R8): the closed or dropped track this one is the NEW VERSION of —
   * same project, not already replaced by a newer version. The new track is
   * linked `new --replaces--> old` (the dependency door), the old one stays
   * closed with its verdict, and the old one's dependents follow the new one
   * (`deriveOpenBlockers` follows `replaces`). Set by `reopenTrack` and by
   * its `track/create` approval replay.
   */
  replacesTrackId?: string | null;
  /**
   * KEEP WATCHING IT (R6): the goal closed as MET that this new goal — an
   * operation — keeps alive. Same project; linked `new --spawned_from-->
   * old`. Set by `startOperationFrom` and by its `track/create` replay.
   */
  spawnedFromTrackId?: string | null;
  /**
   * The METHOD — optional (work model W1, 2026-10-11): a track is a goal;
   * stages are optional. Absent/null ⇒ a stage-less track,
   * and `name` is then required (there is no method name to default to).
   */
  playbookId?: string | null;
  /** Display name. Absent ⇒ the method's name (required with no method). */
  name?: string;
  /**
   * Initial answers to the method's declared params (0274). Validated against
   * the method (`resolveTrackParams`): a mistyped value or an undeclared key
   * refuses. A required param left out is NOT refused — it is owed on the
   * stage session that needs it.
   */
  params?: Record<string, unknown>;
  /** Where the track is heading, one line (0302). */
  direction?: string | null;
  /** The number it steers by (0302): `{ label, unit?, target, current? }`. */
  kpi?: unknown;
  /**
   * What the goal holds (0345) — end state, 0 or 2–5 criteria, drop
   * conditions, kind of work, uncertainty (`trackGoalInputSchema`, parsed
   * here). A person starting with a kind confirms it; an agent's is the AI's
   * proposal until a person confirms.
   */
  endState?: unknown;
  criteria?: unknown;
  dropConditions?: unknown;
  workKind?: unknown;
  uncertainty?: unknown;
  /** The goal's loop (0350, W4): `{ on, perWeek? }`; absent = the birth default. */
  loop?: unknown;
  /**
   * "MAKE IT A GOAL" (D2): the `goal` / `objective` / `okr` entity this goal
   * is made from (`convertEntityToGoal` maps its fields onto the input above).
   * Re-checked on every start, the replay included (`assertGoalSource`); the
   * goal's owner is the person behind the entity; the new goal is linked
   * `entity --promoted_to--> track`, and an entity that had ended arrives
   * closed (`met`) or dropped (`no_longer_needed`) by the person deciding.
   * Never set by the plain start doors — only by the convert door and the
   * `track/create` replay of its proposal.
   */
  fromEntity?: TrackFromEntity | null;
  actor: TrackActor;
  /**
   * Pre-minted id — ONLY the approval replay passes it (the id the proposal
   * was filed under), so the approved row and its receipt name the same id.
   */
  id?: string;
  /**
   * ONLY the `track/create` approval replay passes it: the consent the person
   * just gave (decision 2a). `agentUserId` is the proposing agent (the
   * proposal's own column, never its payload); `listedWorkspaceIds` are the
   * step spaces the proposal LISTED. The grant is the step spaces resolved
   * now ∩ the listed ones — approval can never admit a space nobody read.
   */
  approvedSpaceGrant?: {
    proposalId: string;
    agentUserId: string | null;
    listedWorkspaceIds: string[];
  };
}

export type StartTrackResult = (
  | {
      status: "started" | "exists";
      track: ProjectTrack;
      /** `null` for a stage-less track started with no method. */
      playbook: { id: string; name: string; version: number } | null;
    }
  | ProposedOutcome
) & {
  /**
   * Stage domains (workspace template slugs) with no live workspace the
   * caller can see — ADVISORY, never a refusal: those stages' sessions fall
   * back to the project's home workspace (and say so) until one is installed.
   */
  missingDomains: string[];
};

/**
 * Start a track on a project — a goal, open as long as it matters, closed by
 * a person with a verdict once its criteria are met. The method
 * (a project-scoped playbook, with stages) is optional; with none, `name` is
 * required and the track has no stages: work in it is `start_session` +
 * `trackId`. A LIVE track's identity on its project is its NAME (0317), and
 * the name defaults to the method's: starting the same method (or no method)
 * again under the same name returns the live track as `exists`, and nothing
 * is filed or written; under another name it starts a second track. Closed
 * and dropped tracks hold no name (`replacesTrackId` reopens one). A live track of ANOTHER method (or of a
 * method, when none was asked for) already holding the name is refused
 * (CONFLICT) — never handed back as if it were this one.
 */
export async function startTrack(
  input: StartTrackInput
): Promise<StartTrackResult> {
  const { actor } = input;
  const db = await getDb();

  const project = await loadVisibleProject(db, input.projectId, actor.userId);
  if (!project) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
  }

  // The method — OPTIONAL (W1): a track is a goal, and stages are optional. With one, its own visibility floor applies
  // (`scopedDb` + the `playbooks` rule) and only `scope: "project"` is a method.
  const playbook = input.playbookId
    ? await loadTrackMethod(input.playbookId, actor)
    : null;
  if (!playbook && !input.name?.trim()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        'Name the track — with no method there is no name to default to (e.g. name: "Grow the newsletter").',
    });
  }
  if (!playbook && input.params && Object.keys(input.params).length > 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "params answer a method's declared questions — a track with no method has none. Omit params.",
    });
  }

  await assertProjectWrite(project, actor.userId);

  // Re-checked on every call, the approval replay included: the old version
  // must still be closed and still unreplaced when the new one is born.
  const replaces = input.replacesTrackId
    ? await assertReplaceableTrack(input.replacesTrackId, project.id, actor)
    : null;
  // A conversion — re-checked here, so a replay approved after the entity
  // became a goal (or after its owner lost the project) applies nothing.
  const source = input.fromEntity
    ? await assertGoalSource(input.fromEntity, project, actor)
    : null;
  const spawnedFrom = input.spawnedFromTrackId
    ? await assertOperationSource(input.spawnedFromTrackId, project.id, actor)
    : null;

  // Advisory, computed from the method AS IT STANDS (what would be pinned).
  const missingDomains = playbook
    ? await listMissingStageDomains(db, playbook.stages, actor.userId)
    : [];

  const playbookRef = playbook
    ? { id: playbook.id, name: playbook.name, version: playbook.version }
    : null;

  const trackName = input.name?.trim() || playbook!.name;

  // IDEMPOTENT before governance: an agent asking for a track that already
  // runs under this name gets it back, rather than a proposal to create what
  // exists — read through the repository's live-name lookup, the index's
  // predicate.
  const live = await (await repo()).findLiveByName(project.id, trackName);
  if (live) {
    // A conversion never hands back an unrelated live goal as if it were the
    // entity's: it would read "made a goal" with nothing linked.
    if (source) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `A live goal on this project is already named "${live.name}" — make "${input.fromEntity!.title}" a goal under another name.`,
      });
    }
    assertNameHeldBySameMethod(live, playbook);
    // Reopening: the live track holding the name must BE the new version (a
    // repeated reopen), never an unrelated goal handed back as if it were.
    // Keeping a goal running: the live goal holding the name must be the
    // operation already spawned from it, never an unrelated one.
    if (spawnedFrom && !spawnedFrom.spawnedBy.includes(live.id)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `A live goal on this project is already named "${live.name}" — keep "${spawnedFrom.track.name}" running under another name.`,
      });
    }
    if (replaces && !replaces.replacedBy.includes(live.id)) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          `A live track on this project is already named "${live.name}" — ` +
          "work in it, or reopen this goal under another name.",
      });
    }
    return {
      status: "exists",
      track: live,
      playbook: playbookRef,
      missingDomains,
    };
  }
  // No live version holds the name, yet a newer version exists (closed since):
  // the line continues from the newest one, so a goal's versions stay one line.
  if (replaces && replaces.replacedBy.length > 0) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `Goal "${replaces.track.name}" was already reopened as a newer version — reopen that one instead.`,
    });
  }
  const trackId = input.id ?? randomUUID();

  // DECISION 2a / W5 — the spaces this track will work in: the project's
  // linked spaces (+ a legacy method's step spaces). An agent's start names
  // them in its proposal, so approving the start IS consenting to let that
  // agent work there for this track — and nowhere else, and no longer.
  const stepSpaces = await resolveTrackGrantSpaces(db, {
    stages: playbook?.stages ?? [],
    projectId: project.id,
    userId: actor.userId,
  });
  const spaceGrantConsent =
    actor.agentUserId && stepSpaces.length > 0
      ? {
          agentUserId: actor.agentUserId,
          agentName: await agentDisplayName(db, actor.agentUserId),
          spaces: stepSpaces.map(({ workspaceId, name }) => ({
            workspaceId,
            name,
          })),
        }
      : null;
  // Refused BEFORE governance, so a malformed answer is told to its author
  // rather than filed for a human to approve.
  const trackParams =
    input.params && playbook
      ? resolveTrackParams(playbook.params, input.params)
      : {};
  const direction = resolveTrackDirection(input.direction);
  // A KPI given at start is a WHOLE one (label + target); the `current`
  // stamp is applied at the write, so a replay stamps the approval moment.
  const kpiInput = input.kpi ? parseTrackKpiInput(input.kpi) : null;
  if (kpiInput) resolveTrackKpi(null, kpiInput, actor.userId);
  // What the goal holds (0345) — the 2–5 rule and the meanings refused here,
  // to the author. The parsed input rides the proposal; the replay resolves
  // it again, as the approving person (who thereby confirms the kind).
  // A loop the start does not name takes the birth default (W4, OFF).
  const goalInput = withBirthLoopDefault(
    parseTrackGoalInput(
      pickTrackGoalInput(input as unknown as Record<string, unknown>)
    )
  );
  const goalPatch = resolveTrackGoalPatch(
    null,
    goalInput,
    actor.agentUserId ? null : actor.userId
  );
  // An entity that was ACHIEVED arrives closed as met, and `met` needs every
  // required criterion met — none can be yet, so its criteria ride the end
  // state instead (`goalFromEntity`). Refused here, before anything is filed.
  const endedAs = input.fromEntity?.ended ?? null;
  if (
    endedAs?.status === "completed" &&
    (goalInput.criteria?.length ?? 0) > 0
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "A goal made from an achieved entity is born closed as met — it carries no criteria to judge (put them in the end state).",
    });
  }

  const perm = await checkPermissionOrPropose({
    userId: actor.userId,
    agentUserId: actor.agentUserId ?? undefined,
    sessionId: actor.sessionId ?? undefined,
    workspaceId: project.workspaceId ?? undefined,
    projectId: project.id,
    subjectType: "track",
    action: "create",
    // An agent switching the loop on is always reviewed (W4). So is an
    // agent's conversion of an entity that had ended: the goal is born closed
    // or dropped, and a close is a person's act.
    ...(agentSwitchesLoopOn(goalInput, actor.agentUserId) ||
    (actor.agentUserId && endedAs)
      ? { forcePropose: true }
      : {}),
    source: actor.source,
    reasoning: actor.reasoning,
    // EVERYTHING the replay needs. Nothing DERIVED (the snapshot) is stored:
    // the replay re-reads the method, re-checks its scope and both visibility
    // floors, and pins the definition as it stands at approval.
    data: {
      id: trackId,
      projectId: project.id,
      ...(playbook ? { playbookId: playbook.id } : {}),
      name: trackName,
      // The answers ride the proposal; the replay re-validates them against
      // the method as it stands at approval.
      ...(Object.keys(trackParams).length > 0 ? { params: trackParams } : {}),
      ...(direction ? { direction } : {}),
      ...(kpiInput ? { kpi: kpiInput } : {}),
      ...pickTrackGoalInput(goalInput),
      // The closed version this one reopens (R8) — re-checked at approval.
      ...(replaces ? { replacesTrackId: replaces.track.id } : {}),
      // The goal this operation keeps running (R6) — re-checked at approval.
      ...(spawnedFrom ? { spawnedFromTrackId: spawnedFrom.track.id } : {}),
      // The entity this goal is made from (D2) — re-checked at approval.
      ...(input.fromEntity ? { fromEntity: input.fromEntity } : {}),
      // The consent the summary states ("…and let <agent> work in …").
      ...(spaceGrantConsent
        ? { [TRACK_SPACE_GRANT_KEY]: spaceGrantConsent }
        : {}),
    },
  });
  if ("denied" in perm && perm.denied) {
    throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
  }
  if ("proposalId" in perm) {
    return {
      ...proposed(
        perm,
        buildObjectActionTitle({
          action: "create",
          objectKind: "track",
          objectName: trackName,
        }) + " — proposed for review"
      ),
      missingDomains,
    };
  }

  const snapshot = playbook ? buildTrackSnapshot(playbook) : null;
  const { track, created } = await (
    await repo()
  ).createOrGet(
    {
      id: trackId,
      projectId: project.id,
      playbookId: playbook?.id ?? null,
      name: trackName,
      // A stage-less track pins nothing: the column defaults (`{}` / "1").
      definitionSnapshot: snapshot ?? {},
      methodVersion: snapshot ? String(playbook!.version) : "1",
      // Seeded at birth, like a session's first stage: nobody "advanced into"
      // the first stage, so the gate is not consulted here.
      currentStage: snapshot ? firstStageKey(snapshot.stages) : null,
      params: trackParams,
      direction,
      kpi: kpiInput
        ? resolveTrackKpi(null, kpiInput, actor.agentUserId ?? actor.userId)
        : null,
      ...(goalPatch ? { goal: goalPatch } : {}),
      ...trackSpaceGrantMetadata(input, stepSpaces),
    },
    actor.userId
  );

  // A concurrent start of ANOTHER method under the same name won the insert.
  if (!created) assertNameHeldBySameMethod(track, playbook);

  // A NEW goal is born whole or not at all (code-core F9): its people, its
  // edges (method, the version it reopens, the entity it is made from) and a
  // born-closed close. The track row is written first — the dependency door
  // validates the edge against it — so a later step that fails UNDOES the
  // birth (`undoTrackBirth`) before the error surfaces. A retried reopen or
  // conversion then starts clean, and never meets a half-made goal holding
  // the name with no lineage.
  let born = track;
  if (created) {
    try {
      born = await completeTrackBirth({
        input,
        track,
        project,
        playbook,
        replaces,
        spawnedFrom,
        source,
        endedAs,
      });
    } catch (err) {
      await undoTrackBirth(track.id, actor.userId);
      throw err;
    }
    void emitSideEffects({
      subjectType: "track",
      action: "create",
      subjectId: track.id,
      userId: actor.userId,
      workspaceId: project.workspaceId,
      data: {
        trackId: track.id,
        projectId: project.id,
        playbookId: playbook?.id ?? null,
        methodVersion: track.methodVersion,
      },
    }).catch((err) =>
      logger.warn({ err, trackId: track.id }, "track.create emit failed")
    );
  }

  return {
    status: created ? "started" : "exists",
    track: born,
    playbook: playbookRef,
    missingDomains,
  };
}

/**
 * Everything a NEW goal is born with after its row (`startTrack`): any step
 * that fails throws, and the caller undoes the birth.
 */
async function completeTrackBirth(p: {
  input: StartTrackInput;
  track: ProjectTrack;
  project: GateProject;
  playbook: Awaited<ReturnType<typeof loadTrackMethod>> | null;
  replaces: Awaited<ReturnType<typeof assertReplaceableTrack>> | null;
  spawnedFrom: Awaited<ReturnType<typeof assertOperationSource>> | null;
  source: Awaited<ReturnType<typeof assertGoalSource>> | null;
  endedAs: TrackFromEntity["ended"] | null;
}): Promise<ProjectTrack> {
  const { input, track, project, playbook, replaces, spawnedFrom } = p;
  const { source, endedAs } = p;
  const { actor } = input;
  // WHO IS ON IT (W3): a goal is born with its owner — the person who started
  // it (an agent's start is approved by a person, who is `actor.userId` then).
  // A REOPENED goal (R8) is born with the closed version's people instead:
  // its owner and judge, its delegates asked again (`carryGoalParticipants`).
  if (replaces) {
    await carryGoalParticipants(
      replaces.track,
      track,
      actor.userId,
      project.userId
    );
  } else {
    // A conversion's goal is owned by the person behind the entity.
    await seedGoalOwner(track, project.userId, source?.ownerPersonId);
  }

  if (playbook) {
    // Provenance edge — the same `instantiated_from` shape the proto-track
    // wrote, so every reader of `project --instantiated_from--> playbook`
    // keeps working. Idempotent on the unique edge.
    await createLinks([
      {
        workspaceId: project.workspaceId,
        fromType: "project",
        fromId: project.id,
        toType: "playbook",
        toId: playbook.id,
        linkType: "instantiated_from",
      },
    ]);
  }
  if (replaces) {
    // `new --replaces--> old` through THE dependency door (validated, one
    // producer, `link.create.completed` emitted). The start is already
    // authorized, so the ungoverned write is the right one. A failure undoes
    // the birth: a new version that lost its lineage would read as an
    // unrelated goal, and the old one's dependents would stay held.
    const linked = await writeDependencyLink({
      edge: {
        fromType: "track",
        fromId: track.id,
        toType: "track",
        toId: replaces.track.id,
        linkType: REPLACES_LINK_TYPE,
      },
      userId: actor.userId,
      attribution: {
        agentUserId: input.approvedSpaceGrant?.agentUserId ?? actor.agentUserId,
        proposalId: input.approvedSpaceGrant?.proposalId ?? null,
        sessionId: actor.sessionId ?? null,
      },
    });
    if (!linked.ok) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `Goal "${track.name}" could not be linked to the version it reopens, so it was not started: ${linked.error}`,
      });
    }
  }
  if (spawnedFrom) {
    // R6: the operation says where it came from (the neighbourhood reads
    // `spawned_from` as "came from" / "became"). Idempotent on the edge.
    await createLinks([
      {
        workspaceId: project.workspaceId,
        fromType: "track",
        fromId: track.id,
        toType: "track",
        toId: spawnedFrom.track.id,
        linkType: "spawned_from",
      },
    ]);
  }
  // MAKE IT A GOAL (D2): the lineage edge, then — for an entity that had
  // ended — the close or drop, through THE status write (`applyTrackStatus`:
  // the judge rule, the verdict stamp), as the person deciding (the approver
  // on a replay), who `assertGoalSource` checked owns it when it is a close.
  if (source) await writeGoalLineage(source.entity, track.id);
  if (source && endedAs) {
    const close = { verdict: endedAs.verdict };
    assertTrackTransition(track, endedAs.status, close, []);
    return (
      await applyTrackStatus(
        track,
        project,
        endedAs.status,
        actor.userId,
        close
      )
    ).track;
  }
  return track;
}

/**
 * UNDO A BIRTH that failed half-way (`startTrack`): the new goal's edges, on
 * either end, then its row — its participants go with it (FK cascade), and
 * the repository records the delete beside the create it recorded. Never
 * throws over the original error: a failure here is logged, the start's own
 * error is what the caller sees.
 */
async function undoTrackBirth(trackId: string, userId: string): Promise<void> {
  try {
    const db = await getDb();
    await db
      .delete(links)
      .where(
        or(
          and(eq(links.fromType, "track"), eq(links.fromId, trackId)),
          and(eq(links.toType, "track"), eq(links.toId, trackId))
        )
      );
    await (await repo()).delete(trackId, userId);
  } catch (err) {
    logger.error({ err, trackId }, "a goal's failed birth could not be undone");
  }
}

/**
 * A live track holding the requested name is "this method, already running"
 * ONLY when it runs this method; otherwise the name is taken by another track
 * and the caller must choose another one.
 */
function assertNameHeldBySameMethod(
  live: ProjectTrack,
  playbook: { id: string; name: string } | null
): void {
  // Same method — or both method-less: the live track IS the one asked for.
  if (live.playbookId === (playbook?.id ?? null)) return;
  throw new TRPCError({
    code: "CONFLICT",
    message: playbook
      ? `A live track on this project is already named "${live.name}" and does ` +
        `not run "${playbook.name}" — pass another name to start it.`
      : `A live track on this project is already named "${live.name}" and ` +
        `runs a method — pass another name to start a new track.`,
  });
}

/** The tracks that already replace `trackId` (newer versions of it). */
async function replacingTrackIds(trackId: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db
    .select({ fromId: links.fromId })
    .from(links)
    .where(
      and(
        eq(links.fromType, "track"),
        eq(links.toType, "track"),
        eq(links.toId, trackId),
        eq(links.linkType, REPLACES_LINK_TYPE)
      )
    );
  return rows.map((r) => r.fromId);
}

/**
 * The track a reopen replaces: visible to the actor, on THIS project, and
 * closed or dropped (a live goal needs no reopening). `replacedBy` lists the
 * newer versions already linked to it: `startTrack` hands back the live one
 * (a repeated reopen is idempotent) and refuses a reopen of an old version
 * whose newer one has closed since — reopen the newest, so a goal's versions
 * stay one line.
 */
async function assertReplaceableTrack(
  trackId: string,
  projectId: string,
  actor: TrackActor
): Promise<{ track: ProjectTrack; replacedBy: string[] }> {
  const old = await getTrack(trackId, actor);
  if (!old || old.projectId !== projectId) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "The goal to reopen was not found on this project.",
    });
  }
  if (!isTrackClosed(old)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Goal "${old.name}" is ${resolveTrackStatusLabel(old.status).toLowerCase()}, not closed — work in it instead of reopening it.`,
    });
  }
  // Only the closed goal's OWNER or JUDGE reopens it (R8, W5): the new
  // version carries their goal, its judge and its delegates. `actor.userId`
  // is the person — an agent's linked person on its proposal, the approver
  // on the replay.
  const people = await goalParticipantRows(old.id);
  const owner = goalOwner(people, old);
  const judge = goalJudge(people, old);
  if (actor.userId !== owner && actor.userId !== judge) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `Only the owner or the judge of "${old.name}" can reopen it.`,
    });
  }
  return { track: old, replacedBy: await replacingTrackIds(old.id) };
}

/**
 * REOPEN a closed or dropped goal (R8) — as a NEW version, never in place:
 * the closed track keeps its status and verdict, and its sessions stay filed
 * on it. The new track carries the same name (free once the old one is not
 * live), method, answers and direction, and the KPI's definition (not its last
 * stated value), starts `active`, and is linked `new --replaces--> old`.
 * Through `startTrack`, so governance, idempotency and the space-grant consent
 * are the start's own: an agent's reopen is a proposal.
 */
export async function reopenTrack(input: {
  trackId: string;
  /** A new name — absent ⇒ the closed track's. */
  name?: string;
  actor: TrackActor;
}): Promise<StartTrackResult> {
  const old = await getTrack(input.trackId, input.actor);
  if (!old) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Goal not found" });
  }
  const kpi = readTrackKpi(old.kpi);
  const params =
    old.playbookId && old.params && Object.keys(old.params).length > 0
      ? old.params
      : undefined;
  return startTrack({
    projectId: old.projectId,
    playbookId: old.playbookId,
    name: input.name?.trim() || old.name,
    ...(params ? { params } : {}),
    ...(old.direction ? { direction: old.direction } : {}),
    ...(kpi
      ? {
          kpi: {
            label: kpi.label,
            target: kpi.target,
            ...(kpi.unit ? { unit: kpi.unit } : {}),
          },
        }
      : {}),
    // What the goal holds carries to the new version — the criteria WITHOUT
    // the judge's decisions (they were about the closed version's work).
    ...goalContentOf(old),
    replacesTrackId: old.id,
    actor: input.actor,
  });
}

/**
 * The goal an operation keeps running (R6): visible to the actor, on THIS
 * project, closed as MET (an operation keeps a delivered result alive; a
 * goal that was not met is reopened instead). `spawnedBy` lists the goals
 * already started from it, so a repeat hands the live one back.
 */
async function assertOperationSource(
  trackId: string,
  projectId: string,
  actor: TrackActor
): Promise<{ track: ProjectTrack; spawnedBy: string[] }> {
  const old = await getTrack(trackId, actor);
  if (!old || old.projectId !== projectId) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "The goal to keep running was not found on this project.",
    });
  }
  if (old.status !== "completed" || old.verdict !== "met") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Only a goal closed as met can be kept running — "${old.name}" is ${resolveTrackStatusLabel(old.status).toLowerCase()}${old.verdict ? ` (${resolveTrackVerdictLabel(old.verdict).toLowerCase()})` : ""}. Reopen it as a new version instead.`,
    });
  }
  const db = await getDb();
  const rows = await db
    .select({ fromId: links.fromId })
    .from(links)
    .where(
      and(
        eq(links.fromType, "track"),
        eq(links.toType, "track"),
        eq(links.toId, old.id),
        eq(links.linkType, "spawned_from")
      )
    );
  return { track: old, spawnedBy: rows.map((r) => r.fromId) };
}

/**
 * "KEEP WATCHING IT" (R6): from a goal closed as MET, start a new goal of
 * kind OPERATION that keeps its result alive — the same name (free once the
 * old one closed) unless given, its end state, criteria and direction, linked
 * `new --spawned_from--> old`. Through `startTrack`: governance, idempotency
 * and the consent are the start's own (an agent's start is a proposal). A
 * live operation already spawned from it comes back as `exists`.
 */
export async function startOperationFrom(input: {
  trackId: string;
  name?: string;
  actor: TrackActor;
}): Promise<StartTrackResult> {
  const old = await getTrack(input.trackId, input.actor);
  if (!old) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Goal not found" });
  }
  const { spawnedBy } = await assertOperationSource(
    old.id,
    old.projectId,
    input.actor
  );
  if (spawnedBy.length > 0) {
    const db = await getDb();
    const [live] = await db
      .select()
      .from(projectTracks)
      .where(
        and(
          inArray(projectTracks.id, spawnedBy),
          inArray(projectTracks.status, [...LIVE_PROJECT_TRACK_STATUSES])
        )
      )
      .limit(1);
    if (live) {
      return {
        status: "exists",
        track: live as ProjectTrack,
        playbook: null,
        missingDomains: [],
      };
    }
  }
  const content = goalContentOf(old);
  return startTrack({
    projectId: old.projectId,
    name: input.name?.trim() || old.name,
    ...(old.direction ? { direction: old.direction } : {}),
    ...(content.endState ? { endState: content.endState } : {}),
    ...(content.criteria ? { criteria: content.criteria } : {}),
    ...(content.dropConditions
      ? { dropConditions: content.dropConditions }
      : {}),
    workKind: "operation",
    spawnedFromTrackId: old.id,
    actor: input.actor,
  });
}

/** A track's stored goal content as start input (no acceptance, no confirmation). */
function goalContentOf(track: ProjectTrack): Partial<StartTrackInput> {
  const endState = readEndState(track.endState);
  const criteria = readCriteria(track.criteria);
  const dropConditions = readDropConditions(track.dropConditions);
  const workKind = readTrackWorkKind(track.workKind);
  const uncertainty = readTrackUncertainty(track.uncertainty);
  return {
    ...(endState ? { endState } : {}),
    ...(criteria.length > 0 ? { criteria } : {}),
    ...(dropConditions.length > 0 ? { dropConditions } : {}),
    ...(workKind ? { workKind } : {}),
    ...(uncertainty ? { uncertainty } : {}),
  };
}

/**
 * The method a track would run, through its own visibility floor (`scopedDb`
 * + the `playbooks` rule). Only `scope: "project"` is a method: a SESSION
 * playbook is a template for one bounded piece of work, started as a session
 * (in a track, with `trackId`) instead.
 */
async function loadTrackMethod(
  playbookId: string,
  actor: TrackActor
): Promise<Playbook> {
  const playbook = await scopedDb(
    AccessContext.from(actor)
  ).findFirst<Playbook>(playbooks, {
    where: eq(playbooks.id, playbookId),
  });
  if (!playbook) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Playbook ${playbookId} not found`,
    });
  }
  if (playbook.scope !== "project") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `Playbook "${playbook.name}" is ${playbook.scope ?? "session"}-scoped. ` +
        "Only a project-scoped playbook can run as a track's method — start a " +
        "session playbook as a session instead (pass trackId to work it inside " +
        "a track), or start the track with no method.",
    });
  }
  return playbook;
}

/** The agent's name for the consent sentence — never its id. */
async function agentDisplayName(
  db: Awaited<ReturnType<typeof getDb>>,
  agentUserId: string
): Promise<string> {
  const [row] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, agentUserId))
    .limit(1);
  return row?.name?.trim() || "the agent";
}

/**
 * The grant stamped on a NEW track (decision 2a; see `track-space-grant.ts`).
 * Approval replay ⇒ the proposing agent, resolved ∩ listed spaces. Direct
 * agent start ⇒ that agent. A person's own start ⇒ any agent acting for them
 * (`agentUserIds: null`). No space (no project link, no step space) ⇒
 * nothing stamped.
 */
function trackSpaceGrantMetadata(
  input: StartTrackInput,
  stepSpaces: ReadonlyArray<{ workspaceId: string }>
): { metadata?: Record<string, unknown> } {
  const approved = input.approvedSpaceGrant;
  const resolved = stepSpaces.map((s) => s.workspaceId);
  const workspaceIds = approved
    ? resolved.filter((w) => approved.listedWorkspaceIds.includes(w))
    : resolved;
  if (workspaceIds.length === 0) return {};
  const agentUserIds = approved
    ? approved.agentUserId
      ? [approved.agentUserId]
      : null
    : input.actor.agentUserId
      ? [input.actor.agentUserId]
      : null;
  const grant: TrackSpaceGrant = {
    operatorUserId: input.actor.userId,
    agentUserIds,
    workspaceIds,
    grantedBy: input.actor.userId,
    grantedAt: new Date().toISOString(),
    ...(approved ? { proposalId: approved.proposalId } : {}),
  };
  return { metadata: { [TRACK_SPACE_GRANT_KEY]: grant } };
}

// ── writes on an existing track ─────────────────────────────────────────────

/** Load a track the actor can SEE, and its project, for a write. */
export async function loadTrackForWrite(
  trackId: string,
  actor: TrackActor
): Promise<{ track: ProjectTrack; project: GateProject }> {
  const track = await getTrack(trackId, actor);
  if (!track) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Goal not found" });
  }
  const db = await getDb();
  const project = await loadVisibleProject(db, track.projectId, actor.userId);
  if (!project) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Goal not found" });
  }
  await assertProjectWrite(project, actor.userId);
  return { track, project };
}

/**
 * The goal and its project for a PERSON ending it from the seat that may
 * (`assertGoalEnder`: the judge closes; the owner or judge drops), read
 * through the READ floors only — `null` for anything else (an agent, another
 * move, someone without the seat), which then takes {@link loadTrackForWrite}.
 */
async function loadTrackForEnding(
  trackId: string,
  to: ProjectTrackStatus,
  actor: TrackActor
): Promise<{ track: ProjectTrack; project: GateProject } | null> {
  const category = trackStatusCategory(to);
  if ((category !== "done" && category !== "lost") || actor.agentUserId) {
    return null;
  }
  const track = await getTrack(trackId, actor);
  if (!track) return null;
  try {
    await assertGoalEnder(track, to, actor.userId);
  } catch {
    return null;
  }
  const project = await scopedDb(
    AccessContext.from(actor)
  ).findFirst<GateProject>(projects, {
    where: eq(projects.id, track.projectId),
    columns: { id: true, workspaceId: true, userId: true },
  });
  return project ? { track, project } : null;
}

/** How a goal ended, as a status move carries it (R1). */
export interface TrackCloseInput {
  verdict?: string | null;
  verdictReason?: string | null;
}

/**
 * Refuse a status move the shared lifecycle does not allow — the transition
 * (`TRACK_STATUS_TRANSITIONS`, derived from the categories: done and lost are
 * final) and the verdict (`checkTrackClose`: closing needs a done verdict;
 * a drop may come without one — shipped clients — but a verdict sent is
 * validated; impossible / replaced need a reason; an operation closes only
 * `retired`, and only an operation may — R6; nothing else carries one).
 * Called by `setTrackStatus` AND by the `track/update` approval
 * replay: a proposal filed while the move was legal can be approved after the
 * track moved on (dropped, say) — replaying it unchecked would revive a
 * closed track.
 */
export function assertTrackTransition(
  track: Pick<ProjectTrack, "name" | "status" | "workKind">,
  to: ProjectTrackStatus,
  close: TrackCloseInput = {},
  /**
   * The goal's criteria with their DERIVED marks (`loadGoalCloseCriteria`):
   * `met` needs every required one met, `partly_met` / `not_met` at least
   * one not met. Every caller that closes passes them.
   */
  criteria?: ReadonlyArray<{ key: string; required?: boolean; mark: string }>
): void {
  if (!canTransitionTrack(track.status, to)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: isTrackClosed(track)
        ? `Goal "${track.name}" is ${resolveTrackStatusLabel(track.status).toLowerCase()} — that is final. Reopen it as a new version to work on it again.`
        : `Goal "${track.name}" is ${resolveTrackStatusLabel(track.status).toLowerCase()} — it cannot move to ${resolveTrackStatusLabel(to).toLowerCase()}.`,
    });
  }
  const refusal = checkTrackClose(to, close, criteria, track.workKind);
  if (refusal) {
    throw new TRPCError({ code: "BAD_REQUEST", message: refusal });
  }
}

/**
 * The criteria a close is judged against — the goal's criteria with their
 * marks DERIVED now (`loadTrackGoalFacts`, the read every track view uses).
 * Read only for a move into done: a drop's verdict is about why it stopped
 * mattering, not about its criteria. A failed read THROWS: a close is never
 * judged against criteria it could not see.
 */
export async function loadGoalCloseCriteria(
  track: ProjectTrack,
  to: ProjectTrackStatus,
  userId: string
): Promise<Array<{ key: string; required?: boolean; mark: string }>> {
  if (trackStatusCategory(to) !== "done") return [];
  if (readCriteria(track.criteria).length === 0) return [];
  const facts = (await loadTrackGoalFacts([track], userId)).get(track.id);
  return (facts?.criteria ?? []).map((c) => ({
    key: c.key,
    ...(c.required === false ? { required: false } : {}),
    mark: c.mark ?? "not_started",
  }));
}

/**
 * What a move INTO `to` means for governance — the SAME classifier every
 * kind's status move goes through (`classifyLifecycleMove`, read on the
 * track's system lifecycle). Handed to `checkPermissionOrPropose` only for a
 * move into done/lost or a person-only status: there it lifts the floors
 * (a person-only status always proposes for an agent, whatever rule the pod
 * has; into lost proposes unless a rule names the write). Every other move
 * keeps the classification `track/update` already had.
 */
export function trackStatusLifecycleMove(
  to: ProjectTrackStatus
): { intoTerminal: boolean; humanOnly: boolean } | undefined {
  const move = classifyLifecycleMove(TRACK_LIFECYCLE, to);
  if (!move || (!move.intoTerminal && !move.humanOnly)) return undefined;
  return { intoTerminal: move.intoTerminal, humanOnly: move.humanOnly };
}

export type SetTrackStatusResult =
  { status: "updated" | "unchanged"; track: ProjectTrack } | ProposedOutcome;

export async function setTrackStatus(input: {
  trackId: string;
  status: ProjectTrackStatus;
  /** Required to close (done); optional, but validated, to drop (lost). */
  verdict?: string | null;
  /** Required for the verdicts `impossible` and `replaced`. */
  verdictReason?: string | null;
  actor: TrackActor;
}): Promise<SetTrackStatusResult> {
  // THE JUDGE'S OWN ENDING (code.md): the judge seat IS the right to close
  // (the owner's or judge's, to drop) — a person who holds it ends the goal
  // with read access alone, never also needing write on the project, and no
  // rule stands between them and their own decision. Anyone else writes.
  const ender = await loadTrackForEnding(
    input.trackId,
    input.status,
    input.actor
  );
  const { track, project } =
    ender ?? (await loadTrackForWrite(input.trackId, input.actor));
  if (track.status === input.status) return { status: "unchanged", track };
  const close = {
    verdict: input.verdict ?? null,
    verdictReason: input.verdictReason?.trim() || null,
  };
  // Refused BEFORE governance, so a close with no verdict — or a "met" with
  // criteria still open — is told to its author rather than filed for a
  // person to approve.
  assertTrackTransition(
    track,
    input.status,
    close,
    await loadGoalCloseCriteria(track, input.status, input.actor.userId)
  );

  if (ender) {
    return applyTrackStatus(
      track,
      project,
      input.status,
      input.actor.userId,
      close
    );
  }
  const perm = await checkPermissionOrPropose({
    userId: input.actor.userId,
    agentUserId: input.actor.agentUserId ?? undefined,
    sessionId: input.actor.sessionId ?? undefined,
    workspaceId: project.workspaceId ?? undefined,
    projectId: project.id,
    subjectType: "track",
    action: "update",
    source: input.actor.source,
    reasoning: input.actor.reasoning,
    lifecycleMove: trackStatusLifecycleMove(input.status),
    // An agent's DROP always proposes (F7, `goalMayDrop`): only the goal's
    // owner or judge may drop it, so a rule must never apply it unreviewed.
    ...(input.actor.agentUserId && trackStatusCategory(input.status) === "lost"
      ? { forcePropose: true }
      : {}),
    data: {
      id: track.id,
      name: track.name,
      status: input.status,
      ...(close.verdict ? { verdict: close.verdict } : {}),
      ...(close.verdictReason ? { verdictReason: close.verdictReason } : {}),
    },
  });
  if ("denied" in perm && perm.denied) {
    throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
  }
  if ("proposalId" in perm) {
    // Only the judge's (a drop: the owner's or judge's) approval applies, so
    // the proposal goes to THEIR Needs you as a judgement (F12).
    await noticeGoalEndProposed({
      track,
      workspaceId: project.workspaceId ?? null,
      proposalId: perm.proposalId,
      to: input.status,
      verdict: close.verdict,
      proposerUserId: input.actor.agentUserId ?? input.actor.userId,
    });
    return proposed(
      perm,
      buildObjectActionTitle({
        action: "update",
        objectKind: "track",
        objectName: track.name,
      }) + " — proposed for review"
    );
  }
  return applyTrackStatus(
    track,
    project,
    input.status,
    input.actor.userId,
    close
  );
}

/**
 * The status write itself. Callers: `setTrackStatus` and the approval replay —
 * BOTH have run `assertTrackTransition` first (transition AND verdict).
 * Compare-and-set on the status it was decided from: a track moved by someone
 * else in between is a CONFLICT, never a silent overwrite. Every status change
 * clears the check gate's `metadata.checkGate` marker — a person has now
 * decided the track's state, so the hold it recorded no longer describes it.
 * A move into done (or into lost WITH a verdict) stamps the verdict, its
 * reason and who closed it (`userId` — the person; on a replay, the
 * approver) in the same statement. A drop without one stamps nothing.
 */
export async function applyTrackStatus(
  track: ProjectTrack,
  project: GateProject,
  status: ProjectTrackStatus,
  userId: string,
  close: TrackCloseInput = {}
): Promise<{ status: "updated"; track: ProjectTrack }> {
  // Only the goal's JUDGE closes it (W3), only its owner or judge drops it
  // (F7) — the person acting here, or the APPROVER on a replay. ONE place:
  // both callers reach the write through it.
  await assertGoalEnder(track, status, userId);
  const ending = trackStatusCategory(status);
  const terminal = ending === "done" || ending === "lost";
  const verdict = isTrackVerdict(close.verdict) ? close.verdict : null;
  if (ending === "done" && !verdict) {
    // Unreachable past `assertTrackTransition`; refused rather than written.
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        checkTrackClose(status, close, undefined, track.workKind) ??
        "A verdict is required.",
    });
  }
  const updated = await (
    await repo()
  ).transitionStatus(
    track.id,
    {
      from: track.status,
      to: status,
      dropMetadataKey: CHECK_GATE_METADATA_KEY,
      // Decision 2a: closing/dropping ENDS the track's space grant — a stamp,
      // so nothing revives it (a reopened goal is a NEW track with its own).
      // Pausing needs no stamp: the gate admits only an ACTIVE track (W5), so
      // resuming restores it.
      ...(terminal
        ? {
            metadataPatch: endTrackSpaceGrant(
              track.metadata,
              status as TrackStatusIn<"done" | "lost">
            ),
            // A drop with no verdict (a client shipped before verdicts)
            // stamps nothing: it reads like a track dropped before 0344.
            ...(verdict
              ? {
                  close: {
                    verdict: verdict as ProjectTrackVerdict,
                    reason: close.verdictReason?.trim() || null,
                    by: userId,
                  },
                }
              : {}),
          }
        : {}),
    },
    userId
  );
  if (!updated) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `Goal "${track.name}" changed while this was being decided — reload it and try again.`,
    });
  }
  void emitSideEffects({
    subjectType: "track",
    action: "update",
    subjectId: track.id,
    userId,
    workspaceId: project.workspaceId,
    data: {
      trackId: track.id,
      projectId: project.id,
      fromStatus: track.status,
      toStatus: status,
      ...(terminal ? { verdict } : {}),
    },
  }).catch((err) =>
    logger.warn({ err, trackId: track.id }, "track.update emit failed")
  );
  // A goal no longer being worked waits on no judgement; one being worked
  // again shows its judge the claims still waiting.
  await refreshGoalJudgements(track.id);
  // An ENDED goal leaves nothing asking anyone for anything: commitments,
  // escalations, loop stops, its loop's pending proposals. Loaded on use:
  // it reaches the loop and the session start door.
  if (terminal) {
    const { settleEndedGoal } = await import("./goal-end.js");
    await settleEndedGoal({
      trackId: track.id,
      ending: ending as "done" | "lost",
      userId,
    });
  }
  return { status: "updated", track: updated };
}

// ── stage advance ───────────────────────────────────────────────────────────

/**
 * The session a stage OFFERS once the track enters it (M2). Entering a stage
 * never starts work: the offer is what a surface shows as "Start this step",
 * and `startStageSession` is the one door that acts on it.
 */
export interface StageSessionOffer {
  stageKey: string;
  name: string;
  /** The stage's own goal — the brief the session is started with. */
  goal: string | null;
  suggestedTasks: string[];
}

export interface AdvanceTrackStageResult {
  status: "advanced" | "unchanged";
  track: ProjectTrack;
  /** True when the stage entered declares a gate (human or check). */
  gated: boolean;
  /** True only when the track row was actually flipped to `paused`. */
  paused: boolean;
  proposalId?: string;
  proposalType?: string;
  check?: { passed: boolean; failing: string[]; reason?: string };
  /**
   * The session the stage just entered offers — `null` when nothing moved, or
   * when the caller already has an open session filed at that stage.
   */
  offer: StageSessionOffer | null;
}

/**
 * Move a track to ANY declared stage of its pinned method — forward, back or
 * sideways (stages are re-enterable). Governed for agents (`track/update`).
 */
export async function advanceTrackStage(input: {
  trackId: string;
  toStage: string;
  actor: TrackActor;
}): Promise<AdvanceTrackStageResult | ProposedOutcome> {
  const { track, project } = await loadTrackForWrite(
    input.trackId,
    input.actor
  );
  assertStageAdvanceable(track, input.toStage);
  if (track.currentStage === input.toStage) {
    return {
      status: "unchanged",
      track,
      gated: false,
      paused: false,
      offer: null,
    };
  }

  const perm = await checkPermissionOrPropose({
    userId: input.actor.userId,
    agentUserId: input.actor.agentUserId ?? undefined,
    sessionId: input.actor.sessionId ?? undefined,
    workspaceId: project.workspaceId ?? undefined,
    projectId: project.id,
    subjectType: "track",
    action: "update",
    source: input.actor.source,
    reasoning: input.actor.reasoning,
    data: { id: track.id, name: track.name, currentStage: input.toStage },
  });
  if ("denied" in perm && perm.denied) {
    throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
  }
  if ("proposalId" in perm) {
    return proposed(
      perm,
      buildObjectActionTitle({
        action: "update",
        objectKind: "track",
        objectName: track.name,
      }) + " — proposed for review"
    );
  }
  return applyTrackStageAdvance({
    track,
    project,
    toStage: input.toStage,
    userId: input.actor.userId,
    agentUserId: input.actor.agentUserId ?? null,
    gate: true,
  });
}

/** Refuses a stage the pinned method does not declare, or a closed track. */
export function assertStageAdvanceable(track: ProjectTrack, toStage: string) {
  if (isTrackClosed(track)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Goal "${track.name}" is ${resolveTrackStatusLabel(track.status).toLowerCase()} — reopen it as a new version before moving its stage.`,
    });
  }
  const keys = stageKeys(track.definitionSnapshot?.stages);
  if (!keys.includes(toStage)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        keys.length === 0
          ? `Goal "${track.name}" follows a method with no stages.`
          : `"${toStage}" is not a stage of "${track.name}". Stages: ${keys.join(", ")}.`,
    });
  }
}

/**
 * THE writer of `project_tracks.current_stage` after birth. Writes the stage,
 * emits `track.stage_changed`, then hands the gate to the shared core.
 *
 * ORDER IS LOAD-BEARING, and it is the session door's order: the gate runs
 * AFTER the write and the emit — a gate is a PAUSE, not a veto
 * (services/playbooks/stage-gate.ts).
 *
 * `gate: false` is the APPROVAL RE-APPLY — a human has just answered the
 * proposal for this very advance; re-gating would ask the same person for the
 * same move twice (the precedent `advance-stage.ts` records for sessions).
 */
export async function applyTrackStageAdvance(params: {
  track: ProjectTrack;
  project: GateProject;
  toStage: string;
  userId: string;
  agentUserId?: string | null;
  gate: boolean;
}): Promise<AdvanceTrackStageResult> {
  const { track, project, toStage, userId } = params;
  const fromStage = track.currentStage ?? null;
  if (fromStage === toStage) {
    return {
      status: "unchanged",
      track,
      gated: false,
      paused: false,
      offer: null,
    };
  }

  // Compare-and-set: the stage moves ONLY from the stage this advance was
  // decided on. Two concurrent advances cannot both land; the loser is told.
  // The SAME statement appends the stage-history entry (0274).
  const updated = await (
    await repo()
  ).advanceStage(
    track.id,
    fromStage,
    toStage,
    userId,
    params.agentUserId ?? userId
  );
  if (!updated) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `Goal "${track.name}" moved stage while this was being decided — reload it and try again.`,
    });
  }

  void emitSideEffects({
    subjectType: "track",
    action: "stage_changed",
    subjectId: track.id,
    userId,
    workspaceId: project.workspaceId,
    data: {
      trackId: track.id,
      projectId: project.id,
      playbookId: track.playbookId,
      fromStage,
      toStage,
      workspaceId: project.workspaceId,
      userId,
    },
  }).catch((err) =>
    logger.warn(
      { err, trackId: track.id, toStage },
      "track.stage_changed emit failed"
    )
  );

  const outcome: StageGateOutcome = params.gate
    ? await applyStageGate(
        trackGateSubject({
          trackId: track.id,
          userId,
          projectId: project.id,
          workspaceId: project.workspaceId,
          playbookId: track.playbookId,
          snapshotStages: track.definitionSnapshot?.stages,
        }),
        {
          userId,
          agentUserId: params.agentUserId ?? null,
          toStage,
          fromStage,
        }
      )
    : null;

  // A CHECK verdict is stamped on the history entry this move appended, so
  // the track's timeline says whether the step left was met (U5 history) —
  // a pass left no trace anywhere before. After the move, never able to undo
  // it: a failed stamp is logged, and the advance stands.
  let stamped = false;
  if (outcome?.kind === "check") {
    const entered = readTrackStageHistory(updated.stageHistory).at(-1);
    if (entered) {
      try {
        stamped =
          (await (
            await repo()
          ).stampStageCheck(
            track.id,
            entered.enteredAt,
            {
              passed: outcome.passed,
              failing: outcome.failing,
              ...(outcome.reason ? { reason: outcome.reason } : {}),
            },
            userId
          )) !== null;
      } catch (err) {
        logger.warn(
          { err, trackId: track.id, toStage },
          "check verdict not stamped on the track's stage history"
        );
      }
    }
  }

  // The RETURNED row is the post-gate state: when the gate paused the track
  // (or its verdict was stamped), re-read it, so `paused: true` never travels
  // beside `status: "active"`.
  let after = updated;
  if (outcome?.paused || stamped) {
    const db = await getDb();
    const [row] = await db
      .select()
      .from(projectTracks)
      .where(eq(projectTracks.id, track.id))
      .limit(1);
    if (row) after = row as ProjectTrack;
  }
  const offer = await stageSessionOffer(after, toStage, userId);
  const base = { status: "advanced" as const, track: after, offer };
  if (!outcome) return { ...base, gated: false, paused: false };
  if (outcome.kind === "check") {
    return {
      ...base,
      gated: true,
      paused: outcome.paused,
      check: {
        passed: outcome.passed,
        failing: outcome.failing,
        ...(outcome.reason ? { reason: outcome.reason } : {}),
      },
    };
  }
  return {
    ...base,
    gated: true,
    paused: outcome.paused,
    proposalId: outcome.proposalId,
    proposalType: outcome.proposalType,
  };
}

// ── sessions filed inside a track ───────────────────────────────────────────

/** The caller's newest OPEN session filed at this stage of this track, if any. */
/**
 * The caller's OPEN session filed at (track, stage) — the idempotency probe of
 * `startStageSession`, re-run by `createFocusSession({ oneOpenPerStage })`
 * under its advisory lock (hence `database`: the locking transaction).
 */
export async function openStageSession(
  trackId: string,
  stageKey: string,
  userId: string,
  database?: Awaited<ReturnType<typeof getDb>>
) {
  const db = database ?? (await getDb());
  // SESSION-KIND-LENS-EXEMPT: an idempotency probe for ONE (track, stage), not a list door.
  const [row] = await db
    .select()
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.trackId, trackId),
        eq(focusSessions.trackStage, stageKey),
        eq(focusSessions.userId, userId),
        inArray(focusSessions.status, [...OPEN_SESSION_STATUSES])
      )
    )
    .orderBy(desc(focusSessions.startedAt))
    .limit(1);
  return row ?? null;
}

/**
 * The offer for a stage just entered (M2) — derived purely from the PINNED
 * stage, `null` when the caller already has an open session filed there
 * (nothing to offer) or the stage is not declared.
 */
async function stageSessionOffer(
  track: ProjectTrack,
  stageKey: string,
  userId: string
): Promise<StageSessionOffer | null> {
  const stage = readTrackStage(track.definitionSnapshot?.stages, stageKey);
  if (!stage) return null;
  if (await openStageSession(track.id, stageKey, userId)) return null;
  return {
    stageKey: stage.key,
    name: stage.name,
    goal: stage.goal ?? null,
    suggestedTasks: stage.suggestedTasks ?? [],
  };
}

export interface TrackFiling {
  trackId: string;
  projectId: string;
  /**
   * The stage the session is FILED at (M1): the caller's explicit stage when
   * given (validated against the pinned stages), else the track's current
   * stage; `null` for a stageless method.
   */
  trackStage: string | null;
  trackName: string;
  /** The method's DECLARED params, as pinned — what `params` answers. */
  methodParams: unknown;
}

/**
 * Validate a session/run being filed into a track. Returns the project the
 * session must carry: the TRACK's project. A `projectId` that disagrees is a
 * refusal, never a silent correction; a closed or dropped track takes no new
 * work.
 * An explicit `trackStage` naming a stage the method does not declare is a
 * refusal too.
 */
export async function resolveTrackFiling(params: {
  trackId: string;
  projectId?: string | null;
  /** An explicit stage to file at. Absent/null ⇒ the track's current stage. */
  trackStage?: string | null;
  actor: TrackActor;
}): Promise<TrackFiling> {
  const track = await getTrack(params.trackId, params.actor);
  if (!track) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Goal not found" });
  }
  if (params.projectId && params.projectId !== track.projectId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Goal "${track.name}" belongs to another project — pass that project, or omit projectId.`,
    });
  }
  // A closed or dropped goal takes no new work (both are final — reopen it as
  // a new version). A goal still being SHAPED (proposed · agreed · ready)
  // does: agreeing its criteria and clearing its prerequisites is work, and a
  // session filed there is how it gets done. Its agent is not admitted to the
  // project's spaces until it is active (`track-space-grant.ts`).
  if (isTrackClosed(track)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Goal "${track.name}" is ${resolveTrackStatusLabel(track.status).toLowerCase()} and takes no new work — reopen it as a new version.`,
    });
  }
  return {
    trackId: track.id,
    projectId: track.projectId,
    trackStage: resolveFilingStage(track, params.trackStage),
    trackName: track.name,
    methodParams: track.definitionSnapshot?.params,
  };
}

/**
 * THE stage rule for filing (M1), shared by the direct doors and the
 * `focus_session/create` approval replay: an explicit stage must be one the
 * track PINNED; absent ⇒ the track's current stage.
 */
export function resolveFilingStage(
  track: Pick<ProjectTrack, "name" | "currentStage" | "definitionSnapshot">,
  explicit: string | null | undefined
): string | null {
  if (explicit === undefined || explicit === null || explicit === "") {
    return track.currentStage ?? null;
  }
  const keys = stageKeys(track.definitionSnapshot?.stages);
  if (!keys.includes(explicit)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        keys.length === 0
          ? `Goal "${track.name}" follows a method with no stages — omit trackStage.`
          : `"${explicit}" is not a stage of "${track.name}". Stages: ${keys.join(", ")}.`,
    });
  }
  return explicit;
}

// ── params ──────────────────────────────────────────────────────────────────

export type SetTrackParamsResult =
  { status: "updated" | "unchanged"; track: ProjectTrack } | ProposedOutcome;

/**
 * Answer (some of) the method's params — MERGED onto the track's current
 * answers; a `null` value clears that answer. Governed `track/update` (the
 * existing key; its executor replays through {@link applyTrackParams}).
 */
export async function setTrackParams(input: {
  trackId: string;
  params: Record<string, unknown>;
  actor: TrackActor;
}): Promise<SetTrackParamsResult> {
  const { track, project } = await loadTrackForWrite(
    input.trackId,
    input.actor
  );
  const next = mergeTrackParams(track, input.params);
  if (JSON.stringify(next) === JSON.stringify(track.params ?? {})) {
    return { status: "unchanged", track };
  }

  const perm = await checkPermissionOrPropose({
    userId: input.actor.userId,
    agentUserId: input.actor.agentUserId ?? undefined,
    sessionId: input.actor.sessionId ?? undefined,
    workspaceId: project.workspaceId ?? undefined,
    projectId: project.id,
    subjectType: "track",
    action: "update",
    source: input.actor.source,
    reasoning: input.actor.reasoning,
    // The PATCH, not the merged result: the replay merges onto the answers as
    // they stand at approval, so an answer given in between is not reverted.
    data: { id: track.id, name: track.name, params: input.params },
  });
  if ("denied" in perm && perm.denied) {
    throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
  }
  if ("proposalId" in perm) {
    return proposed(
      perm,
      buildObjectActionTitle({
        action: "update",
        objectKind: "track",
        objectName: track.name,
      }) + " — proposed for review"
    );
  }
  return applyTrackParams(track, input.params, input.actor.userId);
}

function mergeTrackParams(
  track: Pick<ProjectTrack, "params" | "definitionSnapshot">,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    ...((track.params as Record<string, unknown> | null) ?? {}),
  };
  const answers: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete merged[k];
    else answers[k] = v;
  }
  return {
    ...merged,
    ...resolveTrackParams(track.definitionSnapshot?.params, answers),
  };
}

/** The params write. Callers: `setTrackParams` and the `track/update` replay. */
export async function applyTrackParams(
  track: ProjectTrack,
  patch: Record<string, unknown>,
  userId: string
): Promise<{ status: "updated"; track: ProjectTrack }> {
  // Validated + coerced against the PINNED declaration; the write itself is a
  // SQL merge of exactly these keys (`patchParams`), never the whole bag.
  const clear = Object.keys(patch).filter((k) => patch[k] === null);
  const answers = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== null)
  );
  const set = resolveTrackParams(track.definitionSnapshot?.params, answers);
  const updated = await (
    await repo()
  ).patchParams(track.id, { set, clear }, userId);
  if (!updated) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Goal not found" });
  }
  return { status: "updated", track: updated };
}

// ── direction + KPI (0302) ──────────────────────────────────────────────────

/**
 * A KPI as a caller may write it. `updatedAt` / `updatedBy` are SERVER-STAMPED
 * whenever `current` is written — a caller cannot backdate a statement or
 * attribute it to someone else — so they are not accepted here.
 */
export const trackKpiInputSchema = z
  .object({
    label: z.string().trim().min(1).max(TRACK_KPI_LABEL_MAX).optional(),
    unit: z.string().trim().max(TRACK_KPI_UNIT_MAX).optional(),
    target: z.number().finite().optional(),
    current: z.number().finite().optional(),
  })
  .strict();
export type TrackKpiInput = z.infer<typeof trackKpiInputSchema>;

/** Parse a KPI patch, refusing it in words an agent can act on. */
export function parseTrackKpiInput(raw: unknown): TrackKpiInput {
  const parsed = trackKpiInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Invalid kpi: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "kpi"} ${i.message}`)
        .join(
          "; "
        )}. A KPI is { label, unit?, target, current? } — numbers for target and current.`,
    });
  }
  return parsed.data;
}

/** A direction line: trimmed and bounded; `null`/blank clears it. */
export function resolveTrackDirection(
  raw: string | null | undefined
): string | null {
  const direction = readTrackDirection(raw);
  if (direction && direction.length > TRACK_DIRECTION_MAX) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `A goal's direction is one line — at most ${TRACK_DIRECTION_MAX} characters.`,
    });
  }
  return direction;
}

/**
 * The KPI a patch leaves on the track: the stored one with the patch's keys
 * on top. Refused unless the result is a WHOLE KPI (a label and a target) —
 * stating a value for a KPI nobody defined is not a KPI. Writing `current`
 * stamps when and by whom it was stated.
 */
export function resolveTrackKpi(
  stored: unknown,
  patch: TrackKpiInput,
  statedBy: string,
  now: Date = new Date()
): ProjectTrackKpi {
  const merged = readTrackKpi({
    ...(readTrackKpi(stored) ?? {}),
    ...patch,
    ...(patch.current !== undefined
      ? { updatedAt: now.toISOString(), updatedBy: statedBy }
      : {}),
  });
  if (!merged) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "A KPI needs a label and a target number — give both (then state its current value).",
    });
  }
  return merged;
}

export type SetTrackDirectionResult =
  { status: "updated" | "unchanged"; track: ProjectTrack } | ProposedOutcome;

/**
 * Say where the track is heading (`direction`) and/or the number it steers by
 * (`kpi` — a PATCH merged onto the stored KPI; `null` clears it). Stating a
 * new `current` is the common write. Governed `track/update`; the replay is
 * {@link applyTrackDirection}. Completion is NEVER automatic: reaching the
 * target nudges the person (`track.kpi_reached`).
 */
export async function setTrackDirection(input: {
  trackId: string;
  direction?: string | null;
  /** A KPI patch (`{ label?, unit?, target?, current? }`) or `null` to clear. */
  kpi?: unknown;
  /**
   * What the goal holds (0345) — each field WHOLE (`null` clears):
   * `endState`, `criteria` (none, or 2–5), `dropConditions`, `workKind`,
   * `uncertainty`, and `confirmKind` (a person confirming the AI's kind).
   */
  endState?: unknown;
  criteria?: unknown;
  dropConditions?: unknown;
  workKind?: unknown;
  uncertainty?: unknown;
  confirmKind?: unknown;
  /** The goal's loop (0350, W4): `{ on, perWeek? }` or `null` (off). */
  loop?: unknown;
  actor: TrackActor;
}): Promise<SetTrackDirectionResult> {
  const { track, project } = await loadTrackForWrite(
    input.trackId,
    input.actor
  );
  const goalRaw = pickTrackGoalInput(
    input as unknown as Record<string, unknown>
  );
  if (
    input.direction === undefined &&
    input.kpi === undefined &&
    Object.keys(goalRaw).length === 0
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Nothing to change — pass a direction, a kpi, or what the goal holds (endState, criteria, dropConditions, workKind, uncertainty, loop).",
    });
  }
  const patch = normalizeDirectionPatch(input);
  // Refused BEFORE governance: a malformed KPI or goal (the 2–5 rule, a
  // meaning its check cannot carry, an agent confirming a kind) is told to
  // its author, never filed for a person to approve.
  const next = previewDirection(track, patch, input.actor.userId);
  const goalInput = parseTrackGoalInput(goalRaw);
  const goalPatch = resolveTrackGoalPatch(
    track,
    goalInput,
    input.actor.agentUserId ? null : input.actor.userId
  );
  if (
    next.direction === readTrackDirection(track.direction) &&
    sameKpiValue(next.kpi, readTrackKpi(track.kpi)) &&
    goalPatch === null
  ) {
    return { status: "unchanged", track };
  }

  const perm = await checkPermissionOrPropose({
    userId: input.actor.userId,
    agentUserId: input.actor.agentUserId ?? undefined,
    sessionId: input.actor.sessionId ?? undefined,
    workspaceId: project.workspaceId ?? undefined,
    projectId: project.id,
    subjectType: "track",
    action: "update",
    source: input.actor.source,
    reasoning: input.actor.reasoning,
    // An agent switching the loop on is always reviewed (W4).
    ...(agentSwitchesLoopOn(goalInput, input.actor.agentUserId)
      ? { forcePropose: true }
      : {}),
    // The PATCH, never the merged result: the replay merges onto the KPI as it
    // stands at approval, so a value stated in between is not reverted.
    data: {
      id: track.id,
      name: track.name,
      ...(patch.direction !== undefined ? { direction: patch.direction } : {}),
      ...(patch.kpi !== undefined ? { kpi: patch.kpi } : {}),
      // The goal fields as the caller wrote them (parsed) — the replay
      // resolves them against the goal as it stands at approval. `criteria`
      // here is what floors an agent's criteria change to a proposal.
      ...pickTrackGoalInput(goalInput),
    },
  });
  if ("denied" in perm && perm.denied) {
    throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
  }
  if ("proposalId" in perm) {
    return proposed(
      perm,
      buildObjectActionTitle({
        action: "update",
        objectKind: "track",
        objectName: track.name,
      }) + " — proposed for review"
    );
  }
  return applyTrackDirection(
    track,
    project,
    { ...patch, ...pickTrackGoalInput(goalInput) },
    {
      userId: input.actor.userId,
      statedBy: input.actor.agentUserId ?? input.actor.userId,
      confirmedBy: input.actor.agentUserId ? null : input.actor.userId,
    }
  );
}

interface DirectionPatch {
  direction?: string | null;
  kpi?: TrackKpiInput | null;
}

/** A patch as it arrives (a door, or a proposal's stored payload). */
interface RawDirectionPatch {
  direction?: string | null;
  kpi?: unknown;
  /** What the goal holds — parsed and resolved at the write (0345). */
  endState?: unknown;
  criteria?: unknown;
  dropConditions?: unknown;
  workKind?: unknown;
  uncertainty?: unknown;
  confirmKind?: unknown;
  /** The goal's loop (0350, W4): `{ on, perWeek? }` or `null` (off). */
  loop?: unknown;
}

function normalizeDirectionPatch(input: RawDirectionPatch): DirectionPatch {
  return {
    ...(input.direction !== undefined
      ? { direction: resolveTrackDirection(input.direction) }
      : {}),
    ...(input.kpi !== undefined
      ? { kpi: input.kpi === null ? null : parseTrackKpiInput(input.kpi) }
      : {}),
  };
}

function previewDirection(
  track: Pick<ProjectTrack, "direction" | "kpi">,
  patch: DirectionPatch,
  statedBy: string
): { direction: string | null; kpi: ProjectTrackKpi | null } {
  return {
    direction:
      patch.direction !== undefined
        ? patch.direction
        : readTrackDirection(track.direction),
    kpi:
      patch.kpi === undefined
        ? readTrackKpi(track.kpi)
        : patch.kpi === null
          ? null
          : resolveTrackKpi(track.kpi, patch.kpi, statedBy),
  };
}

/** Equal KPIs, ignoring the statement stamps (a re-statement is a change). */
function sameKpiValue(
  a: ProjectTrackKpi | null,
  b: ProjectTrackKpi | null
): boolean {
  if (!a || !b) return a === b;
  return (
    a.label === b.label &&
    (a.unit ?? null) === (b.unit ?? null) &&
    a.target === b.target &&
    (a.current ?? null) === (b.current ?? null)
  );
}

/**
 * The direction/KPI write. Callers: `setTrackDirection` and the
 * `track/update` replay (which passes the PROPOSING agent as `statedBy`).
 * Re-validates against the KPI as it stands NOW, writes only the patch's keys
 * (`patchDirection`, merged in SQL), and nudges on the target crossing.
 */
export async function applyTrackDirection(
  track: ProjectTrack,
  project: GateProject,
  rawPatch: RawDirectionPatch,
  who: {
    userId: string;
    statedBy: string;
    /**
     * The PERSON whose write this is — a kind of work or uncertainty they
     * write (or approve) is confirmed by them. `null`: an agent's write
     * applied without review, which leaves (or makes) the kind unconfirmed.
     * Absent ⇒ `null`: a write never confirms by omission.
     */
    confirmedBy?: string | null;
  }
): Promise<{ status: "updated"; track: ProjectTrack }> {
  const patch = normalizeDirectionPatch(rawPatch);
  // Re-parsed and resolved against the goal as it stands NOW (a replay's
  // goal may have moved since the proposal was filed).
  const goal = resolveTrackGoalPatch(
    track,
    parseTrackGoalInput(
      pickTrackGoalInput(rawPatch as unknown as Record<string, unknown>)
    ),
    who.confirmedBy ?? null
  );
  const before = readTrackKpi(track.kpi);
  const kpi =
    patch.kpi === undefined
      ? undefined
      : patch.kpi === null
        ? null
        : // Validated whole, written as a patch: the stamps ride with it.
          kpiWritePatch(
            track.kpi,
            resolveTrackKpi(track.kpi, patch.kpi, who.statedBy),
            patch.kpi
          );
  const updated = await (
    await repo()
  ).patchDirection(
    track.id,
    {
      ...(patch.direction !== undefined ? { direction: patch.direction } : {}),
      ...(kpi !== undefined ? { kpi } : {}),
      ...(goal ? { goal } : {}),
      // The acceptances were merged onto the criteria AS READ: the write
      // lands only while they still are (code.md — an edit never drops a
      // decision the judge made a moment ago).
      ...(goal?.criteria !== undefined
        ? { expectedCriteria: track.criteria ?? null }
        : {}),
    },
    who.userId
  );
  if (!updated) {
    const db = await getDb();
    const [still] = await db
      .select({ id: projectTracks.id })
      .from(projectTracks)
      .where(eq(projectTracks.id, track.id))
      .limit(1);
    if (goal?.criteria !== undefined && still) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `The criteria of "${track.name}" changed while you edited them (a decision was recorded) — read the goal again and redo the edit.`,
      });
    }
    throw new TRPCError({ code: "NOT_FOUND", message: "Goal not found" });
  }
  const after = readTrackKpi(updated.kpi);
  if (trackKpiJustReached(before, after)) {
    await notifyTrackKpiReached(updated, project, after!);
  }
  if (goal?.loop && readGoalLoop(goal.loop).on) {
    // Switched on (or on again): the loop looks now, through its one seam —
    // the `track.update` reactor (`goal-loop-reactor.ts`) — not a call here.
    void emitSideEffects({
      subjectType: "track",
      action: "update",
      subjectId: updated.id,
      userId: who.userId,
      workspaceId: project.workspaceId,
      data: { trackId: updated.id, projectId: project.id, loop: "on" },
    }).catch((err) =>
      logger.warn({ err, trackId: updated.id }, "track.update emit failed")
    );
  }
  return { status: "updated", track: updated };
}

/**
 * What `patchDirection` merges in SQL: only the keys the patch named (+ the
 * statement stamps when it named `current`), so a concurrent write to another
 * key is not reverted. A track with no usable KPI yet gets the WHOLE merged
 * one — `resolveTrackKpi` has proven it complete, and there is nothing to
 * merge onto.
 */
function kpiWritePatch(
  stored: unknown,
  merged: ProjectTrackKpi,
  patch: TrackKpiInput
): Partial<ProjectTrackKpi> {
  if (!readTrackKpi(stored)) return merged;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(patch) as Array<keyof TrackKpiInput>) {
    if (patch[k] !== undefined) out[k] = merged[k];
  }
  if (patch.current !== undefined) {
    out.updatedAt = merged.updatedAt;
    out.updatedBy = merged.updatedBy;
  }
  return out as Partial<ProjectTrackKpi>;
}

/**
 * The nudge: the KPI just reached its target, so the person may want to
 * re-aim it (a new target) or close the goal with a verdict. A goal can stay
 * open as long as it matters, or finish: a person closes it with a verdict
 * once its criteria are met — a number reached never closes it. Never changes
 * the track. Through the ONE notification door
 * (`NotificationService.create`), to the person the track belongs to (its
 * starter — for an agent key, its operator). Non-fatal: a failed nudge never
 * fails the write it follows.
 */
async function notifyTrackKpiReached(
  track: ProjectTrack,
  project: GateProject,
  kpi: TrackKpi
): Promise<void> {
  try {
    const { NotificationService } =
      await import("../../notifications/NotificationService.js");
    await NotificationService.create({
      type: "track.kpi_reached",
      userId: track.userId,
      workspaceId: project.workspaceId,
      sourceType: "track",
      sourceId: track.id,
      groupKey: `track:${track.id}:kpi`,
      data: {
        trackId: track.id,
        trackName: track.name,
        kpiLabel: kpi.label,
        current: kpi.current,
        target: kpi.target,
        unit: kpi.unit ?? "",
        // THE KPI fraction (the track header's spelling, no dangling space
        // for a unitless KPI) — what the body template prints.
        kpiValue: formatKpiFraction(kpi.current ?? 0, kpi.target, kpi.unit),
      },
    });
  } catch (err) {
    logger.warn({ err, trackId: track.id }, "track.kpi_reached nudge failed");
  }
}

// ── acceptance of a goal criterion (R2) ─────────────────────────────────────

export type AcceptGoalCriterionResult = {
  status: "updated" | "unchanged";
  track: ProjectTrack;
};

/**
 * THE acceptance door (R2): the goal's JUDGE accepts a claimed criterion,
 * sends it back (`changes_asked`, with what to change) or rejects it — the
 * one writer of a criterion's `acceptance`. An agent never may (R9), a person
 * only as the goal's judge (`isGoalJudge` — the judge seat, else the owner:
 * the same person who alone may close it). Not a governed write: the
 * judge's decision IS the review; nothing is proposed to anyone. Repeating
 * the same decision is `unchanged`.
 */
export async function acceptGoalCriterion(input: {
  trackId: string;
  criterionKey: string;
  decision: GoalAcceptanceDecision;
  note?: string | null;
  actor: TrackActor;
}): Promise<AcceptGoalCriterionResult> {
  const track = await getTrack(input.trackId, input.actor);
  if (!track) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Goal not found" });
  }
  const criterion = readGoalCriteria(track.criteria).find(
    (c) => c.key === input.criterionKey
  );
  if (!criterion) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `This goal has no criterion "${input.criterionKey}".`,
    });
  }
  const refusal = mayAcceptGoalCriterion(
    criterion,
    input.actor.agentUserId
      ? { kind: "agent" }
      : {
          kind: "person",
          isJudge: await isGoalJudge(track, input.actor.userId),
        }
  );
  if (refusal) throw new TRPCError({ code: "FORBIDDEN", message: refusal });
  if (isTrackClosed(track)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Goal "${track.name}" is ${resolveTrackStatusLabel(track.status).toLowerCase()} — its criteria were judged when it closed.`,
    });
  }
  const note = input.note?.trim() || null;
  if (
    criterion.acceptance?.decision === input.decision &&
    (criterion.acceptance.note ?? null) === note
  ) {
    return { status: "unchanged", track };
  }
  // What the judge may record depends on where the criterion stands NOW —
  // derived by the read every goal view uses (F14): accepting needs a claim,
  // or, for an outside party's decision, a note naming its source (stored on
  // the acceptance).
  const view = (await loadTrackGoalFacts([track], input.actor.userId))
    .get(track.id)
    ?.criteria.find((c) => c.key === criterion.key);
  if (!view) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `The criterion "${criterion.key}" could not be read — try again.`,
    });
  }
  const stand = goalAcceptanceRefusal({
    decision: input.decision,
    mark: view.mark,
    meaning: view.meaning,
    note,
  });
  if (stand) throw new TRPCError({ code: "BAD_REQUEST", message: stand });
  const updated = await (
    await repo()
  ).setCriterionAcceptance(
    track.id,
    criterion.key,
    {
      decision: input.decision,
      by: input.actor.userId,
      at: new Date().toISOString(),
      ...(note ? { note } : {}),
    },
    input.actor.userId
  );
  if (!updated) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `The criterion "${criterion.key}" was removed while you decided — read the goal again.`,
    });
  }
  // The judge decided: that claim's item leaves their Needs you; "ready for
  // your verdict" stays while another claim still waits (F1).
  await refreshGoalJudgements(track.id);
  return { status: "updated", track: updated };
}

// ── emergent stages (0302) ──────────────────────────────────────────────────

/** What a caller may say about a stage it adds to a running track. */
export const addTrackStageInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    goal: z.string().trim().min(1).max(5000).optional(),
    key: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9_-]*$/, {
        message: "a stage key is lowercase letters, digits, - or _",
      })
      .optional(),
  })
  .strict();
export type AddTrackStageInput = z.infer<typeof addTrackStageInputSchema>;

export type AddTrackStageResult =
  { status: "added"; track: ProjectTrack; stageKey: string } | ProposedOutcome;

/**
 * Append an EMERGENT stage to a running track — work the method did not
 * foresee. Governed `track/update`; the replay is {@link applyTrackStageAdd}.
 *
 * WHAT AN EMERGENT STAGE CARRIES — decided (founder decision 2, 2026-10-05:
 * outcomes live INSIDE the session): a `name`, an optional `goal` (the brief
 * of the session started there) and its `addedAt` / `addedBy` provenance.
 * NOT outcomes and NOT a gate: what a stage must yield is declared on the
 * session worked there (`outcomes[]` on `start_session` / `update_session`),
 * and the check gate measures exactly those. A stage that pins its own
 * outputs is a METHOD change — edit the method and start it again.
 *
 * The stage is APPENDED (last). Adding never enters it: `advanceTrackStage`
 * does, and finds it declared — the "declared stages only" rule holds, and
 * `stage_history` records the entry like any other.
 */
export async function addTrackStage(input: {
  trackId: string;
  stage: AddTrackStageInput;
  actor: TrackActor;
}): Promise<AddTrackStageResult> {
  const { track, project } = await loadTrackForWrite(
    input.trackId,
    input.actor
  );
  const stage = parseAddTrackStage(input.stage);
  // Refused BEFORE governance (closed track, taken key).
  const key = resolveEmergentStageKey(track, stage);

  const perm = await checkPermissionOrPropose({
    userId: input.actor.userId,
    agentUserId: input.actor.agentUserId ?? undefined,
    sessionId: input.actor.sessionId ?? undefined,
    workspaceId: project.workspaceId ?? undefined,
    projectId: project.id,
    subjectType: "track",
    action: "update",
    source: input.actor.source,
    reasoning: input.actor.reasoning,
    data: {
      id: track.id,
      name: track.name,
      addStage: { ...stage, key },
    },
  });
  if ("denied" in perm && perm.denied) {
    throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
  }
  if ("proposalId" in perm) {
    return proposed(
      perm,
      buildObjectActionTitle({
        action: "update",
        objectKind: "track",
        objectName: track.name,
      }) + " — proposed for review"
    );
  }
  return applyTrackStageAdd(
    track,
    { ...stage, key },
    {
      userId: input.actor.userId,
      addedBy: input.actor.agentUserId ?? input.actor.userId,
    }
  );
}

export function parseAddTrackStage(raw: unknown): AddTrackStageInput {
  const parsed = addTrackStageInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Invalid stage: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "stage"} ${i.message}`)
        .join("; ")}. A stage is { name, goal?, key? }.`,
    });
  }
  return parsed.data;
}

/**
 * The key the stage will be declared under: the caller's, refused when
 * taken; else derived from its name (the shared label→key slug), suffixed
 * `-2`, `-3`… past the keys the track already declares.
 */
function resolveEmergentStageKey(
  track: ProjectTrack,
  stage: AddTrackStageInput
): string {
  if (isTrackClosed(track)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `"${track.name}" is ${resolveTrackStatusLabel(track.status).toLowerCase()} — reopen it as a new version to add a step.`,
    });
  }
  const taken = new Set(stageKeys(track.definitionSnapshot?.stages));
  if (stage.key) {
    if (taken.has(stage.key)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `A step with that key already exists in "${track.name}".`,
      });
    }
    return stage.key;
  }
  const base = slotKeyBase(stage.name);
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}-${n}`;
  return key;
}

/**
 * The append. Callers: `addTrackStage` and the `track/update` replay (which
 * passes the PROPOSING agent as `addedBy`). Compare-and-set on the stage list
 * as read here: a concurrent add — or the same key landing first — is a
 * CONFLICT, never a silent duplicate.
 */
export async function applyTrackStageAdd(
  track: ProjectTrack,
  stage: AddTrackStageInput & { key: string },
  who: { userId: string; addedBy: string }
): Promise<{ status: "added"; track: ProjectTrack; stageKey: string }> {
  const key = resolveEmergentStageKey(track, stage);
  const current = track.definitionSnapshot?.stages;
  const updated = await (
    await repo()
  ).appendStage(
    track.id,
    {
      key,
      name: stage.name,
      category: DEFAULT_PLAYBOOK_STAGE_CATEGORY,
      ...(stage.goal ? { goal: stage.goal } : {}),
      addedAt: new Date().toISOString(),
      addedBy: who.addedBy,
    },
    Array.isArray(current) ? current.length : 0,
    who.userId
  );
  if (!updated) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `Goal "${track.name}"'s stages changed while this was being decided — reload it and try again.`,
    });
  }
  return { status: "added", track: updated, stageKey: key };
}

// ── the stage session (M2) ──────────────────────────────────────────────────

/**
 * Where a stage that names a DOMAIN was worked (W2a). Present only when the
 * pinned stage declares `domain` — absent means "no domain asked for".
 */
export type StageSessionDomainOutcome =
  | {
      /** The session was placed in (or found in) a workspace of that template. */
      domain: {
        wanted: string;
        workspaceId: string;
        /**
         * `project --uses--> workspace` was stamped. `false` only on a
         * PROPOSED session — nothing exists yet to have used the domain; the
         * stamp lands when this door next returns the approved session.
         */
        usesStamped: boolean;
      };
      domainFallback?: never;
    }
  | {
      /**
       * NO workspace of that template could take the session: it was placed
       * in the project's HOME workspace instead. Never silent — `reason` says
       * what would fix it.
       */
      domainFallback: { wanted: string; reason: StageDomainFallbackReason };
      domain?: never;
    }
  | { domain?: never; domainFallback?: never };

export type StartStageSessionResult = (
  | {
      /**
       * `created` — a new session; `existing` — the caller already had an open
       * session filed at this stage, returned untouched; `deduped` — an open
       * twin (same goal, track and stage) was returned by the session door.
       */
      status: "created" | "existing" | "deduped";
      /** `null` ⇒ a stage-less track: the session is filed at no stage. */
      stageKey: string | null;
      session: typeof focusSessions.$inferSelect;
    }
  | (Omit<ProposedOutcome, "reviewUrl"> & {
      stageKey: string | null;
      /** Present only when the governance door returned one — never invented. */
      reviewUrl?: string;
    })
) &
  StageSessionDomainOutcome;

/**
 * Work in a STAGE-LESS track (W1): a session filed into the track, through
 * the session door (`createFocusSession` — the same governance, dedup and
 * project ladder `start_session` + `trackId` uses), in the project's home.
 * The brief is the caller's goal, else the track's direction, else its name.
 */
async function startTrackSession(
  track: ProjectTrack,
  input: { title?: string | null; goal?: string | null; actor: TrackActor }
): Promise<StartStageSessionResult> {
  const { actor } = input;
  const db = await getDb();
  const project = await loadVisibleProject(db, track.projectId, actor.userId);
  if (!project) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Goal not found" });
  }
  // Dynamic: `create-session.ts` imports this module (resolveTrackFiling).
  const { createFocusSession } =
    await import("../focus-sessions/create-session.js");
  const result = await createFocusSession({
    userId: actor.userId,
    agentUserId: actor.agentUserId ?? undefined,
    workspaceId: project.workspaceId ?? null,
    projectId: track.projectId,
    trackId: track.id,
    title: input.title?.trim() || null,
    goal: input.goal?.trim() || track.direction?.trim() || track.name,
    templateId: null,
    clientKey: requestClientKey(actor.agentUserId ?? undefined) ?? null,
    adoptAutoOpened: false,
  });
  if (result.status === "proposed") {
    return {
      status: "proposed",
      stageKey: null,
      proposalId: result.proposalId,
      proposalType: result.proposalType ?? "focus_session.create",
      message: result.message,
      ...(result.reviewUrl ? { reviewUrl: result.reviewUrl } : {}),
    };
  }
  return {
    status: result.status === "deduped" ? "deduped" : "created",
    stageKey: null,
    session: result.session,
  };
}

/**
 * THE ONE DOOR that starts a stage's session (M2). Entering a stage only
 * OFFERS this; nothing auto-starts.
 *
 * A thin wrapper over `createFocusSession` — the SAME governance (an agent
 * PROPOSES a `focus_session/create`; no new proposal key), the same dedup and
 * the same project ladder. What it adds is only what the stage declares:
 *   - goal: the caller's, else the stage's goal (the brief), else the
 *     method's goalTemplate, else the stage name;
 *   - expected outputs + criteria: the stage's, as pinned;
 *   - params: the TRACK's answers, so a REQUIRED method param still missing
 *     becomes a human-owned slot on this session (stage 1 = onboarding);
 *   - trackId + trackStage.
 * IDEMPOTENT: the caller's open session already filed at that stage is
 * returned (`existing`) and nothing is filed or written.
 */
export async function startStageSession(input: {
  trackId: string;
  /** Absent ⇒ the track's current stage. */
  stageKey?: string | null;
  title?: string | null;
  goal?: string | null;
  actor: TrackActor;
}): Promise<StartStageSessionResult> {
  const { actor } = input;
  const track = await getTrack(input.trackId, actor);
  if (!track) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Goal not found" });
  }
  if (isTrackClosed(track)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Goal "${track.name}" is ${resolveTrackStatusLabel(track.status).toLowerCase()} — reopen it as a new version before starting work in it.`,
    });
  }
  const stageKey = resolveFilingStage(track, input.stageKey);
  if (!stageKey) {
    // A STAGE-LESS track (W1) is a goal: its work is a session
    // filed into it — `start_session` + `trackId`. This door ALIASES that
    // during the transition, never refuses it.
    if (stageKeys(track.definitionSnapshot?.stages).length === 0) {
      return startTrackSession(track, input);
    }
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Goal "${track.name}" stands on no stage — pass stageKey.`,
    });
  }
  const stage = readTrackStage(track.definitionSnapshot?.stages, stageKey);

  const db = await getDb();
  const open = await openStageSession(track.id, stageKey, actor.userId);
  if (open) {
    // A session approved AFTER a proposal comes back here: it now exists in
    // the domain's workspace, so the `uses` stamp the proposal could not make
    // lands now. Only when the session really sits in that template's
    // workspace — never re-derived from the stage alone.
    if (
      stage?.domain &&
      open.workspaceId &&
      (await workspacePackageSlug(db, open.workspaceId)) === stage.domain
    ) {
      const uses = await linkProjectToWorkspace(db, {
        projectId: track.projectId,
        workspaceId: open.workspaceId,
        userId: actor.userId,
      });
      return {
        status: "existing",
        stageKey,
        session: open,
        domain: {
          wanted: stage.domain,
          workspaceId: open.workspaceId,
          usesStamped: uses.linked,
        },
      };
    }
    return { status: "existing", stageKey, session: open };
  }

  const project = await loadVisibleProject(db, track.projectId, actor.userId);
  if (!project) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Goal not found" });
  }

  // PER-STEP DOMAIN (W2a): the stage names a workspace TEMPLATE; work it in a
  // live workspace of that template the caller can write to (one the project
  // already uses wins). None ⇒ the project's home, REPORTED, never silent.
  let sessionWorkspaceId: string | null = project.workspaceId ?? null;
  let domainWorkspaceId: string | null = null;
  let domainFallback:
    { wanted: string; reason: StageDomainFallbackReason } | undefined;
  if (stage?.domain) {
    const resolved = await resolveStageDomainWorkspace(db, {
      slug: stage.domain,
      projectId: project.id,
      userId: actor.userId,
    });
    if (resolved.resolved) {
      sessionWorkspaceId = resolved.workspaceId;
      domainWorkspaceId = resolved.workspaceId;
    } else {
      domainFallback = { wanted: resolved.slug, reason: resolved.reason };
    }
  }

  const goal =
    input.goal?.trim() ||
    stage?.goal?.trim() ||
    (typeof track.definitionSnapshot?.goalTemplate === "string" &&
      track.definitionSnapshot.goalTemplate.trim()) ||
    `${stage?.name ?? stageKey} — ${track.name}`;

  // Dynamic: `create-session.ts` imports this module (resolveTrackFiling).
  const { createFocusSession } =
    await import("../focus-sessions/create-session.js");
  const result = await createFocusSession({
    userId: actor.userId,
    agentUserId: actor.agentUserId ?? undefined,
    workspaceId: sessionWorkspaceId,
    projectId: track.projectId,
    trackId: track.id,
    trackStage: stageKey,
    title: input.title?.trim() || stage?.name || null,
    goal,
    // A stage session is not a template run: never bind or match a playbook.
    templateId: null,
    // Pinned jsonb, validated by `createFocusSession`'s own floors.
    ...(stage?.expectedOutputs?.length
      ? {
          expectedOutputs: stage.expectedOutputs as unknown as NonNullable<
            CreateFocusSessionParams["expectedOutputs"]
          >,
        }
      : {}),
    ...(stage?.criteria?.length
      ? {
          criteria: stage.criteria as unknown as NonNullable<
            CreateFocusSessionParams["criteria"]
          >,
        }
      : {}),
    params: (track.params as Record<string, unknown> | null) ?? {},
    // Check-then-create under ONE lock: the probe above is only a fast path.
    oneOpenPerStage: true,
    // The CALLING CLIENT, exactly as `start_session` binds it: a step session
    // started over MCP / Hub REST belongs to that client for write
    // attribution. A human start (no key-auth client, no agent) binds none.
    clientKey: requestClientKey(actor.agentUserId ?? undefined) ?? null,
    // ...but never takes over the session the client's EARLIER writes
    // auto-opened: those were not this step's work.
    adoptAutoOpened: false,
  });
  const domainOutcome = (usesStamped: boolean): StageSessionDomainOutcome =>
    domainWorkspaceId && stage?.domain
      ? {
          domain: {
            wanted: stage.domain,
            workspaceId: domainWorkspaceId,
            usesStamped,
          },
        }
      : domainFallback
        ? { domainFallback }
        : {};
  if (result.status === "proposed") {
    return {
      status: "proposed",
      stageKey,
      proposalId: result.proposalId,
      proposalType: result.proposalType ?? "focus_session.create",
      message: result.message,
      ...(result.reviewUrl ? { reviewUrl: result.reviewUrl } : {}),
      ...domainOutcome(false),
    };
  }
  // The session EXISTS in the domain's workspace: stamp the project's use of
  // it through the one `uses` door — a derived index under the session create
  // that governance already allowed, never a raw link insert.
  let usesStamped = false;
  if (domainWorkspaceId && result.session.workspaceId === domainWorkspaceId) {
    usesStamped = (
      await linkProjectToWorkspace(db, {
        projectId: project.id,
        workspaceId: domainWorkspaceId,
        userId: actor.userId,
      })
    ).linked;
  }
  return {
    status: result.status === "deduped" ? "deduped" : "created",
    stageKey,
    session: result.session,
    ...domainOutcome(usesStamped),
  };
}
