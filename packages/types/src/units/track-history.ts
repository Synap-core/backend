/**
 * TRACK HISTORY — what happened to one track, as the pod reads it
 * (`tracks.history`), and the ONE grouping every surface draws it with.
 *
 * ── Sources (the pod's, not a surface's) ───────────────────────────────────
 *   step moves + check verdicts — `project_tracks.stage_history`, the
 *                    authoritative timeline (0274); a check verdict is stamped
 *                    on the entry whose ENTRY gate measured it;
 *   pause / resume / other status moves — the track's own write receipts
 *                    (`track.update.completed` events, one per write);
 *   sessions + decisions — the track's sessions and the proposals filed in
 *                    them or on the track's stage gates.
 * Actors are resolved to names by the POD (`ActivityActor`): a client cannot,
 * Relay's signed-in id being the Control Plane's, not the pod's.
 *
 * ── Grouping (founder D4, default D4a) ─────────────────────────────────────
 * By STEP: the step with the newest event first and open; past steps fold to a
 * one-line summary; a group holding an open ask or a failure is always open.
 * The policy is ONE constant ({@link TRACK_HISTORY_GROUP_BY}): D4b ("by day")
 * is a one-line switch, the grouping itself is shared.
 *
 * PURE and dependency-free (Relay, browser and pod import the same answer).
 */

import {
  activityOutcomeForProposal,
  activityOutcomeForSession,
  type ActivityActor,
  type ActivityOutcome,
} from "../activity/index.js";
import { CHECK_GATE_UNEVALUATED } from "../focus-sessions/check-gate.js";
import type { SessionVerdict } from "../focus-sessions/verdict.js";
import {
  humanizeToken,
  resolveActionLabel,
  resolveObjectNoun,
  resolveObjectNounPlural,
} from "../vocabulary/index.js";
import { trackStatusVerb } from "./track.js";

export const TRACK_HISTORY_EVENT_KINDS = [
  "track_started",
  "step_moved",
  "session_started",
  "session_closed",
  "decision_asked",
  "decision_answered",
  "check_passed",
  "check_held",
  "paused",
  "resumed",
  "status_changed",
] as const;
export type TrackHistoryEventKind = (typeof TRACK_HISTORY_EVENT_KINDS)[number];

/** Doors the event names — each opens that object's own page. */
export interface TrackHistoryRefs {
  sessionId?: string;
  proposalId?: string;
}

interface TrackHistoryEventBase {
  /** Stable across reads — a client may key rows by it. */
  id: string;
  /** ISO-8601. */
  at: string;
  /** Who acted, named by the pod. A check is `system` with no name. */
  actor: ActivityActor;
  /**
   * The step the event belongs to — what it is grouped under. A move and its
   * check belong to the step ENTERED; a session or decision to the step it was
   * filed at; a status move to the step the track stood on. `null` = no step
   * (a stageless method, or a session filed at none).
   */
  stageKey: string | null;
  refs: TrackHistoryRefs;
}

export type TrackHistoryEvent = TrackHistoryEventBase &
  (
    | { kind: "track_started" }
    | {
        kind: "step_moved";
        /** The step left — `null` when the track entered its first step. */
        fromStage: string | null;
      }
    | { kind: "session_started"; title: string }
    | {
        kind: "session_closed";
        title: string;
        /** The session's settled status (`closed`, `cancelled`, `failed`, …). */
        sessionStatus: string;
        /** Its contract, graded (`computeSessionVerdict`). */
        verdict: SessionVerdict["state"];
      }
    | {
        /** A decision still PENDING — an open ask of a person. */
        kind: "decision_asked";
        title: string | null;
      }
    | {
        kind: "decision_answered";
        title: string | null;
        /** `approved` | `rejected` | `reverted` | `approval_failed`. */
        decision: string;
        /** The reviewer's note, when one was left. */
        note: string | null;
      }
    | {
        /** The entered step's `check` gate measured the step LEFT: met. */
        kind: "check_passed";
        fromStage: string;
      }
    | {
        /** …and it was NOT met — the track holds (`Paused · by a check`). */
        kind: "check_held";
        fromStage: string;
        /** Required criteria / outcomes not met (`CHECK_GATE_UNEVALUATED` = not measured). */
        failing: string[];
        reason: string | null;
      }
    | { kind: "paused" }
    | { kind: "resumed" }
    | {
        /** Any other status move (complete, reopen, archive). */
        kind: "status_changed";
        fromStatus: string;
        toStatus: string;
      }
  );

/** The `tracks.history` read. Newest first. */
export interface TrackHistoryWire {
  trackId: string;
  events: TrackHistoryEvent[];
  /** A source hit its scan cap — older events exist and are not listed. */
  truncated: boolean;
}

/** An event a person still owes an answer to. */
export function isTrackHistoryAsk(e: TrackHistoryEvent): boolean {
  return e.kind === "decision_asked";
}

/** An event that went WRONG — never folded out of sight. */
export function isTrackHistoryFailure(e: TrackHistoryEvent): boolean {
  switch (e.kind) {
    case "check_held":
      return true;
    case "session_closed":
      return e.verdict === "failing" || e.sessionStatus === "failed";
    case "decision_answered":
      return e.decision === "approval_failed";
    default:
      return false;
  }
}

// ── Grouping ────────────────────────────────────────────────────────────────

export const TRACK_HISTORY_GROUP_BYS = ["step", "day"] as const;
export type TrackHistoryGroupBy = (typeof TRACK_HISTORY_GROUP_BYS)[number];

/** THE policy (founder D4 default D4a). D4b = change this one word to "day". */
export const TRACK_HISTORY_GROUP_BY: TrackHistoryGroupBy = "step";

/** One line a folded group shows — counts, never prose. */
export interface TrackHistorySummary {
  moves: number;
  sessionsStarted: number;
  sessionsClosed: number;
  decisions: number;
  openAsks: number;
  failures: number;
}

export interface TrackHistoryGroup {
  /** `step:<key>` / `step:` (no step) / `day:<YYYY-MM-DD>`. */
  key: string;
  by: TrackHistoryGroupBy;
  /** The step (by step) — `null` for events filed at no step, and by day. */
  stage: { key: string; name: string } | null;
  /** The calendar day (by day) — `null` by step. */
  day: string | null;
  /** Newest first. */
  events: TrackHistoryEvent[];
  summary: TrackHistorySummary;
  /** Shown expanded: the newest group, or any holding an open ask / failure. */
  open: boolean;
  /** ISO-8601 of its newest event. */
  lastAt: string;
}

function summarize(events: readonly TrackHistoryEvent[]): TrackHistorySummary {
  const s: TrackHistorySummary = {
    moves: 0,
    sessionsStarted: 0,
    sessionsClosed: 0,
    decisions: 0,
    openAsks: 0,
    failures: 0,
  };
  for (const e of events) {
    if (e.kind === "step_moved") s.moves++;
    else if (e.kind === "session_started") s.sessionsStarted++;
    else if (e.kind === "session_closed") s.sessionsClosed++;
    else if (e.kind === "decision_answered") s.decisions++;
    if (isTrackHistoryAsk(e)) s.openAsks++;
    if (isTrackHistoryFailure(e)) s.failures++;
  }
  return s;
}

const time = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

/** Newest first; ties by id so two reads order identically. */
function newestFirst(a: TrackHistoryEvent, b: TrackHistoryEvent): number {
  const d = time(b.at) - time(a.at);
  if (d !== 0) return d;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function dayOf(iso: string, timeZone: string | undefined): string {
  const date = new Date(time(iso));
  try {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/**
 * Group a track's history for its History page.
 *
 * @param events  `tracks.history().events`, any order.
 * @param stages  the track's stages (`TrackView.stages`) — names a step; an
 *                event naming a step the track no longer declares is still
 *                listed, under the humanized key (never dropped).
 * @param opts.by the grouping — defaults to THE policy.
 * @param opts.timeZone by day: the viewer's zone (default: the runtime's).
 */
export function trackHistoryGroups(
  events: readonly TrackHistoryEvent[],
  stages: ReadonlyArray<{ key: string; name: string }>,
  opts: { by?: TrackHistoryGroupBy; timeZone?: string } = {}
): TrackHistoryGroup[] {
  const by = opts.by ?? TRACK_HISTORY_GROUP_BY;
  const names = new Map(stages.map((s) => [s.key, s.name]));
  const buckets = new Map<string, TrackHistoryEvent[]>();
  for (const e of [...events].sort(newestFirst)) {
    const key =
      by === "step"
        ? `step:${e.stageKey ?? ""}`
        : `day:${dayOf(e.at, opts.timeZone)}`;
    const list = buckets.get(key);
    if (list) list.push(e);
    else buckets.set(key, [e]);
  }
  // Map order = first insertion = the bucket's newest event, newest first.
  return [...buckets].map(([key, list], i) => {
    const summary = summarize(list);
    const stageKey = by === "step" ? key.slice("step:".length) : "";
    return {
      key,
      by,
      stage:
        by === "step" && stageKey
          ? {
              key: stageKey,
              name: names.get(stageKey) ?? humanizeToken(stageKey),
            }
          : null,
      day: by === "day" ? key.slice("day:".length) : null,
      events: list,
      summary,
      open: i === 0 || summary.openAsks > 0 || summary.failures > 0,
      lastAt: list[0]!.at,
    };
  });
}

// ── One event, as a line (U5 surfaces) ──────────────────────────────────────
//
// Both surfaces draw an event as their kit's "what happened" row; WHAT the row
// says (the act, its object, where it opens, how it stands) is decided HERE,
// once — relay and the browser had each written it and already disagreed.

/**
 * A door to a STEP: the host opens the track page ON that step
 * (`track?stage=<key>`, D1a). Not an object kind of its own — a step is a
 * place inside its track; `id` is the stage key.
 */
export const TRACK_STEP_DOOR_KIND = "track_stage";

export interface TrackHistoryContext {
  trackId: string;
  trackName: string;
  stages: ReadonlyArray<{ key: string; name: string }>;
}

/** What one event's line says and opens. */
export interface TrackHistoryAct {
  /** A vocabulary action token — `resolveActionLabel(action, "past")` is its verb. */
  action: string;
  /** The object the verb acts on, in words. */
  title: string;
  /** Where the line opens: a session, a proposal, a step (`TRACK_STEP_DOOR_KIND`) or the track. */
  door: { kind: string; id: string };
  /** Where the act stands — `resolveActivityOutcomeView` gives its mark. */
  outcome: ActivityOutcome;
}

function stepName(ctx: TrackHistoryContext, key: string | null): string {
  if (!key) return resolveObjectNoun("stage");
  return ctx.stages.find((s) => s.key === key)?.name ?? humanizeToken(key);
}

function decisionAction(decision: string): string {
  switch (decision) {
    case "rejected":
      return "reject";
    case "reverted":
      return "revert";
    default:
      // approved / auto-approved / an approval that could not apply (its
      // outcome mark says it failed).
      return "approve";
  }
}

/** One history event → what its line says and where it opens. */
export function trackHistoryAct(
  e: TrackHistoryEvent,
  ctx: TrackHistoryContext
): TrackHistoryAct {
  const track = { kind: "track", id: ctx.trackId };
  const step = (key: string | null) =>
    key ? { kind: TRACK_STEP_DOOR_KIND, id: key } : track;
  const session = e.refs.sessionId
    ? { kind: "session", id: e.refs.sessionId }
    : track;
  const proposal = e.refs.proposalId
    ? { kind: "proposal", id: e.refs.proposalId }
    : session;
  switch (e.kind) {
    case "track_started":
      return {
        action: "start",
        title: ctx.trackName,
        door: track,
        outcome: "succeeded",
      };
    case "step_moved":
      return {
        action: "move",
        title: `to ${stepName(ctx, e.stageKey)}`,
        door: step(e.stageKey),
        outcome: "succeeded",
      };
    case "session_started":
      return {
        action: "start",
        title: e.title,
        door: session,
        outcome: "succeeded",
      };
    case "session_closed":
      return {
        action: "close",
        title: e.title,
        door: session,
        // A closed session whose contract graded failing did not succeed.
        outcome:
          e.verdict === "failing"
            ? "failed"
            : activityOutcomeForSession(e.sessionStatus),
      };
    case "decision_asked":
      return {
        action: "ask",
        title: e.title ?? resolveObjectNoun("proposal"),
        door: proposal,
        outcome: "waiting",
      };
    case "decision_answered":
      return {
        action: decisionAction(e.decision),
        title: e.title ?? resolveObjectNoun("proposal"),
        door: proposal,
        outcome: activityOutcomeForProposal(e.decision),
      };
    case "check_passed":
      return {
        action: "check",
        title: stepName(ctx, e.fromStage),
        door: step(e.fromStage),
        outcome: "succeeded",
      };
    case "check_held":
      return {
        action: "check",
        title: stepName(ctx, e.fromStage),
        door: step(e.fromStage),
        outcome: "failed",
      };
    case "paused":
      return {
        action: "pause",
        title: ctx.trackName,
        door: track,
        outcome: "stopped",
      };
    case "resumed":
      return {
        action: "resume",
        title: ctx.trackName,
        door: track,
        outcome: "succeeded",
      };
    case "status_changed": {
      // The verb of that move — the shared status table, never a local one.
      return {
        action: trackStatusVerb(e.fromStatus, e.toStatus) ?? "update",
        title: ctx.trackName,
        door: track,
        outcome: "succeeded",
      };
    }
  }
}

function counted(n: number, kind: string): string {
  return `${n} ${(n === 1 ? resolveObjectNoun(kind) : resolveObjectNounPlural(kind)).toLowerCase()}`;
}

/**
 * A folded group's one line — what is in it, counted ("2 sessions · 1
 * decision · Moved ×2"). Open asks and failures are never in a folded group
 * (the grouping keeps such a group open), so they are not counted here.
 * Nothing counted ⇒ "".
 */
export function trackHistorySummaryWords(s: TrackHistorySummary): string {
  // One session can start AND close inside a step: the larger count, never the sum.
  const sessions = Math.max(s.sessionsStarted, s.sessionsClosed);
  const parts = [
    sessions > 0 ? counted(sessions, "session") : null,
    s.decisions > 0 ? counted(s.decisions, "decision") : null,
    s.moves > 0
      ? `${resolveActionLabel("move", "past")} \u00d7${s.moves}`
      : null,
  ].filter((p): p is string => p !== null);
  return parts.join(" \u00b7 ");
}

/** A check's failing keys, as words: the criterion's statement where it has one. */
export function checkFailingLabels(
  failing: readonly string[],
  stage:
    | { criteria?: ReadonlyArray<Record<string, unknown> & { key: string }> }
    | null
    | undefined
): string[] {
  return failing.map((key) => {
    if (key === CHECK_GATE_UNEVALUATED)
      return "The check could not measure this step";
    const c = stage?.criteria?.find((x) => x.key === key);
    const statement = c?.statement;
    return typeof statement === "string" && statement.trim()
      ? statement.trim()
      : humanizeToken(key);
  });
}

/** What an event's line carries under it — a reviewer's note, a held check's why. */
export function trackHistoryNote(
  e: TrackHistoryEvent,
  stages: ReadonlyArray<{
    key: string;
    criteria?: ReadonlyArray<Record<string, unknown> & { key: string }>;
  }>
): { reason: string | null; failing: string[] } | null {
  if (e.kind === "decision_answered") {
    return e.note ? { reason: e.note, failing: [] } : null;
  }
  if (e.kind === "check_held") {
    return {
      reason: e.reason,
      failing: checkFailingLabels(
        e.failing,
        stages.find((s) => s.key === e.fromStage)
      ),
    };
  }
  return null;
}

/**
 * WHO moved the track into the step a card shows — the pod's resolved
 * `enteredBy` on THE history entry the card read (same step, same instant).
 * `undefined` when the pod did not name it: then nobody is named, never a
 * guessed "you" (relay's signed-in id is the Control Plane's, not the pod's).
 */
export function trackStepMover(
  history: ReadonlyArray<{
    stageKey: string;
    enteredAt: string;
    enteredBy?: ActivityActor;
  }>,
  card: { key: string; enteredBy: { at: string } | null } | null
): ActivityActor | undefined {
  if (!card?.enteredBy) return undefined;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i]!;
    if (h.stageKey === card.key && h.enteredAt === card.enteredBy.at) {
      return h.enteredBy;
    }
  }
  return undefined;
}
