/**
 * THE LENS HEADER MODEL (project · track · session — Home has its own top).
 *
 * ```
 * breadcrumb of scope
 * [identity] Title                                  ⋯ │ pulse (project / track)
 * goal — one muted line                         More │
 * [● Waiting on you · <the exact ask>   [Answer →]]  │ active 1h ago · Activity →
 * 9 need you · 57 delivered · 1 running · due 12 Oct
 * ```
 *
 * v2 (founder, 2026-10-05): the state lives on the NEXT MOVE row
 * (`nextMove`, {@link lensNextMove}) — ONE place for the one move, named by
 * the needs-you row's own verb — and every count is said ONCE, as a door
 * (`doors[].text`). `narrative` is the v1 line, kept only until relay mirrors
 * v2; the web header no longer draws it.
 *
 * A count of `null` is a FAILED or absent read — never zero. It drops out of
 * the narrative and its door shows no number, and it can never earn the
 * header's "All clear" mark (calm-confident-wrong is the bug this repo has
 * shipped three times).
 */

import {
  resolveUnitState,
  type UnitStateInput,
  type UnitStateView,
} from "../units/state.js";
import {
  readTrackKpi,
  trackStagesEmerged,
  type TrackKpi,
} from "../units/track.js";
import { resolveActionLabel, resolveStatusLabel } from "../vocabulary/index.js";
import { LENS_SECTION_LABELS } from "./classes.js";
import type { LensDoor, LensRow, LensVerb } from "./rows.js";
import type { LensScopeKind } from "./scope.js";
// The CP / IS action vocabulary — the same `AiAction` `ai-availability` re-exports.
import type { IsFailureAction as AiAction } from "../hub-protocol/index.js";

export interface LensCounts {
  blocking: number | null;
  happening: number | null;
  produced: number | null;
}

/**
 * The ONE scope fact each header kind carries. Typed per kind, so a project
 * header cannot be handed a step and a session header cannot be handed a date.
 */
export type LensScopeFact =
  | { kind: "target-date"; at: string | null }
  | { kind: "step"; index: number; total: number }
  | LensKpiFact
  | { kind: "criteria"; met: number; total: number };

/**
 * A track's KPI as its header fact (0302): "Qualified leads per month 6 / 10"
 * with a small bar. `current` is STATED, never measured — `statedAt` says
 * when, and a host shows it beside the number (never a bare "live" value).
 */
export interface LensKpiFact {
  kind: "kpi";
  label: string;
  unit: string | null;
  target: number;
  /** The stated value; null when nobody has stated one yet (no bar). */
  current: number | null;
  /** current / target, clamped to [0, 1]; null without a current value. */
  progress: number | null;
  /** ISO — when `current` was stated; null when never. */
  statedAt: string | null;
  reached: boolean;
}

export type LensScopeFactFor<K extends LensScopeKind> = K extends "project"
  ? Extract<LensScopeFact, { kind: "target-date" }>
  : K extends "track"
    ? Extract<LensScopeFact, { kind: "step" | "kpi" }>
    : K extends "session"
      ? Extract<LensScopeFact, { kind: "criteria" }>
      : never;

/**
 * Which fact a header of this scope kind carries — null for the pod / a space.
 * A track carries ONE of two, in this order: its KPI when it has one, else its
 * step ({@link lensTrackFact}).
 */
export const LENS_SCOPE_FACT_KIND = {
  pod: null,
  workspace: null,
  project: "target-date",
  track: ["kpi", "step"],
  session: "criteria",
} as const satisfies Record<
  LensScopeKind,
  LensScopeFact["kind"] | readonly LensScopeFact["kind"][] | null
>;

/**
 * Whether a lens of this scope kind carries the PULSE (the activity heatmap).
 * A session is a short-lived object, so a weeks-long heatmap of it says
 * nothing (founder, 2026-10-05): the session lens has NO pulse. The web kit
 * reads this and drops a pulse handed to a session header, so a host cannot
 * put one back.
 */
export const LENS_SCOPE_HAS_PULSE = {
  pod: true,
  workspace: true,
  project: true,
  track: true,
  session: false,
} as const satisfies Record<LensScopeKind, boolean>;

/** The fact's words, or null when the fact is a date (the host formats dates). */
export function lensScopeFactLabel(fact: LensScopeFact): string | null {
  if (fact.kind === "step") {
    return fact.total > 0
      ? `Step ${Math.min(fact.index, fact.total)} of ${fact.total}`
      : null;
  }
  if (fact.kind === "criteria") {
    return fact.total > 0 ? `${fact.met} of ${fact.total} met` : null;
  }
  if (fact.kind === "kpi") {
    return fact.current === null
      ? `${fact.label}: target ${withUnit(fmtNumber(fact.target), fact.unit)}`
      : `${fact.label} ${formatKpiFraction(fact.current, fact.target, fact.unit)}`;
  }
  return null;
}

function withUnit(value: string, unit: string | null | undefined): string {
  const u = unit?.trim();
  return u ? `${value} ${u}` : value;
}

/**
 * THE KPI fraction — "6 / 10 leads", or "6 / 10" when the KPI has no unit
 * (never a dangling space). One spelling for the track header and the
 * "target reached" notification.
 */
export function formatKpiFraction(
  current: number,
  target: number,
  unit?: string | null
): string {
  return withUnit(`${fmtNumber(current)} / ${fmtNumber(target)}`, unit);
}

/** A KPI number in words: integers plain, fractions to two places at most. */
function fmtNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

/** A track's KPI as its header fact; null when the track steers by no number. */
export function lensKpiFact(raw: TrackKpi | unknown): LensKpiFact | null {
  const kpi = readTrackKpi(raw);
  if (!kpi) return null;
  const current = typeof kpi.current === "number" ? kpi.current : null;
  return {
    kind: "kpi",
    label: kpi.label,
    unit: kpi.unit ?? null,
    target: kpi.target,
    current,
    progress:
      current === null
        ? null
        : kpi.target > 0
          ? Math.max(0, Math.min(1, current / kpi.target))
          : current >= kpi.target
            ? 1
            : 0,
    statedAt: current === null ? null : (kpi.updatedAt ?? null),
    reached: current !== null && current >= kpi.target,
  };
}

/**
 * THE track header's fact — one rule for browser and relay:
 *   1. the KPI, when the track steers by one;
 *   2. else "Step N of M" — but ONLY while the stages are the method's own.
 *      Once a stage has EMERGED (added to the running track) M is no longer a
 *      plan, just the count so far, so "Step 3 of 4" would promise an end the
 *      track never declared: the fact omits;
 *   3. else nothing (stageless, or standing on no pinned stage).
 */
export function lensTrackFact(track: {
  kpi?: unknown;
  stages: ReadonlyArray<{ key: string; addedAt?: string }>;
  currentStage: string | null | undefined;
}): Extract<LensScopeFact, { kind: "step" | "kpi" }> | null {
  const kpi = lensKpiFact(track.kpi);
  if (kpi) return kpi;
  if (trackStagesEmerged(track.stages)) return null;
  const at = track.currentStage
    ? track.stages.findIndex((s) => s.key === track.currentStage)
    : -1;
  return at >= 0
    ? { kind: "step", index: at + 1, total: track.stages.length }
    : null;
}

/** One part of the narrative line. `at` parts are formatted by the host's date door. */
export type LensNarrativePart =
  | { key: "produced" | "blocking" | "happening"; text: string }
  | { key: "last-activity"; at: string };

/** A count shown as a DOOR to its section. `count: null` = unknown (no number). */
export interface LensCountDoor {
  section: "blocking" | "happening" | "produced";
  label: string;
  count: number | null;
  /**
   * The strip's words — "9 need you" · "57 delivered" · "1 running"; the
   * section's label alone when the count is unknown. The ONE place a count
   * is said (v2: the narrative no longer repeats it).
   */
  text: string;
}

/**
 * THE NEXT MOVE — the one row under the title that says what matters most
 * right now: the FIRST Blocking row's exact ask, else the first Happening
 * row's now-line. Absent ⇒ the row OMITS and the host's "Start work" takes
 * the primary slot.
 */
export interface LensNextMove {
  section: "blocking" | "happening";
  /** The row's own unit state — the mark and the row's tint. */
  state: UnitStateView;
  /** The reason word, from the status vocabulary ("Waiting on you" / "Working"). */
  reason: string;
  /** The exact ask (a Blocking row's title) or the agent's now-line. */
  text: string;
  /**
   * The ONE filled verb: a Blocking row's OWN verb (Approve / Answer /
   * Review — `lensRowOfNeedsYou`), never "Open" for an ask; "Open" only for
   * work in flight (it can only be watched) or a failed run.
   */
  verb: LensVerb;
  /** Where the verb opens. Null ⇒ no button (nothing addressable). */
  door: LensDoor | null;
}

/**
 * A lens row as the header's next move — Blocking or Happening rows only
 * (anything else is not a move). Reads the row's own words; derives none.
 */
export function lensNextMove(
  row: LensRow | null | undefined
): LensNextMove | null {
  if (!row || (row.cls !== "blocking" && row.cls !== "happening")) return null;
  const text =
    (row.cls === "happening" ? row.reason?.trim() : null) || row.title.trim();
  if (!text) return null;
  const blocking = row.cls === "blocking";
  // A notification row in Blocking carries no verb of its own (the row is
  // the door): it is still an ask, so it reads "Review", never "Open".
  const action = blocking ? (row.verb?.action ?? "review") : "open";
  return {
    section: row.cls,
    state: resolveUnitState(row.state),
    reason: resolveStatusLabel(blocking ? "waiting_on_you" : "working"),
    text,
    verb:
      blocking && row.verb
        ? row.verb
        : { action, label: resolveActionLabel(action, "imperative") },
    door: row.door,
  };
}

/** The strip's words for one count door. */
function countDoorText(
  section: LensCountDoor["section"],
  count: number | null
): string {
  if (count === null) return LENS_SECTION_LABELS[section];
  if (section === "blocking")
    return `${count} ${count === 1 ? "needs" : "need"} you`;
  if (section === "produced") return `${count} delivered`;
  return `${count} running`;
}

export interface LensHeaderModel {
  /** The scope kind this header is for (decides e.g. whether it has a pulse). */
  scopeKind: Exclude<LensScopeKind, "pod">;
  /** The scope's aggregate state (v1 drew it before the title; v2 hosts may badge with it). */
  state: UnitStateView;
  /**
   * @deprecated v1 line ("3 delivered · 1 waiting on you · …") — it said
   * every count twice. Kept only until relay mirrors v2; read `nextMove`,
   * `doors[].text` and `lastActivityAt` instead.
   */
  narrative: LensNarrativePart[];
  /** The counts strip, in reading order: Needs you · Produced · Happening. */
  doors: LensCountDoor[];
  /** The ONE move (see {@link LensNextMove}); null ⇒ the row omits. */
  nextMove: LensNextMove | null;
  /** The newest activity (ISO) — "active 1h ago" — or null when unknown. */
  lastActivityAt: string | null;
  /** The REASSURE mark: blocking was READ and is zero. */
  allClear: boolean;
  fact: LensScopeFact | null;
}

function iso(at: string | Date | null | undefined): string | null {
  if (!at) return null;
  const d = at instanceof Date ? at : new Date(at);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

export function lensHeaderModel<
  K extends Exclude<LensScopeKind, "pod">,
>(input: {
  scopeKind: K;
  state: UnitStateInput;
  counts: LensCounts;
  lastActivityAt?: string | Date | null;
  fact?: LensScopeFactFor<K> | null;
  /**
   * @deprecated v1 — the narrative's lead text (relay, until it mirrors v2).
   * v2 hosts pass `nextMove`.
   */
  lead?: { section: "blocking" | "happening"; text: string } | null;
  /**
   * The row the NEXT MOVE is made of: the first Blocking row (its exact
   * ask + its own verb), else the first Happening row — `lensNextMoveRow`
   * picks it from the page read. Absent / null ⇒ no next-move row.
   */
  nextMove?: LensRow | null;
}): LensHeaderModel {
  const { counts } = input;
  const lead = input.lead?.text.trim() ? input.lead : null;
  const narrative: LensNarrativePart[] = [];
  if (lead) narrative.push({ key: lead.section, text: lead.text.trim() });
  if (counts.produced)
    narrative.push({ key: "produced", text: `${counts.produced} delivered` });
  if (counts.blocking && lead?.section !== "blocking") {
    narrative.push({
      key: "blocking",
      text: `${counts.blocking} waiting on you`,
    });
  }
  if (counts.happening && lead?.section !== "happening") {
    narrative.push({
      key: "happening",
      text: `${counts.happening} in progress`,
    });
  }
  const last = iso(input.lastActivityAt);
  if (last) narrative.push({ key: "last-activity", at: last });

  // A door to a section that is not on the page is a dead door: a READ zero
  // omits its section, so it omits its door too ("Happening 0" pointed at
  // nothing). An unknown count (null) keeps its door — that section still
  // draws, failed, with its retry.
  const doors: LensCountDoor[] = (
    ["blocking", "produced", "happening"] as const
  )
    .filter((section) => counts[section] !== 0)
    .map((section) => ({
      section,
      label: LENS_SECTION_LABELS[section],
      count: counts[section],
      text: countDoorText(section, counts[section]),
    }));

  return {
    scopeKind: input.scopeKind,
    state: resolveUnitState(input.state),
    narrative,
    doors,
    nextMove: lensNextMove(input.nextMove),
    lastActivityAt: last,
    // Never "All clear" beside a "Waiting on you" move: a session's own ask
    // (a grade owed) can exist where the pod's needs-you union counts zero.
    allClear: counts.blocking === 0 && input.nextMove?.cls !== "blocking",
    fact: input.fact ?? null,
  };
}

// ── The ONE status banner ───────────────────────────────────────────────────

/** Worst first: `error` (blocked) › `warning` (heads-up, e.g. low credits) › `info` (an operator condition). */
export type LensBannerTone = "error" | "warning" | "info";

const BANNER_TONE_RANK: { readonly [T in LensBannerTone]: number } = {
  error: 0,
  warning: 1,
  info: 2,
};

/**
 * The banner's ONE CTA (an AI availability state's `action`,
 * `@synap-core/types/ai-availability`). Absent ⇒ no CTA — operator states
 * never carry one.
 */
export interface LensBannerAction {
  kind: AiAction;
  /** Imperative-mood label (`resolveActionLabel(kind)`). */
  label: string;
}

export interface LensBannerInput {
  /** Dedup key — the failing service / condition, not the notification id. */
  key: string;
  tone: LensBannerTone;
  title: string;
  occurredAt?: string | Date | null;
  /** Where the condition is looked at (the banner's door). */
  target?: LensDoor | null;
  /** The notifications behind it — dismissing the banner marks them read. */
  notificationIds?: readonly string[];
  /** The banner's one CTA, when the condition has one. */
  action?: LensBannerAction | null;
}

export interface LensBanner {
  key: string;
  tone: LensBannerTone;
  title: string;
  /** Other distinct conditions folded under it ("+2 more"). */
  more: number;
  /** The lead condition's door, when it has one. */
  target: LensDoor | null;
  /** EVERY folded condition's notifications: one dismiss clears the banner. */
  notificationIds: string[];
  /** The lead condition's CTA; absent / null ⇒ no CTA. Optional so a host-built banner literal stays valid. */
  action?: LensBannerAction | null;
}

/**
 * System health is ONE banner, never Needs-you rows: dedupe by `key`, lead
 * with the worst tone (error › warning › info), newest first within a tone. Null
 * when nothing is wrong.
 */
export function lensStatusBanner(
  inputs: readonly LensBannerInput[]
): LensBanner | null {
  const byKey = new Map<string, LensBannerInput>();
  const time = (b: LensBannerInput) => {
    const t = b.occurredAt ? new Date(b.occurredAt).getTime() : Number.NaN;
    return Number.isFinite(t) ? t : 0;
  };
  for (const b of inputs) {
    const prev = byKey.get(b.key);
    if (!prev || time(b) > time(prev)) byKey.set(b.key, b);
  }
  const all = [...byKey.values()].sort((a, b) => {
    if (a.tone !== b.tone)
      return BANNER_TONE_RANK[a.tone] - BANNER_TONE_RANK[b.tone];
    return time(b) - time(a);
  });
  const lead = all[0];
  if (!lead) return null;
  return {
    key: lead.key,
    tone: lead.tone,
    title: lead.title,
    more: all.length - 1,
    target: lead.target ?? null,
    action: lead.action ?? null,
    notificationIds: [
      ...new Set(inputs.flatMap((b) => [...(b.notificationIds ?? [])])),
    ],
  };
}
