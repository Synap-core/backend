/**
 * TRACK STEP — the track page's step rail, the card of the selected step, its
 * "Move on to <next>" action and the header fact. ONE answer for the browser
 * track page and Relay's track page (U2, design "Track page", 2026-10-11).
 *
 * ── Where "criteria met" comes from (read before changing) ─────────────────
 * No track read carries a per-stage criteria status: `tracks.get` (`TrackView`)
 * carries the PINNED stages (their declared `criteria`) and `stageHistory`;
 * `projects.path` rows carry `trackStage`, `status`, `closedAt` — no verdict.
 * The pod's own stage measurement (`measureTrackStage`, check gate) runs only
 * on advance and is never projected onto a read.
 *
 * So a step's criteria are graded from ONE session — its EVIDENCE session
 * ({@link trackStepEvidenceSessionId}): among the sessions FILED at the step
 * (`trackStage`), never cancelled or failed ones (not work done), the latest
 * CLOSED one (by `closedAt`); with none closed, the latest still-open one (by
 * `updatedAt`), so a criterion that already passes mid-session shows as met.
 * (Sessions have no separate "reviewed" status — closed is the reviewed end.)
 * Its CURRENT verdict per criterion (human wins — the pod's
 * `focusSessions.evaluations` read already projects that) grades each of the
 * step's pinned criteria by key: `pass` → met, `fail` → unmet, no row or
 * `unmeasured` → unmeasured.
 *
 * Cost: the surface reads `focusSessions.evaluations` for that ONE session id,
 * for the SELECTED step only — never N sessions per stage.
 *
 * Divergence, said: the check gate is stricter (EVERY closed session at the
 * step must meet its required outcomes, and at least one must be closed). A
 * move this model enables can therefore still be HELD by a check — the
 * advance result says so (`paused`), and the surface reports it.
 *
 * PURE and dependency-free (Relay, browser, CLI and pod import the same answer).
 */

import type { EvaluationVerdict } from "../focus-sessions/verdict.js";
import { humanizeToken, resolveObjectNoun } from "../vocabulary/index.js";
import type { UnitTone } from "./state.js";
import {
  isTrackClosed,
  readTrackKpi,
  trackStageTone,
  type TrackStage,
  type TrackStagePosition,
} from "./track.js";

// ── Rail ─────────────────────────────────────────────────────────────────────

export interface TrackStepRailItem {
  key: string;
  name: string;
  /** 1-based, in path order. */
  number: number;
  /** Where the track stands relative to this step. */
  position: TrackStagePosition;
  /**
   * The mark's tone ({@link trackStageTone}) — a FILL, never text ink. The
   * glyph is the surface's stage mark by `position` (relay `StageMark`):
   * a step's current position is a place, not a running turn.
   */
  tone: UnitTone;
  /** The step the track stands on. */
  isCurrent: boolean;
  /** The step the card below shows ({@link trackSelectedStepKey}). */
  isSelected: boolean;
}

/**
 * The step a track page SHOWS: the requested one (`?stage=` / the browser
 * `stage` prop) when it names a pinned step, else the current step, else the
 * first. `null` only for a track with no readable steps.
 */
export function trackSelectedStepKey(
  stages: readonly TrackStage[],
  requested?: string | null
): string | null {
  if (requested && stages.some((s) => s.key === requested)) return requested;
  return (
    stages.find((s) => s.position === "active")?.key ?? stages[0]?.key ?? null
  );
}

/**
 * The step rail: one mark per pinned step. `stages` are positioned by
 * {@link deriveTrackStages} against the track's `currentStage` — the current
 * step is read from them, never passed twice.
 */
export function trackStepRail(
  stages: readonly TrackStage[],
  requested?: string | null
): TrackStepRailItem[] {
  const selected = trackSelectedStepKey(stages, requested);
  return stages.map((stage, i) => ({
    key: stage.key,
    name: stage.name,
    number: i + 1,
    position: stage.position,
    tone: trackStageTone(stage.position),
    isCurrent: stage.position === "active",
    isSelected: stage.key === selected,
  }));
}

// ── Card ─────────────────────────────────────────────────────────────────────

/** A session row as `projects.path` returns it — the fields the pick reads. */
export interface TrackStepSessionLike {
  id: string;
  status: string;
  trackStage?: string | null;
  closedAt?: string | null;
  updatedAt?: string | null;
}

/** Sessions that are not work done: never evidence, either way. */
const NOT_EVIDENCE = new Set(["cancelled", "failed"]);

function ms(v: string | null | undefined): number {
  const t = v ? new Date(v).getTime() : Number.NaN;
  return Number.isNaN(t) ? 0 : t;
}

/**
 * The ONE session whose verdict grades a step's criteria (rule in the file
 * header). `null` when no session filed at the step counts.
 */
export function trackStepEvidenceSessionId(
  rows: readonly TrackStepSessionLike[],
  stepKey: string
): string | null {
  let closed: TrackStepSessionLike | null = null;
  let open: TrackStepSessionLike | null = null;
  for (const row of rows) {
    if (row.trackStage !== stepKey || NOT_EVIDENCE.has(row.status)) continue;
    if (row.status === "closed") {
      if (!closed || ms(row.closedAt) > ms(closed.closedAt)) closed = row;
    } else if (!open || ms(row.updatedAt) > ms(open.updatedAt)) {
      open = row;
    }
  }
  return (closed ?? open)?.id ?? null;
}

/**
 * The evidence session's grades, as the surface read them:
 *   - `null`          — no session at the step to read (nothing measured);
 *   - `ok`            — `focusSessions.evaluations(...).evaluations` (the
 *                       CURRENT row per criterion);
 *   - `unavailable`   — the read FAILED. Never folded into "unmeasured".
 */
export type TrackStepEvidence =
  | {
      status: "ok";
      evaluations: ReadonlyArray<{
        criterionKey: string;
        verdict: EvaluationVerdict;
      }>;
    }
  | { status: "unavailable"; reason: string }
  | null;

export const TRACK_STEP_CRITERION_STATES = [
  "met",
  "unmet",
  "unmeasured",
] as const;
export type TrackStepCriterionState =
  (typeof TRACK_STEP_CRITERION_STATES)[number];

export interface TrackStepCriterion {
  key: string;
  /** The criterion's `statement`, else its key humanized. */
  label: string;
  /** Absent `required` on the pinned criterion = required. */
  required: boolean;
  state: TrackStepCriterionState;
}

/**
 * How the criteria were graded: `measured` (an evidence session was read),
 * `no_session` (nothing at the step to read — every criterion unmeasured),
 * `unavailable` (the read failed — show the failure + retry, never calm marks).
 */
export type TrackStepCriteriaRead = "measured" | "no_session" | "unavailable";

export interface TrackStepEnteredBy {
  /** The user (or agent) id that moved the track into the step; may be "". */
  actor: string;
  /** ISO-8601. */
  at: string;
  /** The step it came from — `null` for the entry recorded at birth. */
  fromStage: { key: string; name: string } | null;
}

export interface TrackStepCard {
  key: string;
  name: string;
  number: number;
  position: TrackStagePosition;
  goal: string | null;
  criteria: TrackStepCriterion[];
  criteriaRead: TrackStepCriteriaRead;
  /** The failure's words, only when `criteriaRead === "unavailable"`. */
  criteriaReason: string | null;
  /**
   * The LATEST entry for this step in the stage history (steps are
   * re-enterable). `null` when never recorded — and always for a step not yet
   * reached: an old entry from before the track moved back is not where it
   * stands now (same rule as `trackStagePath`).
   */
  enteredBy: TrackStepEnteredBy | null;
  gate: "human" | "check" | null;
  /** The pod's `stage.sessionCount`; `null` = not counted (never a local recount). */
  sessionsCount: number | null;
}

function criterionLabel(c: Record<string, unknown> & { key: string }): string {
  return typeof c.statement === "string" && c.statement.trim()
    ? c.statement.trim()
    : humanizeToken(c.key);
}

/**
 * The card of ONE step. `null` when `stepKey` names no pinned step.
 *
 * @param history  `TrackView.stageHistory` (oldest first).
 * @param evidence the step's evidence-session grades ({@link TrackStepEvidence}).
 */
export function trackStepCard(
  stages: readonly TrackStage[],
  stepKey: string,
  history: ReadonlyArray<{
    stageKey: string;
    fromStage: string | null;
    enteredAt: string;
    actor: string;
  }>,
  evidence: TrackStepEvidence
): TrackStepCard | null {
  const index = stages.findIndex((s) => s.key === stepKey);
  if (index < 0) return null;
  const stage = stages[index]!;

  const verdicts = new Map<string, EvaluationVerdict>(
    evidence?.status === "ok"
      ? evidence.evaluations.map((e) => [e.criterionKey, e.verdict])
      : []
  );
  const criteria = (stage.criteria ?? []).map(
    (c): TrackStepCriterion => {
      const verdict = verdicts.get(c.key);
      return {
        key: c.key,
        label: criterionLabel(c),
        required: c.required !== false,
        state:
          verdict === "pass" ? "met" : verdict === "fail" ? "unmet" : "unmeasured",
      };
    }
  );

  let entry: (typeof history)[number] | null = null;
  if (stage.position !== "not_started") {
    // Oldest first: the last match is where the current stay began.
    for (const e of history) if (e.stageKey === stepKey) entry = e;
  }
  const from = entry?.fromStage ?? null;

  return {
    key: stage.key,
    name: stage.name,
    number: index + 1,
    position: stage.position,
    goal: stage.goal ?? null,
    criteria,
    criteriaRead:
      evidence === null
        ? "no_session"
        : evidence.status === "ok"
          ? "measured"
          : "unavailable",
    criteriaReason: evidence?.status === "unavailable" ? evidence.reason : null,
    enteredBy: entry
      ? {
          actor: entry.actor,
          at: entry.enteredAt,
          fromStage: from
            ? {
                key: from,
                name: stages.find((s) => s.key === from)?.name ?? from,
              }
            : null,
        }
      : null,
    gate: stage.gate ?? null,
    sessionsCount: stage.sessionCount ?? null,
  };
}

// ── Move on (D6) ─────────────────────────────────────────────────────────────

/**
 * THE D6 policy, in one place (founder decision D6 unanswered → recommended
 * D6a, 2026-10-11): "Move on" is enabled only once every REQUIRED criterion
 * of the step is met. D6b ("at any time, the step keeps its marks") is this
 * constant set to `false`. D6c ("browser only") is a surface choice — Relay
 * would not draw the action — and does not live here.
 */
export const TRACK_MOVE_ON_REQUIRES_MET_CRITERIA: boolean = true;

/**
 * Why "Move on" is not enabled:
 *   - `not_current`         — the selected step is not where the track stands
 *                             (the action is not drawn);
 *   - `track_closed`        — completed / archived: the pod refuses a move
 *                             (the action is not drawn);
 *   - `last_step`           — nothing after it (the action is not drawn);
 *   - `criteria_unmet`      — `missing` lists the required criteria not met;
 *   - `criteria_unreadable` — the grades could not be read: show the failure
 *                             and its retry, never "nothing missing".
 */
export type TrackMoveOnBlock =
  | "not_current"
  | "track_closed"
  | "last_step"
  | "criteria_unmet"
  | "criteria_unreadable";

export interface TrackMoveOn {
  /** The step after the selected one; `null` on the last step. */
  next: { key: string; name: string } | null;
  /** Draw the action at all (the current step of an open track, with a next). */
  offered: boolean;
  enabled: boolean;
  /** Labels of the REQUIRED criteria not met (unmet or unmeasured). */
  missing: string[];
  block: TrackMoveOnBlock | null;
}

/**
 * The step card's one action, "Move on to <next>" — a tap BY THE USER, so
 * "advance only with the user" holds. A paused track may move (the pod allows
 * it); a closed one may not.
 */
export function trackMoveOn(
  stages: readonly TrackStage[],
  card: Pick<TrackStepCard, "key" | "criteria" | "criteriaRead">,
  track: { status: string }
): TrackMoveOn {
  const index = stages.findIndex((s) => s.key === card.key);
  const after = index >= 0 ? stages[index + 1] : undefined;
  const next = after ? { key: after.key, name: after.name } : null;
  const missing = card.criteria
    .filter((c) => c.required && c.state !== "met")
    .map((c) => c.label);
  const notOffered = (block: TrackMoveOnBlock): TrackMoveOn => ({
    next,
    offered: false,
    enabled: false,
    missing,
    block,
  });

  if (isTrackClosed(track)) return notOffered("track_closed");
  if (stages[index]?.position !== "active") return notOffered("not_current");
  if (!next) return notOffered("last_step");

  // ── D6 policy: the ONE branch ──
  if (TRACK_MOVE_ON_REQUIRES_MET_CRITERIA) {
    if (card.criteriaRead === "unavailable") {
      return { next, offered: true, enabled: false, missing, block: "criteria_unreadable" };
    }
    if (missing.length > 0) {
      return { next, offered: true, enabled: false, missing, block: "criteria_unmet" };
    }
  }
  return { next, offered: true, enabled: true, missing, block: null };
}

// ── Header fact ──────────────────────────────────────────────────────────────

export interface TrackHeaderFact {
  /** `kpi` when the track steers by a STATED number, else `step`. */
  kind: "kpi" | "step";
  text: string;
}

/**
 * The track header's one fact: "14 of 50 signups" when the track has a KPI
 * with a stated `current` (`readTrackKpi`; the unit, else the label, names
 * the number — user content, kept as typed), else "Step 2 of 6 · Decide".
 * `null` when there is neither (no current step and no stated KPI) — OMIT.
 * A KPI with no stated `current` is not a fact yet: it falls to the step.
 */
export function trackHeaderFact(track: {
  kpi?: unknown;
  stages: readonly TrackStage[];
}): TrackHeaderFact | null {
  const kpi = readTrackKpi(track.kpi);
  if (kpi && typeof kpi.current === "number") {
    return {
      kind: "kpi",
      text: `${kpi.current} of ${kpi.target} ${kpi.unit ?? kpi.label}`,
    };
  }
  const at = track.stages.findIndex((s) => s.position === "active");
  if (at < 0) return null;
  return {
    kind: "step",
    text: `${resolveObjectNoun("stage")} ${at + 1} of ${track.stages.length} · ${track.stages[at]!.name}`,
  };
}
