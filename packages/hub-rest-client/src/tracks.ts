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

import type { HubFocusSession } from "./types.js";
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
  | "no_longer_needed"
  | "impossible"
  | "replaced"
  | "mistake";

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
  /**
   * Who is on the goal: owner, judge, delegates (with their commitment),
   * integrator. Absent on a pod before 0346, or when not read.
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
  reasoning?: string;
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
