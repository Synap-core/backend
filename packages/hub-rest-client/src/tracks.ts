/**
 * Track wire types — the Hub `/tracks` routes (rest/tracks.ts).
 *
 * A TRACK is a method (a project-scoped playbook) running inside one project;
 * each STAGE ("step") may name the DOMAIN (a workspace template slug) it is
 * worked in. Kept in its own file so the track surface is one reviewable unit.
 *
 * Two advisory fields ride through UNTOUCHED, never folded into success:
 * - `missingDomains` (+ `domainsNote`) on start — stage domains with no
 *   installed workspace; those stages' sessions will fall back to home.
 * - `domainFallback` (+ `domainNote`) on a stage session — the session was
 *   placed in the project's home workspace instead of the stage's domain.
 */

import type { HubFocusSession, HubSessionCriterion } from "./types.js";
import type { HubTrackParticipant } from "./track-participants.js";

/**
 * A track's status — the option keys of its system lifecycle: open (proposed ·
 * agreed · ready), active, paused, done (`completed`, read "Closed") and lost
 * (`archived`, read "Dropped"). Mirror of `TrackStatus`
 * (`@synap-core/types/units`), pinned EQUAL by `parity/track-status.floor.ts`
 * (this package has zero dependencies, so it cannot import the original).
 */
export type HubTrackStatus =
  | "proposed"
  | "agreed"
  | "ready"
  | "active"
  | "paused"
  | "completed"
  | "archived";

/**
 * How a closed (`completed`) or dropped (`archived`) goal ended. Mirror of
 * `TrackVerdict` (`@synap-core/types/units`), pinned by the same floor.
 */
export type HubTrackVerdict =
  | "met"
  | "partly_met"
  | "not_met"
  | "retired"
  | "no_longer_needed"
  | "impossible"
  | "replaced"
  | "mistake";

/** The kind of work a goal is (0345). Mirror of `TrackWorkKind`, pinned by the floor. */
export type HubTrackWorkKind =
  | "project"
  | "flow"
  | "operation"
  | "investigation"
  | "incident"
  | "commission"
  | "pathway";

/** How well the way is known (0345). Mirror of `TrackUncertainty`, pinned by the floor. */
export type HubTrackUncertainty =
  "clear" | "complicated" | "complex" | "chaotic" | "unknown";

/** A goal criterion's derived state. Mirror of `GoalCriterionMark`, pinned by the floor. */
export type HubGoalCriterionMark =
  "met" | "claimed" | "under_way" | "not_met" | "not_started";

/** What the goal's judge decided (R2). Mirror of `GoalAcceptanceDecision`. */
export type HubGoalAcceptanceDecision =
  "accepted" | "changes_asked" | "rejected";

/** What a goal waits on (R4). Mirror of `WaitingOnReason`, pinned by the floor. */
export type HubWaitingOnReason =
  "input" | "approval" | "access" | "another_work" | "outside_world";

/** One goal criterion as the pod returns it — stored fields + derived state. */
export interface HubGoalCriterion extends HubSessionCriterion {
  acceptance: {
    decision: HubGoalAcceptanceDecision;
    by: string;
    at: string;
    note?: string;
  } | null;
  /** `null` only when the pod could not read the goal's runs. */
  mark: HubGoalCriterionMark | null;
  acceptanceState: "waiting" | HubGoalAcceptanceDecision | null;
  meaning: string;
  currentValue: string | null;
}

export interface HubTrackStage {
  key: string;
  name: string;
  category: string | null;
  position: "done" | "active" | "not_started";
  sessionCount?: number;
  goal?: string;
  description?: string;
  suggestedTasks?: string[];
  expectedOutputs?: Array<Record<string, unknown>>;
  criteria?: Array<Record<string, unknown> & { key: string }>;
  gate?: "human" | "check";
  indefinite?: boolean;
  /** Workspace TEMPLATE slug this stage is worked in (never a workspace id). */
  domain?: string;
  [key: string]: unknown;
}

/** GET /tracks, GET /tracks/:id — the projected track (`TrackView`). */
export interface HubTrack {
  id: string;
  projectId: string;
  name: string;
  playbookId: string | null;
  methodVersion: string;
  currentStage: string | null;
  status: HubTrackStatus;
  /** Why it is paused — `null` unless `status === "paused"`. */
  pausedBy: "check" | "human" | null;
  stages: HubTrackStage[];
  params: Record<string, unknown>;
  declaredParams: unknown[];
  stageHistory: Array<{
    stageKey: string;
    fromStage: string | null;
    enteredAt: string;
    actor: string;
  }>;
  /** How a closed or dropped goal ended — `null` while it is live. */
  verdict?: HubTrackVerdict | null;
  /** Why, in words — present for `impossible` and `replaced`. */
  verdictReason?: string | null;
  /** What "done" looks like (0345) — `null` when unsaid. */
  endState?: string | null;
  /** None (a lasting goal) or 2–5 criteria, each with its derived mark. */
  criteria?: HubGoalCriterion[];
  dropConditions?: string[];
  /**
   * The goal's loop (0350, W4): it proposes its next run while a required
   * criterion is unmet. Never set reads `{ on: false }`.
   */
  loop?: HubGoalLoop;
  workKind?: HubTrackWorkKind | null;
  uncertainty?: HubTrackUncertainty | null;
  /** The person who confirmed kind + uncertainty — `null` while proposed. */
  kindConfirmedBy?: string | null;
  kindConfirmedAt?: string | null;
  /** Every required criterion claimed, none accepted yet — derived. */
  inReview?: boolean | null;
  /** What the goal waits on — derived; `[]` = nothing. */
  waitingOn?: Array<{ reason: HubWaitingOnReason; count: number }> | null;
  /**
   * Who is on the goal: owner, judge, delegates (with their commitment),
   * integrator. Absent on a pod before 0348, or when not read.
   */
  participants?: HubTrackParticipant[];
  createdAt: string;
  updatedAt: string;
}

/** A governed track write that became a proposal — SUCCESS, queued for review. */
export interface HubTrackProposed {
  status: "proposed";
  proposalId: string;
  proposalType?: string;
  message?: string;
  reviewUrl?: string;
}

export interface ListTracksOptions {
  includeArchived?: boolean;
}

/** A page of every goal the caller can see, pod-wide (`listAllTracks`). */
export interface ListAllTracksOptions extends ListTracksOptions {
  /** Page size, 1–100 (the pod's default is 50). */
  limit?: number;
  /** `nextCursor` from the previous page. */
  cursor?: string;
}

export interface HubTrackPage {
  /** Newest first, each with its derived marks (criteria, inReview, waitingOn). */
  items: HubTrack[];
  /** Hand back for the next page; `null` on the last one. */
  nextCursor: string | null;
}

export interface StartTrackInput {
  projectId: string;
  /**
   * A project-scoped playbook (the method) — OPTIONAL: a track is a goal;
   * omit it for a stage-less track (then `name` is required).
   */
  playbookId?: string;
  name?: string;
  params?: Record<string, unknown>;
  /** Where the track is heading, one line. */
  direction?: string;
  /** The number it steers by: `{ label, unit?, target, current? }`. */
  kpi?: { label: string; unit?: string; target: number; current?: number };
  /** What the goal holds (0345). */
  endState?: string;
  /** None, or 2–5 criteria. */
  criteria?: HubSessionCriterion[];
  dropConditions?: string[];
  workKind?: HubTrackWorkKind;
  uncertainty?: HubTrackUncertainty;
  /** The goal's loop (W4); an agent's switch-on is always proposed. */
  loop?: HubGoalLoopInput;
  reasoning?: string;
}

/**
 * PATCH /tracks/:id/direction — where the goal is heading, its KPI and what
 * it holds. Every field but `kpi` is written WHOLE; `null` clears it.
 */
export interface UpdateTrackInput {
  direction?: string | null;
  kpi?: {
    label?: string;
    unit?: string;
    target?: number;
    current?: number;
  } | null;
  endState?: string | null;
  criteria?: HubSessionCriterion[] | null;
  dropConditions?: string[] | null;
  workKind?: HubTrackWorkKind | null;
  uncertainty?: HubTrackUncertainty | null;
  /** A PERSON confirms the AI's kind of work and uncertainty (an agent is refused). */
  confirmKind?: boolean;
  /** The goal's loop (W4): `{ on: true }` again = try again; `null` = off. */
  loop?: HubGoalLoopInput | null;
  reasoning?: string;
}

/** The goal's loop as a read returns it (`readGoalLoop`). */
export interface HubGoalLoop {
  on: boolean;
  perWeek: number;
  /** When a person last switched it on (ISO-8601). */
  onAt: string | null;
  by: string | null;
}

/** The goal's loop as a write names it. */
export interface HubGoalLoopInput {
  on: boolean;
  /** Proposals per rolling week, 1–14 (absent keeps the stored budget). */
  perWeek?: number;
}

/** POST /tracks/:id/criteria/:key/acceptance — the goal's judge decides (R2). */
export interface AcceptTrackCriterionInput {
  decision: HubGoalAcceptanceDecision;
  /** Required to send it back (`changes_asked`): what to change. */
  note?: string;
}

/** Advisory, never a refusal: stage domains with no installed workspace. */
interface MissingDomains {
  missingDomains?: string[];
  /** The pod's one-sentence explanation, present only when some are missing. */
  domainsNote?: string;
}

export type HubStartTrackResult =
  | ({
      status: "started" | "exists";
      track: HubTrack;
    } & MissingDomains)
  | (HubTrackProposed & MissingDomains);

export interface HubStageSessionOffer {
  stageKey: string;
  name: string;
  goal: string | null;
  suggestedTasks: string[];
}

export interface AdvanceTrackInput {
  toStage: string;
  reasoning?: string;
}

export type HubAdvanceTrackResult =
  | {
      status: "advanced" | "unchanged";
      track: HubTrack;
      gated: boolean;
      paused: boolean;
      /** A human gate filed an approval for the stage entered. */
      proposalId?: string;
      proposalType?: string;
      check?: { passed: boolean; failing: string[]; reason?: string };
      /** The session the entered stage OFFERS — never started for you. */
      offer: HubStageSessionOffer | null;
    }
  | HubTrackProposed;

/** How a status move closes (`completed`) or drops (`archived`) the goal. */
export interface TrackCloseInput {
  /** Required to close or drop: met · partly_met · not_met, or no_longer_needed · impossible · replaced · mistake. */
  verdict: HubTrackVerdict;
  /** Required for `impossible` and `replaced`. */
  verdictReason?: string;
}

export interface ReopenTrackInput {
  /** A new name — absent ⇒ the closed track's own. */
  name?: string;
  reasoning?: string;
}

/** "Make it a goal" (D2) — a goal / objective / okr entity becomes a goal, once. */
export interface ConvertToGoalInput {
  entityId: string;
  /** Required when the entity is filed in no project, or in several. */
  projectId?: string;
  /** A name other than the entity's title. */
  name?: string;
  reasoning?: string;
}

export type HubConvertToGoalResult =
  | {
      status: "started" | "exists";
      track: HubTrack;
      entityId: string;
      /** The entity's fields the goal does not hold (to tell the person). */
      notCarried: string[];
    }
  | HubTrackProposed;

export type HubTrackWriteResult =
  { status: "updated" | "unchanged"; track: HubTrack } | HubTrackProposed;

export interface StartStageSessionInput {
  /** Omit ⇒ the track's CURRENT stage (resolved with GET /tracks/:id). */
  stageKey?: string;
  title?: string;
  goal?: string;
}

export type HubStageDomainFallbackReason =
  "no_workspace" | "not_a_domain_home" | "no_write_access";

/** Where a stage that names a domain was worked. */
interface StageDomainOutcome {
  domain?: { wanted: string; workspaceId: string; usesStamped: boolean };
  /** The session went to the project's HOME workspace instead — say so. */
  domainFallback?: { wanted: string; reason: HubStageDomainFallbackReason };
  /** The pod's sentence for `domainFallback`. */
  domainNote?: string;
}

export type HubStartStageSessionResult =
  | ({
      status: "created" | "existing" | "deduped";
      /** `null` ⇒ a stage-less track: the session is filed at no stage. */
      stageKey: string | null;
      session: HubFocusSession;
    } & StageDomainOutcome)
  | (HubTrackProposed & { stageKey: string | null } & StageDomainOutcome);

/** Track fields POST /focus-sessions accepts — a session born inside a track. */
export interface FocusSessionTrackScope {
  /** The track this session advances. Implies its project. */
  trackId?: string;
  /** The track stage it is filed at; omit ⇒ the track's current stage. */
  trackStage?: string;
}
