/**
 * THE marks of a goal — one derivation for the desk and the phone.
 *
 * A goal (a track, `TrackView`) wears marks that are not unit-of-work states:
 * its lifecycle status with how it ended (the verdict), "In review", "Waiting
 * on …", one mark per criterion, the kind of check a criterion is, the kind
 * of work, a delegate's commitment and their silence. Each mark here is the
 * same shape a `UnitMark` draws — a TONE TOKEN, a GLYPH NAME and its WORDS —
 * never a colour and never a sentence (ui-composition §1, §10).
 *
 * The words come from the vocabulary door only (`resolveTrack*Label`,
 * `resolveGoal*Label`, …), so the words W5 lands ("Goal", "Aim") change
 * nothing here.
 *
 * ── The glyph list ─────────────────────────────────────────────────────────
 * `GoalGlyph` EXTENDS `UnitGlyph` (`@synap-core/types/units`): the unit
 * glyphs are reused where one fits (check, scales, pause, clock…), and the
 * goal adds the few it needs below. Web draws them in `UnitMark`
 * (`@synap-core/web/lens-page`), relay mirrors the same names. The list sits
 * here, not beside `UnitGlyph` in types, because this lane is synap-app only;
 * moving it into types is a one-file follow-up that changes no reader.
 *
 * PURE: no React, no DOM.
 */
import type { UnitGlyph, UnitTone } from "../units/index.js";
import {
  trackStatusCategory,
  type GoalCriterionMark,
  type TrackCommitmentState,
  type TrackVerdict,
  type TrackWorkKind,
  type TrackUncertainty,
  type CriterionCheckMeaning,
} from "../units/index.js";
import {
  LIFECYCLE_CATEGORY_TONE,
  parseHoldDevRef,
  parseHoldMovesRef,
  type LifecycleCategory,
  type RecordedHold,
} from "../lifecycle/index.js";
import type { LensDoor } from "../lens/index.js";
import { isHttpUrl } from "../navigation/index.js";
import { formatElapsed, formatUntil } from "../value-format/index.js";
import {
  nounInSentence,
  resolveCriterionCheckMeaningLabel,
  resolveObjectNoun,
  resolveGoalCriterionMarkLabel,
  resolveOperationPeriodMarkLabel,
  resolveStatusLabel,
  resolveTrackCommitmentStateLabel,
  resolveTrackStatusLabel,
  resolveTrackUncertaintyLabel,
  resolveTrackVerdictLabel,
  resolveTrackWorkKindLabel,
  resolveWaitingOnReasonLabel,
  trackSilenceLabel,
} from "../vocabulary/index.js";

/** The glyphs a goal adds to the unit glyphs — every renderer maps each one. */
export const GOAL_EXTRA_GLYPHS = [
  "half",
  "circle-dot",
  "x",
  "circle-slash",
  "archive",
  "hourglass",
  "gauge",
  "handover",
  "lightbulb",
  "flag",
  "certified",
  "triangle",
  "flow",
  "repeat",
  "search",
  "siren",
  "scissors",
  "route",
  "counter",
  "silent",
] as const;
export type GoalExtraGlyph = (typeof GOAL_EXTRA_GLYPHS)[number];

/** Every glyph a goal mark may wear: the unit glyphs plus the goal's own. */
export type GoalGlyph = UnitGlyph | GoalExtraGlyph;

/**
 * One goal mark, in the shape `UnitMark` draws. `state` is the machine token
 * the mark stands for (a status, a mark, a verdict) — a data attribute, never
 * shown; `label` is the words, always from the vocabulary door.
 */
export interface GoalMarkView {
  state: string;
  tone: UnitTone;
  glyph: GoalGlyph;
  label: string;
  /**
   * How many, when the mark stands for several ("Waiting on approval" for 2).
   * Never spelled into `label`: a renderer draws it in its count slot (web
   * `SpatialCount`, relay `RelayCount`). Absent = say no number.
   */
  count?: number;
}

// ── status + verdict ───────────────────────────────────────────────────────

const CATEGORY_GLYPH: Record<LifecycleCategory, GoalGlyph> = {
  open: "dashed-circle",
  active: "circle-dot",
  paused: "pause",
  done: "check",
  lost: "circle-slash",
};

/**
 * How a goal ENDED outranks its category for the mark: "Closed · Not met" in
 * the done category's success tone would read as a win. Keyed by every
 * verdict, so a new verdict stops the build until it has a mark.
 */
const VERDICT_MARK: Record<TrackVerdict, { tone: UnitTone; glyph: GoalGlyph }> =
  {
    met: { tone: "success", glyph: "check" },
    partly_met: { tone: "warning", glyph: "half" },
    not_met: { tone: "error", glyph: "x" },
    retired: { tone: "textSecondary", glyph: "archive" },
    no_longer_needed: { tone: "textMuted", glyph: "circle-slash" },
    impossible: { tone: "error", glyph: "circle-slash" },
    replaced: { tone: "textMuted", glyph: "circle-slash" },
    mistake: { tone: "textMuted", glyph: "circle-slash" },
  };

/**
 * THE status chip of a goal: its lifecycle status in the goal's words
 * ("Active", "Closed", "Dropped"), and — once it ended — how ("Closed · Met").
 * Tone = the lifecycle category's (`LIFECYCLE_CATEGORY_TONE`, the rule every
 * kind's status uses), unless a verdict says how it ended. An unknown status
 * humanizes and wears the muted question mark, never a blank.
 */
export function goalStatusMark(goal: {
  status: string;
  verdict?: string | null;
}): GoalMarkView {
  const category = trackStatusCategory(goal.status);
  const statusWord = resolveTrackStatusLabel(goal.status);
  if (!category) {
    return {
      state: goal.status,
      tone: "textMuted",
      glyph: "question",
      label: statusWord,
    };
  }
  const verdict =
    (category === "done" || category === "lost") &&
    goal.verdict &&
    Object.hasOwn(VERDICT_MARK, goal.verdict)
      ? (goal.verdict as TrackVerdict)
      : null;
  if (verdict) {
    return {
      state: goal.status,
      ...VERDICT_MARK[verdict],
      label: `${statusWord} · ${resolveTrackVerdictLabel(verdict)}`,
    };
  }
  return {
    state: goal.status,
    tone: LIFECYCLE_CATEGORY_TONE[category],
    glyph: CATEGORY_GLYPH[category],
    label: statusWord,
  };
}

// ── marks inside Active: in review, waiting on ─────────────────────────────

/**
 * "In review" — every required criterion claimed, none accepted yet (derived
 * by the pod, `TrackView.inReview`). The judge's turn: the your-turn tone,
 * the half-ring.
 */
export const IN_REVIEW_MARK: GoalMarkView = {
  state: "in_review",
  tone: "primary",
  glyph: "half",
  label: resolveStatusLabel("in_review"),
};

/**
 * One thing a "Waiting on …" mark names, as the pod sends it
 * (`WaitingOnMark.refs`, at most 5): the session, PR, person or decision. The
 * field is optional on the wire — an older pod names nothing, and the mark
 * then carries only its reason and count.
 */
export interface WaitingOnRefInput {
  kind: string;
  id?: string | null;
  url?: string | null;
  label: string;
}

/** A named thing, ready to draw: a door to its own page, an outside link, or (neither) just its name. */
export interface WaitingOnRefView {
  key: string;
  label: string;
  /** The object it opens (through the host's `onOpen`). */
  door: LensDoor | null;
  /** An outside page (a PR on GitHub), only an http(s) one. */
  url: string | null;
}

/** A "Waiting on …" mark, and what it waits on by name (empty when the pod named nothing). */
export interface WaitingOnMarkView extends GoalMarkView {
  reason: string;
  refs: readonly WaitingOnRefView[];
}

/**
 * The page a ref opens. A slot has no page of its own: its id is the session
 * that declares it. A person, a decision or a thing is an entity. A kind this
 * build does not know opens nothing — its name is still said.
 */
const REF_DOOR_KIND: Readonly<Record<string, string>> = {
  session: "session",
  slot: "session",
  proposal: "proposal",
  person: "entity",
  decision: "entity",
  thing: "entity",
};

export function waitingOnRefView(
  ref: WaitingOnRefInput,
  index: number
): WaitingOnRefView {
  const doorKind = Object.hasOwn(REF_DOOR_KIND, ref.kind)
    ? REF_DOOR_KIND[ref.kind]!
    : null;
  const door = doorKind && ref.id ? { kind: doorKind, id: ref.id } : null;
  return {
    key: `${ref.kind}:${ref.id ?? ref.url ?? index}`,
    label: ref.label,
    door,
    url: !door && isHttpUrl(ref.url) ? ref.url : null,
  };
}

/**
 * One "Waiting on …" mark per reason the pod found (`TrackView.waitingOn`,
 * `statusOf.waitingOn`), in the pod's order. A mark, never a status: the goal
 * stays Active. The reason is the words; how many rides `count`, set only when
 * more than one; what it waits on by name rides `refs`.
 */
export function waitingOnMarks(
  waitingOn:
    | ReadonlyArray<{
        reason: string;
        count: number;
        refs?: readonly WaitingOnRefInput[] | null;
      }>
    | null
    | undefined
): WaitingOnMarkView[] {
  return (waitingOn ?? [])
    .filter((w) => w.count > 0)
    .map((w) => ({
      state: `waiting_on_${w.reason}`,
      tone: "textSecondary",
      glyph: "hourglass",
      label: `Waiting on ${resolveWaitingOnReasonLabel(w.reason).toLowerCase()}`,
      ...(w.count > 1 ? { count: w.count } : {}),
      reason: w.reason,
      refs: (w.refs ?? []).map(waitingOnRefView),
    }));
}

/** A mark from {@link waitingOnMarks} (it carries its reason and refs). */
export function isWaitingOnMark(mark: GoalMarkView): mark is WaitingOnMarkView {
  return "reason" in mark && Array.isArray((mark as WaitingOnMarkView).refs);
}

/** The pages a hold's `until.moves` may name, as object nouns. */
const HOLD_SUBJECT_NOUN: Readonly<Record<string, string>> = {
  focus_session: "session",
  track: "track",
  entity: "entity",
};

/** What resumes a hold on a dev fact (`pr:` / `main:` / `job:`), or null when `moves` names none. */
function devHoldResumes(
  moves: string,
  to: string | null | undefined
): string | null {
  const dev = parseHoldDevRef(moves);
  if (!dev) return null;
  switch (dev.kind) {
    case "pr": {
      const pr = `${dev.repo.split("/").pop()}#${dev.number}`;
      return to === "closed"
        ? `resumes when ${pr} is closed`
        : `resumes when ${pr} merges`;
    }
    case "main":
      return `resumes when ${dev.repo.split("/").pop()} main is green`;
    case "job":
      return to === "passed"
        ? `resumes when job ${dev.name} passes`
        : to === "failed"
          ? `resumes when job ${dev.name} fails`
          : `resumes when job ${dev.name} finishes`;
  }
}

/**
 * The hold line under a waiting mark: why (the mover's own words), for how
 * long, and what resumes it — "Review slot frees up · for 3h · resumes
 * tomorrow", "for 2h · resumes when backend#539 merges". `null` when the hold
 * says none of it. The status words come from the vocabulary; the times from
 * the one value format.
 */
export function holdLine(
  hold: Pick<RecordedHold, "since" | "until" | "reason"> | null | undefined,
  now: number = Date.now()
): string | null {
  if (!hold) return null;
  const parts: string[] = [];
  const reason = hold.reason?.trim();
  if (reason) parts.push(reason);
  const held = formatElapsed(hold.since, now);
  if (held) parts.push(`for ${held}`);
  const until = hold.until;
  if (until && "date" in until) {
    const when = formatUntil(until.date, now);
    if (when) parts.push(`resumes ${when}`);
  } else if (until && "moves" in until) {
    const dev = devHoldResumes(until.moves, until.to);
    if (dev) parts.push(dev);
    else {
      const subject = parseHoldMovesRef(until.moves);
      const noun = nounInSentence(
        resolveObjectNoun(
          HOLD_SUBJECT_NOUN[subject?.subjectType ?? ""] ?? "entity"
        )
      );
      const to = until.to
        ? ` to ${resolveStatusLabel(until.to).toLowerCase()}`
        : "";
      parts.push(`resumes when the ${noun} moves${to}`);
    }
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

// ── criteria ───────────────────────────────────────────────────────────────

const CRITERION_MARK: Record<
  GoalCriterionMark,
  { tone: UnitTone; glyph: GoalGlyph }
> = {
  met: { tone: "success", glyph: "check" },
  // The judge's turn — the same tone and half-ring as "In review".
  claimed: { tone: "primary", glyph: "half" },
  under_way: { tone: "info", glyph: "circle-dot" },
  not_met: { tone: "error", glyph: "x" },
  not_started: { tone: "textMuted", glyph: "dashed-circle" },
};

/**
 * One criterion's mark. `null` = the pod could not read the goal's runs (a
 * write's fallback view): the unmeasured mark, never a guessed "Not started".
 */
export function criterionMark(mark: string | null): GoalMarkView {
  if (mark === null || !Object.hasOwn(CRITERION_MARK, mark)) {
    return {
      state: mark ?? "unmeasured",
      tone: "textMuted",
      glyph: "question",
      label:
        mark === null
          ? resolveStatusLabel("unmeasured")
          : resolveGoalCriterionMarkLabel(mark),
    };
  }
  return {
    state: mark,
    ...CRITERION_MARK[mark as GoalCriterionMark],
    label: resolveGoalCriterionMarkLabel(mark),
  };
}

// ── an operation's week (R6) ───────────────────────────────────────────────

const PERIOD_MARK: Record<
  "met" | "not_met" | "unmeasured",
  { tone: UnitTone; glyph: GoalGlyph }
> = {
  met: { tone: "success", glyph: "check" },
  not_met: { tone: "error", glyph: "x" },
  // Not checked this week: the unmeasured mark, never a guessed miss.
  unmeasured: { tone: "textMuted", glyph: "question" },
};

/** An operation's week as a mark ("Met" / "Not met" / "Not checked") — the criterion marks' tones. */
export function periodMark(
  mark: "met" | "not_met" | "unmeasured"
): GoalMarkView {
  return {
    state: `period_${mark}`,
    ...PERIOD_MARK[mark],
    label: resolveOperationPeriodMarkLabel(mark),
  };
}

const CHECK_MEANING_GLYPH: Record<CriterionCheckMeaning, GoalGlyph> = {
  measured: "gauge",
  judged: "scales",
  handed_over: "handover",
  learning: "lightbulb",
  decided_outside: "flag",
  certified: "certified",
};

/** How a criterion is decided (R5) — a quiet glyph + its words. */
export function checkMeaningMark(meaning: string): GoalMarkView {
  return {
    state: meaning,
    tone: "textSecondary",
    glyph: Object.hasOwn(CHECK_MEANING_GLYPH, meaning)
      ? CHECK_MEANING_GLYPH[meaning as CriterionCheckMeaning]
      : "question",
    label: resolveCriterionCheckMeaningLabel(meaning),
  };
}

// ── kind of work, uncertainty ──────────────────────────────────────────────

const WORK_KIND_GLYPH: Record<TrackWorkKind, GoalGlyph> = {
  project: "triangle",
  flow: "flow",
  operation: "repeat",
  investigation: "search",
  incident: "siren",
  commission: "scissors",
  pathway: "route",
};

/** The kind of work a goal is (decision 4) — a badge, glyph + word. */
export function workKindMark(kind: string): GoalMarkView {
  return {
    state: kind,
    tone: "textSecondary",
    glyph: Object.hasOwn(WORK_KIND_GLYPH, kind)
      ? WORK_KIND_GLYPH[kind as TrackWorkKind]
      : "question",
    label: resolveTrackWorkKindLabel(kind),
  };
}

/** How many of the four cells an uncertainty level fills; `unknown` fills none. */
const UNCERTAINTY_LEVEL: Record<TrackUncertainty, number> = {
  clear: 1,
  complicated: 2,
  complex: 3,
  chaotic: 4,
  unknown: 0,
};

export const UNCERTAINTY_CELLS = 4;

/** How well the way is known — `level` of {@link UNCERTAINTY_CELLS} cells, plus its word. */
export interface UncertaintyView {
  value: string;
  level: number;
  label: string;
}

export function uncertaintyView(value: string): UncertaintyView {
  return {
    value,
    level: Object.hasOwn(UNCERTAINTY_LEVEL, value)
      ? UNCERTAINTY_LEVEL[value as TrackUncertainty]
      : 0,
    label: resolveTrackUncertaintyLabel(value),
  };
}

// ── commitments ────────────────────────────────────────────────────────────

const COMMITMENT_MARK: Record<
  TrackCommitmentState,
  { tone: UnitTone; glyph: GoalGlyph }
> = {
  proposed: { tone: "textSecondary", glyph: "clock" },
  accepted: { tone: "info", glyph: "circle-dot" },
  countered: { tone: "warning", glyph: "counter" },
  declined: { tone: "textMuted", glyph: "circle-slash" },
  reported_impossible: { tone: "error", glyph: "alert" },
  done: { tone: "success", glyph: "check" },
};

/** A delegate's commitment state ("Asked", "Accepted", …). */
export function commitmentMark(state: string): GoalMarkView {
  const known = Object.hasOwn(COMMITMENT_MARK, state)
    ? COMMITMENT_MARK[state as TrackCommitmentState]
    : null;
  return {
    state,
    tone: known?.tone ?? "textMuted",
    glyph: known?.glyph ?? "question",
    label: resolveTrackCommitmentStateLabel(state),
  };
}

/**
 * "Silent 6 h" — a delegate who still owes the goal something and has said
 * nothing for an hour or more (`trackSilenceLabel`). Never "stale": stale
 * means an unreadable session. `null` when not silent.
 */
export function silenceMark(
  silentSince: string | null | undefined,
  now: Date = new Date()
): GoalMarkView | null {
  const label = trackSilenceLabel(silentSince ?? null, now);
  return label
    ? { state: "silent", tone: "warning", glyph: "silent", label }
    : null;
}
