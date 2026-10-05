/**
 * THE NEXT-MOVE RANKING — "what should I do in the next hour?"
 *
 * ONE pure ranking, `rankNextMoves(candidates, now)`, read by BOTH:
 *   - the lens header's next move (`lensNextMoveRow` = rank[0]), and
 *   - the next-hour picker on relay Home (`lensNextHour` = the start tier,
 *     top {@link NEXT_HOUR_PICKS}).
 * There is no second ranker, so the two can never name different moves.
 *
 * Founder-approved shape (option A, prior art §d): the machine RANKS, the
 * human PICKS — no auto-replanning; every pick says WHY it was picked
 * (reason chips) and can be skipped; "only you can answer" comes first.
 *
 * ── TIERS (the order IS the rule) ──────────────────────────────────────────
 *   answer — Blocking: only you can answer it; work stops until you do. Kept
 *            in the needs-you order (THE needs-you rule, `needsYouRows`), so
 *            the header's move is always the Needs-you section's first row.
 *   start  — work you could start or resume now: open tasks and open track
 *            steps with no open blocker (`deriveOpenBlockers`). Scored, below.
 *   watch  — Happening: an agent is working; you can only watch. Last,
 *            because watching is not a move — it is what the header falls
 *            back to when nothing is yours to do.
 *
 * ── SCORE (start tier only) ─────────────────────────────────────────────────
 *   1. unblocks  — more open dependents waiting on it first;
 *   2. draft     — an agent-produced output already waiting on it first;
 *   3. waited    — waiting longest first (the raw instant, so the order never
 *                  depends on `now`; `now` only words the "waited Nd" chip);
 *   4. the input order (the pod's own order) — stable.
 * Every reason chip is a FACT the data carries. Nothing is estimated: there
 * is no duration slot because no unit of work stores an estimate today — a
 * duration would be invented, and an invented number is worse than none.
 *
 * Pure and dependency-free apart from sibling leaves.
 */

import { resolveActionLabel } from "../vocabulary/index.js";
import type { UnitStateInput } from "../units/state.js";
import type { LensDoor, LensRow } from "./rows.js";

export const NEXT_MOVE_TIERS = ["answer", "start", "watch"] as const;
export type NextMoveTier = (typeof NEXT_MOVE_TIERS)[number];

/** How many picks the next-hour picker shows at rest. */
export const NEXT_HOUR_PICKS = 3;

/** A named container a pick belongs to — drawn as a DOOR chip. */
export interface NextMoveContainer {
  id: string;
  name: string;
}

/** The facts a start-tier candidate is ranked (and explained) by. */
export interface NextMoveFacts {
  /** Open units of work waiting on this one (`blocked_by` dependents). */
  unblocks?: number;
  /** Since when it has waited (ISO) — a task's creation, a step's last move. */
  waitingSince?: string | null;
  project?: NextMoveContainer | null;
  track?: NextMoveContainer | null;
  /** An agent already produced an output for it that waits on the person. */
  draftReady?: boolean;
}

export interface NextMoveCandidate {
  tier: NextMoveTier;
  row: LensRow;
  facts?: NextMoveFacts;
}

/**
 * A reason chip's tone TOKEN (never a colour): `ai` = an agent's work is
 * waiting (AI provenance), `error` = it has waited past
 * {@link NEXT_MOVE_STUCK_DAYS}, `neutral` otherwise.
 */
export type NextMoveReasonTone = "neutral" | "ai" | "error";

/** Waiting this many days or more reads as stuck (the error tone). */
export const NEXT_MOVE_STUCK_DAYS = 7;

/** One reason chip — why the machine ranked it here. */
export type NextMoveReason = { tone: NextMoveReasonTone } & (
  | { kind: "unblocks"; count: number; label: string }
  | { kind: "waited"; days: number; label: string }
  | { kind: "project"; label: string; door: LensDoor }
  | { kind: "track"; label: string; door: LensDoor }
  | { kind: "draft-ready"; label: string }
);

export interface RankedNextMove {
  tier: NextMoveTier;
  row: LensRow;
  /** Reason chips, most decisive first. Empty for answer / watch moves. */
  reasons: NextMoveReason[];
}

const DAY_MS = 86_400_000;

function instant(at: string | null | undefined): number | null {
  if (!at) return null;
  const t = new Date(at).getTime();
  return Number.isFinite(t) ? t : null;
}

/** The reason chips of one candidate, in the order the score reads them. */
export function nextMoveReasons(
  facts: NextMoveFacts | undefined,
  now: Date | number
): NextMoveReason[] {
  if (!facts) return [];
  const out: NextMoveReason[] = [];
  const unblocks = facts.unblocks ?? 0;
  if (unblocks > 0) {
    out.push({
      kind: "unblocks",
      count: unblocks,
      label: `Unblocks ${unblocks}`,
      tone: "neutral",
    });
  }
  if (facts.draftReady) {
    out.push({ kind: "draft-ready", label: "Draft ready", tone: "ai" });
  }
  const since = instant(facts.waitingSince);
  const nowMs = typeof now === "number" ? now : now.getTime();
  if (since !== null) {
    const days = Math.floor((nowMs - since) / DAY_MS);
    // Under a day is not "waiting" worth a chip — it is today's work.
    if (days >= 1) {
      out.push({
        kind: "waited",
        days,
        label: `Waited ${days}d`,
        tone: days >= NEXT_MOVE_STUCK_DAYS ? "error" : "neutral",
      });
    }
  }
  if (facts.project) {
    out.push({
      kind: "project",
      label: facts.project.name,
      door: { kind: "project", id: facts.project.id },
      tone: "neutral",
    });
  }
  if (facts.track) {
    out.push({
      kind: "track",
      label: facts.track.name,
      door: { kind: "track", id: facts.track.id },
      tone: "neutral",
    });
  }
  return out;
}

const TIER_RANK: Record<NextMoveTier, number> = {
  answer: 0,
  start: 1,
  watch: 2,
};

/**
 * THE ranking. Tiers in {@link NEXT_MOVE_TIERS} order; inside `answer` and
 * `watch` the input order is kept (it is already the pod's rule for those
 * classes); inside `start` the score in the module header. Deterministic:
 * the same candidates rank the same on the pod and on every client.
 */
export function rankNextMoves(
  candidates: readonly NextMoveCandidate[],
  now: Date | number
): RankedNextMove[] {
  return candidates
    .map((c, index) => ({ c, index }))
    .sort((a, b) => {
      const tier = TIER_RANK[a.c.tier] - TIER_RANK[b.c.tier];
      if (tier !== 0) return tier;
      if (a.c.tier !== "start") return a.index - b.index;
      const fa = a.c.facts ?? {};
      const fb = b.c.facts ?? {};
      const unblocks = (fb.unblocks ?? 0) - (fa.unblocks ?? 0);
      if (unblocks !== 0) return unblocks;
      const draft =
        Number(fb.draftReady === true) - Number(fa.draftReady === true);
      if (draft !== 0) return draft;
      const sa = instant(fa.waitingSince);
      const sb = instant(fb.waitingSince);
      if (sa !== sb) {
        if (sa === null) return 1;
        if (sb === null) return -1;
        return sa - sb;
      }
      return a.index - b.index;
    })
    .map(({ c }) => ({
      tier: c.tier,
      row: c.row,
      reasons: c.tier === "start" ? nextMoveReasons(c.facts, now) : [],
    }));
}

// ── The start tier's wire ───────────────────────────────────────────────────

/**
 * One start-tier candidate as the pod sends it (`signals.list({ lens:
 * "page", picks: true })` → `page.picks.rows`, already ranked). Every field
 * is read from stored data; none is estimated.
 */
export interface NextMoveWire {
  /** Stable identity — `${door.kind}:${door.id}`; what a skip hides. */
  key: string;
  /** Object kind for the noun + icon (`task`, `session`). */
  objectKind: string;
  title: string;
  door: LensDoor;
  /** The verb that starts it: `start` (never begun) or `resume`. */
  action: "start" | "resume";
  /** Facts the score and the reason chips read. */
  unblocks: number;
  waitingSince: string | null;
  project: NextMoveContainer | null;
  track: NextMoveContainer | null;
  draftReady: boolean;
}

/** The page's start tier — present only when the read asked for it. */
export interface LensPagePicks {
  /** Ranked (`rankNextMoves`), skips already removed, capped. */
  rows: NextMoveWire[];
  /** More candidates exist than were scanned or sent. */
  truncated: boolean;
  /** Halves that FAILED. Non-empty ⇒ never "nothing to do". */
  unreadable: string[];
}

/**
 * A start-tier wire row as a lens row. `proposed` class: the machine offers
 * it and ignoring it costs nothing — quiet ink, a quiet verb. Its mark is the
 * shared unit state: never begun ⇒ not started; begun ⇒ quiet (paused).
 */
const NEXT_ROW_PREFIX = "next:";

/** The wire key (what a skip stores) of a start-tier row, else null. */
export function nextMoveKeyOfRow(row: Pick<LensRow, "key">): string | null {
  return row.key.startsWith(NEXT_ROW_PREFIX)
    ? row.key.slice(NEXT_ROW_PREFIX.length)
    : null;
}

export function lensRowOfNextMove(wire: NextMoveWire): LensRow {
  const state: UnitStateInput =
    wire.action === "start" ? { everStarted: false } : { idle: true };
  return {
    key: `${NEXT_ROW_PREFIX}${wire.key}`,
    cls: "proposed",
    state,
    objectKind: wire.objectKind,
    title: wire.title,
    reason: null,
    repeat: null,
    // The project / track are reason chips (doors) — never a second source.
    source: null,
    occurredAt: wire.waitingSince,
    verb: {
      action: wire.action,
      label: resolveActionLabel(wire.action, "imperative"),
    },
    door: wire.door,
    count: 1,
  };
}

export function nextMoveCandidateOfWire(wire: NextMoveWire): NextMoveCandidate {
  return {
    tier: "start",
    row: lensRowOfNextMove(wire),
    facts: {
      unblocks: wire.unblocks,
      waitingSince: wire.waitingSince,
      project: wire.project,
      track: wire.track,
      draftReady: wire.draftReady,
    },
  };
}
