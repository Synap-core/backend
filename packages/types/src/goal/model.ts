/**
 * THE goal display model — one reading of a goal (`TrackView`, `tracks.get`)
 * for the desk and the phone: the header facts, the "Done when" rows and
 * their count, the "Who's on it" rows, the status moves this viewer may make
 * and the verdicts a close may carry.
 *
 * Nothing here decides a rule. Every rule is the pod's, shared through
 * `@synap-core/types/units`: the criterion marks are derived by the pod
 * (`deriveGoalCriteria`), the judge is `goalJudge`, the moves are
 * `trackStatusMoves`, the verdicts `trackVerdictsFor`, the close check
 * `checkTrackClose`, the commitment moves `commitmentMoveRefusal`. This
 * module only arranges them for one VIEWER.
 *
 * ── Why the criteria rows are not `ScorecardRow` ───────────────────────────
 * The session scorecard (`deriveScorecard`, `../session-continuation`)
 * RECOMPUTES a pass · fail · unmeasured verdict per criterion from the
 * session's evaluations, client-side. A goal criterion's state is already
 * derived by the pod across every run of the goal, with five marks (met ·
 * claimed · under way · not met · not started) and a separate acceptance (R2).
 * Mapping it onto pass/fail would lose "claimed" and "under way", and
 * recomputing it here would fork the pod's rule. So the goal row keeps the
 * scorecard row's identity fields (`key`, `statement`, `required` — the same
 * names and meaning) and carries the goal's own state beside them.
 *
 * PURE: no React, no DOM, no fetching.
 */
import {
  readEvidenceDetail,
  type ScorecardRow,
} from "../focus-sessions/scorecard.js";
import {
  checkTrackClose,
  commitmentMoveRefusal,
  goalJudge,
  goalMayDrop,
  goalOwner,
  isTrackClosed,
  mayStaffGoal,
  trackStatusCategory,
  trackStatusMoves,
  trackVerdictsFor,
  TRACK_COMMITMENT_MOVE_KEYS,
  TRACK_VERDICTS_NEEDING_REASON,
  OUTSIDE_DECIDED_MEANINGS,
  type GoalCriterionClaim,
  type GoalCriterionView,
  type TrackCommitmentMove,
  type TrackParticipant,
  type TrackStatus,
  type TrackStatusVerb,
  type TrackVerdict,
  type WaitingOnMark,
} from "../units/index.js";
import { lensScopeFactLabel, type LensRow } from "../lens/index.js";
import {
  humanizeToken,
  resolveActionLabel,
  resolveGoalAcceptanceLabel,
  resolveGoalCriterionMarkLabel,
  resolveObjectNoun,
  resolveTrackMoveLabel,
  resolveTrackParticipantRoleLabel,
  resolveTrackVerdictLabel,
} from "../vocabulary/index.js";
import {
  checkMeaningMark,
  commitmentMark,
  criterionMark,
  goalStatusMark,
  IN_REVIEW_MARK,
  silenceMark,
  uncertaintyView,
  waitingOnMarks,
  workKindMark,
  type GoalMarkView,
  type UncertaintyView,
} from "./marks.js";

// ── input ──────────────────────────────────────────────────────────────────

/**
 * The fields of a goal this model reads — structural, so the pod's
 * `TrackView` (`@synap-core/api-types`) and the sample world both fit
 * without a cast. `null` on a derived field = "not read" (a write's fallback
 * view), never a guess; `participants` absent = not read.
 */
export interface GoalLike {
  id: string;
  name: string;
  status: string;
  verdict: string | null;
  verdictReason: string | null;
  verdictBy?: string | null;
  verdictAt?: string | null;
  direction: string | null;
  endState: string | null;
  criteria: readonly GoalCriterionLike[];
  dropConditions: readonly string[];
  workKind: string | null;
  uncertainty: string | null;
  kindConfirmedBy: string | null;
  kindConfirmedAt?: string | null;
  inReview: boolean | null;
  waitingOn: readonly WaitingOnMark[] | null;
  participants?: readonly TrackParticipant[];
  /**
   * An operation's reading for this week (R6) — `null` for other kinds;
   * absent on a pod older than the reading. Never a percent.
   */
  periodReading?: { from: string; to: string; mark: string } | null;
}

/**
 * A criterion as a goal read carries it — the pod's view. `claim` may be
 * absent: a pod older than the claim (Additions A2) sends none, and that
 * reads as nothing to show, never as an error.
 */
export type GoalCriterionLike = Omit<GoalCriterionView, "claim"> & {
  claim?: GoalCriterionClaim | null;
};

/**
 * Who is looking. `userId` = the viewer's own user id (an agent's own row for
 * an agent); `null` when the host does not know it — the viewer then holds no
 * role, so no judge or delegate verb is offered (never a guessed identity).
 */
export interface GoalViewer {
  userId: string | null;
  kind: "person" | "agent";
}

/**
 * A FALLBACK name for a participant the read did not name. The pod names
 * every participant on the goal read (`TrackParticipant.displayName`, the
 * shared actor-name rule), and that name always wins; hosts need not look
 * names up in a roster. `null` ⇒ the row says the role, never an invented
 * name.
 */
export type GoalNameOf = (principalId: string) => string | null | undefined;

// ── who holds which role ───────────────────────────────────────────────────

/** The owner and the judge by id, through the one rule — `null` when participants were not read. */
export function goalRoles(goal: Pick<GoalLike, "participants">): {
  ownerId: string | null;
  judgeId: string | null;
} {
  if (!goal.participants) return { ownerId: null, judgeId: null };
  // `goalOwner` falls back to the starter (`track.userId`); a TrackView does
  // not carry it, so an absent owner row reads as unknown ('' → null).
  const ownerId = goalOwner(goal.participants, { userId: "" }) || null;
  const judgeId = goalJudge(goal.participants, { userId: "" }) || null;
  return { ownerId, judgeId };
}

/** The viewer is the goal's judge, as a person (an agent never judges — R9). */
export function viewerIsJudge(
  goal: Pick<GoalLike, "participants">,
  viewer: GoalViewer
): boolean {
  if (viewer.kind !== "person" || !viewer.userId) return false;
  return goalRoles(goal).judgeId === viewer.userId;
}

/** The viewer may staff the goal and acknowledge reports: its owner or judge, as a person. */
export function viewerMayStaff(
  goal: Pick<GoalLike, "participants">,
  viewer: GoalViewer
): boolean {
  if (viewer.kind !== "person" || !viewer.userId || !goal.participants)
    return false;
  return mayStaffGoal(goal.participants, { userId: "" }, viewer.userId);
}

/**
 * The viewer may DROP the goal (a move into lost, with a verdict) — the ONE
 * place a surface asks it (the status moves, the Declare done bar). The rule
 * is the pod's, `goalMayDrop` (owner or judge, as a person). An agent's drop
 * would only PROPOSE: no surface offers it one (the declaration stays human —
 * R9), so "proposes" reads as no here. Participants not read ⇒ no.
 */
export function viewerMayDrop(
  goal: Pick<GoalLike, "participants">,
  viewer: GoalViewer
): boolean {
  if (!goal.participants) return false;
  return (
    goalMayDrop({
      // A TrackView carries no starter id; the owner row stands for it (as `goalRoles`).
      track: { userId: "" },
      participants: goal.participants,
      viewerId: viewer.userId,
      viewerIsAgent: viewer.kind === "agent",
    }) === "allowed"
  );
}

/** What a person's act unblocks — "Other work" and "Outside world" are nobody's here. */
const WAITS_ON_A_PERSON = new Set(["input", "approval", "access"]);

/** The goal wears a "Waiting on …" mark: some reason it waits on still counts (`waitingOnMarks` drops a zero). */
export function goalIsWaiting(goal: Pick<GoalLike, "waitingOn">): boolean {
  return (goal.waitingOn ?? []).some((w) => w.count > 0);
}

/**
 * The goal waits on THIS person: they own or judge it and it waits on input,
 * an approval or access (a person's act — the pod derives these from slots
 * owed by a person and pending proposals), or they were asked to take part
 * and have not answered. The ONE "waiting on you" rule for the goals list's
 * order and the "This week" proposal.
 */
export function goalWaitsOnViewer(
  goal: Pick<GoalLike, "waitingOn" | "participants">,
  viewerId: string | null
): boolean {
  if (!viewerId) return false;
  const { ownerId, judgeId } = goalRoles(goal);
  const mine = ownerId === viewerId || judgeId === viewerId;
  const waits = (goal.waitingOn ?? []).some(
    (w) => w.count > 0 && WAITS_ON_A_PERSON.has(w.reason)
  );
  const asked = (goal.participants ?? []).some(
    (p) =>
      p.principalId === viewerId &&
      p.role === "delegate" &&
      p.commitmentState === "proposed"
  );
  return (mine && waits) || asked;
}

// ── header ─────────────────────────────────────────────────────────────────

export interface GoalPersonFact {
  id: string;
  name: string | null;
  /** The role words ("Owner", "Judge", "Owner and judge") — `goalRoleWords`. */
  role: string;
  /** The fact as one reads it: "Owner and judge: Camille Laurent". `null` when unnamed (left out). */
  label: string | null;
}

/**
 * The words for the roles one principal holds — the ONE derivation the
 * header ("Owner and judge: …") and "Who's on it" ("Owner and judge") both
 * read: role order, from the vocabulary, joined as a reader says it.
 */
export function goalRoleWords(
  roles: readonly TrackParticipant["role"][]
): string {
  const words = ROLE_ORDER.filter((r) => roles.includes(r)).map((r, i) => {
    const word = resolveTrackParticipantRoleLabel(r);
    return i === 0 ? word : word.toLowerCase();
  });
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

export interface GoalHeaderView {
  /** The status chip, with the verdict once it ended ("Closed · Met"). */
  status: GoalMarkView;
  /** Marks inside Active: "In review", then one "Waiting on …" per reason. */
  marks: GoalMarkView[];
  /** What it is for — the one line under the title. `null` when unsaid. */
  purpose: string | null;
  /** What done looks like — leads the Done when section. `null` when unsaid. */
  endState: string | null;
  /** The kind of work, and whether a person confirmed the AI's proposal. */
  kind: { mark: GoalMarkView; confirmed: boolean } | null;
  uncertainty: (UncertaintyView & { confirmed: boolean }) | null;
  owner: GoalPersonFact | null;
  /**
   * The judge — `null` too when the owner judges (decision 2: the judge
   * defaults to the owner), so the header says "Owner and judge: …" once.
   */
  judge: GoalPersonFact | null;
  /** The owner also judges — the owner fact reads "Owner and judge". */
  ownerJudges: boolean;
  /** Why it ended, in the closer's words (impossible, replaced). */
  verdictReason: string | null;
}

/** The marks inside an open goal: "In review", then one "Waiting on …" per reason. */
export function goalInsideMarks(
  goal: Pick<GoalLike, "inReview" | "waitingOn">
): GoalMarkView[] {
  return [
    ...(goal.inReview ? [IN_REVIEW_MARK] : []),
    ...waitingOnMarks(goal.waitingOn),
  ];
}

export function goalHeader(
  goal: GoalLike,
  nameOf?: GoalNameOf
): GoalHeaderView {
  const { ownerId, judgeId } = goalRoles(goal);
  const ownerJudges = !!ownerId && judgeId === ownerId;
  const name = (id: string) =>
    goal.participants
      ?.find((p) => p.principalId === id && p.displayName?.trim())
      ?.displayName?.trim() ||
    nameOf?.(id)?.trim() ||
    null;
  const confirmed = !!goal.kindConfirmedBy;
  const fact = (
    id: string,
    roles: TrackParticipant["role"][]
  ): GoalPersonFact => {
    const role = goalRoleWords(roles);
    const n = name(id);
    return { id, name: n, role, label: n ? `${role}: ${n}` : null };
  };
  return {
    status: goalStatusMark(goal),
    marks: goalInsideMarks(goal),
    purpose: goal.direction?.trim() || null,
    endState: goal.endState?.trim() || null,
    kind: goal.workKind
      ? { mark: workKindMark(goal.workKind), confirmed }
      : null,
    uncertainty: goal.uncertainty
      ? { ...uncertaintyView(goal.uncertainty), confirmed }
      : null,
    owner: ownerId
      ? fact(ownerId, ownerJudges ? ["owner", "judge"] : ["owner"])
      : null,
    judge: judgeId && !ownerJudges ? fact(judgeId, ["judge"]) : null,
    ownerJudges,
    verdictReason: goal.verdictReason?.trim() || null,
  };
}

// ── Done when ──────────────────────────────────────────────────────────────

export interface GoalCriterionAcceptanceView {
  state: string;
  /** "Accepted", "Changes asked", … — the vocabulary's. */
  label: string;
  /** The judge's note (what to change, why rejected). */
  note: string | null;
  at: string | null;
}

/**
 * One "Done when" row. `key`, `statement`, `required` are the scorecard row's
 * fields, same meaning (see the module header for why the rest differs).
 */
export interface GoalCriterionRow extends Pick<
  ScorecardRow,
  "key" | "statement" | "required"
> {
  mark: GoalMarkView;
  /** How it is decided (R5): measured, judged, handed over, … */
  meaning: GoalMarkView;
  /** About the METHOD, not the hoped-for answer (R7) — an investigation's criterion. */
  aboutMethod: boolean;
  /** A measured criterion's latest value, in the check's words ("9 of 12 held"). */
  currentValue: string | null;
  /**
   * The judge's decision WHEN it is worth saying — sent back or rejected,
   * with the note. `null` when accepted (the mark already says Met), while a
   * claim waits (the mark says Claimed), or when nothing was claimed: the
   * ONE "which acceptance shows" rule, so no row re-decides it.
   */
  acceptance: GoalCriterionAcceptanceView | null;
  /** What backs a claim — who claimed it, from which run (a door), with what. `null` = nothing to show. */
  claim: GoalCriterionClaimView | null;
  /**
   * Offer Accept / Send back: the viewer is the goal's judge (a person) and
   * the criterion is claimed — the only state the judge's act exists for.
   */
  judgeable: boolean;
  /**
   * Offer "Accept with source…": the judge may accept a criterion decided
   * OUTSIDE (an outside party, a certificate) that nobody claimed, naming the
   * source in the note (Additions 5) — the pod's `goalAcceptanceRefusal`
   * over `OUTSIDE_DECIDED_MEANINGS`, which refuses it without that note.
   */
  acceptWithSource: boolean;
}

/** One claim, as the criterion row draws it on Declare done. */
export interface GoalCriterionClaimView {
  /** "Claimed by Claude Code" — the claimant named, never an id. */
  by: string;
  /** The run it was claimed from — a door to the session. `null` when the claim names none. */
  session: { id: string; title: string } | null;
  evidence: string | null;
  note: string | null;
  at: string | null;
}

/** Acceptance states the mark already says — no second word for them. */
const ACCEPTANCE_THE_MARK_SAYS = new Set(["accepted", "waiting"]);

function claimView(
  claim: GoalCriterionClaim | null | undefined
): GoalCriterionClaimView | null {
  if (!claim) return null;
  const who = claim.byName?.trim() || "someone";
  return {
    by: `${resolveGoalCriterionMarkLabel("claimed")} by ${who}`,
    session: claim.sessionId
      ? {
          id: claim.sessionId,
          title: claim.sessionTitle?.trim() || resolveObjectNoun("session"),
        }
      : null,
    evidence: readEvidenceDetail(claim.evidence),
    note: claim.note?.trim() || null,
    at: claim.at ?? null,
  };
}

export function goalCriterionRows(
  goal: GoalLike,
  viewer: GoalViewer
): GoalCriterionRow[] {
  const judge = viewerIsJudge(goal, viewer);
  return goal.criteria.map((c) => {
    const decision = c.acceptance ?? null;
    const raw = c.acceptanceState ?? null;
    const state = raw && !ACCEPTANCE_THE_MARK_SAYS.has(raw) ? raw : null;
    return {
      key: c.key,
      statement: c.statement,
      required: c.required !== false,
      mark: criterionMark(c.mark),
      meaning: checkMeaningMark(c.meaning),
      aboutMethod: c.about === "method" || c.meaning === "learning",
      currentValue: c.currentValue?.trim() || null,
      acceptance: state
        ? {
            state,
            label: resolveGoalAcceptanceLabel(state),
            note: decision?.note?.trim() || null,
            at: decision?.at ?? null,
          }
        : null,
      claim:
        c.mark === "claimed" || c.mark === "met" ? claimView(c.claim) : null,
      judgeable: judge && c.mark === "claimed",
      acceptWithSource:
        judge &&
        (OUTSIDE_DECIDED_MEANINGS as readonly string[]).includes(c.meaning) &&
        c.mark !== "claimed" &&
        c.mark !== "met" &&
        c.mark !== null,
    };
  });
}

/**
 * The text count of "Done when" — "3 of 5 met · 1 claimed". One mark per
 * criterion and this count; never a percent, never a bar. The "N of M met"
 * words are the lens header's criteria fact (`lensScopeFactLabel`), so the
 * header and the section say it the same way. `label: null` = a lasting goal
 * (no criteria) or marks not read (`unread`): no count is claimed.
 */
export interface GoalCriteriaCount {
  met: number;
  claimed: number;
  total: number;
  unread: boolean;
  label: string | null;
}

export function goalCriteriaCount(
  goal: Pick<GoalLike, "criteria">
): GoalCriteriaCount {
  const total = goal.criteria.length;
  const unread = goal.criteria.some((c) => c.mark === null);
  const met = goal.criteria.filter((c) => c.mark === "met").length;
  const claimed = goal.criteria.filter((c) => c.mark === "claimed").length;
  const base =
    !unread && total > 0
      ? lensScopeFactLabel({ kind: "criteria", met, total })
      : null;
  return {
    met,
    claimed,
    total,
    unread,
    label: base ? `${base}${claimed > 0 ? ` · ${claimed} claimed` : ""}` : null,
  };
}

// ── Who's on it ────────────────────────────────────────────────────────────

/** A verb a participant row offers THIS viewer. */
export interface GoalParticipantVerb {
  /**
   * A commitment move (`TRACK_COMMITMENT_MOVES`), the owner's acknowledgement
   * (R10), or the owner's answer to a counter-offer: `take_offer` / `keep_ask`.
   */
  op: TrackCommitmentMove | "acknowledge" | GoalCounterAnswer;
  /** The participant row the act is on (the delegate row for a commitment). */
  participantId: string;
  label: string;
  /** The act needs words: a counter-offer, the reason it cannot be done. */
  needsText: boolean;
  /**
   * `take_offer` / `keep_ask` only: the ask to send — the pod's re-ask, the
   * participants door's `add` of the same delegate with this commitment
   * (`goalCounterAnswerChange`).
   */
  reask?: { principalId: string; commitment: string };
}

/**
 * The owner's (or judge's) answer to a COUNTERED commitment — the choice the
 * `track.commitment_countered` notice promises: ask again with the delegate's
 * counter-offer, or ask again with the original commitment. Both are the
 * participants door's re-ask (`add` of the same delegate), never a new door.
 */
export const GOAL_COUNTER_ANSWERS = ["take_offer", "keep_ask"] as const;
export type GoalCounterAnswer = (typeof GOAL_COUNTER_ANSWERS)[number];

/** The participants-door change a counter answer sends (`tracks.changeParticipants`). */
export function goalCounterAnswerChange(verb: GoalParticipantVerb): {
  op: "add";
  principalId: string;
  role: "delegate";
  commitment: string;
} | null {
  if (!verb.reask) return null;
  return {
    op: "add",
    principalId: verb.reask.principalId,
    role: "delegate",
    commitment: verb.reask.commitment,
  };
}

export interface GoalParticipantRow {
  key: string;
  principalId: string;
  principalKind: "person" | "agent";
  /**
   * How the participant's mark draws (`ActorMark` kind, web and relay): an
   * agent draws as an agent — its own glyph, never a person's letter disc
   * (founder D-1, 2026-10-26). The ONE "is this an agent" rule for the row:
   * hosts pass it through, never re-derive it from `principalKind`.
   */
  actorKind: "human" | "agent";
  /** `null` when neither the pod nor the host could name them — the row then leads with the role. */
  name: string | null;
  /** Every role this principal holds, in role order ("Owner and judge") — `goalRoleWords`. */
  roles: string;
  commitment: string | null;
  commitmentMark: GoalMarkView | null;
  /** The delegate's counter-offer (countered). */
  counterText: string | null;
  /** Why it cannot be done (reported impossible). */
  reportedReason: string | null;
  /** A reported "impossible" nobody acknowledged yet (R10) — it waits on the owner. */
  reportUnacknowledged: boolean;
  silence: GoalMarkView | null;
  verbs: GoalParticipantVerb[];
  /** The row for the lens kit's `AttentionRow`. */
  row: LensRow;
}

const ROLE_ORDER = ["owner", "judge", "delegate", "integrator"] as const;

const COMMITMENT_VERB_NEEDS_TEXT: Record<TrackCommitmentMove, boolean> = {
  accept: false,
  counter: true,
  decline: false,
  report_impossible: true,
};

/**
 * The "Who's on it" rows: ONE row per principal (a person who owns and judges
 * is one row, "Owner and judge"), in role order — owner, judge, delegates,
 * integrator. A delegate's row carries its commitment, its state, "Silent 6 h"
 * when it owes something and said nothing, and the verbs this viewer may use:
 * the delegate answers their own commitment; the owner or judge acknowledges
 * a report (R10). `null` = participants not read (a failed read is not an
 * empty goal).
 */
export function goalParticipantRows(
  goal: GoalLike,
  viewer: GoalViewer,
  nameOf?: GoalNameOf,
  now: Date = new Date()
): GoalParticipantRow[] | null {
  if (!goal.participants) return null;
  const staff = viewerMayStaff(goal, viewer);
  const byPrincipal = new Map<string, TrackParticipant[]>();
  const sorted = [...goal.participants].sort(
    (a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role)
  );
  for (const p of sorted) {
    const list = byPrincipal.get(p.principalId) ?? [];
    list.push(p);
    byPrincipal.set(p.principalId, list);
  }
  return [...byPrincipal.values()].map((held) => {
    const first = held[0]!;
    const delegate = held.find((p) => p.role === "delegate") ?? null;
    // The pod's own name first, then the host's, else the role word.
    const name =
      held.find((p) => p.displayName?.trim())?.displayName?.trim() ||
      nameOf?.(first.principalId)?.trim() ||
      null;
    const roles = goalRoleWords(held.map((p) => p.role));
    const state = delegate?.commitmentState ?? null;
    const reportUnacknowledged =
      state === "reported_impossible" && !delegate?.acknowledgedAt;
    const verbs: GoalParticipantVerb[] = [];
    if (delegate && state && viewer.userId === first.principalId) {
      for (const move of TRACK_COMMITMENT_MOVE_KEYS) {
        // Probe with words so a move that only lacks its text stays offered.
        if (commitmentMoveRefusal(state, move, "x") === null) {
          verbs.push({
            op: move,
            participantId: delegate.id,
            label: resolveActionLabel(move, "imperative"),
            needsText: COMMITMENT_VERB_NEEDS_TEXT[move],
          });
        }
      }
    }
    // A counter-offer waits on the owner or judge (a person): take it, or keep the ask.
    const counterText = delegate?.counterText?.trim() || null;
    const asked = delegate?.commitment?.trim() || null;
    if (delegate && state === "countered" && staff && !isTrackClosed(goal)) {
      const answers: Array<[GoalCounterAnswer, string | null]> = [
        ["take_offer", counterText],
        ["keep_ask", asked],
      ];
      for (const [op, commitment] of answers) {
        if (!commitment) continue;
        verbs.push({
          op,
          participantId: delegate.id,
          label: resolveActionLabel(`track.${op}`, "imperative"),
          needsText: false,
          reask: { principalId: delegate.principalId, commitment },
        });
      }
    }
    if (delegate && reportUnacknowledged && staff) {
      verbs.push({
        op: "acknowledge",
        participantId: delegate.id,
        label: resolveActionLabel("acknowledge", "imperative"),
        needsText: false,
      });
    }
    const silence = delegate ? silenceMark(delegate.silentSince, now) : null;
    const commitment = delegate?.commitment?.trim() || null;
    const agent = first.principalKind === "agent";
    const title = name ?? humanizeToken(first.principalKind);
    const owes = verbs.length > 0;
    const row: LensRow = {
      key: `participant:${first.principalId}`,
      cls: owes ? "blocking" : "happening",
      // The row's lead is the participant's own face (`ActorMark`), not a
      // unit state; the state only feeds the row's data attribute.
      state: owes
        ? { owedFromYou: 1 }
        : silence
          ? { idle: true }
          : { everStarted: true },
      objectKind: agent ? "agent" : "person",
      title,
      reason: commitment,
      repeat: null,
      source: null,
      occurredAt: null,
      verb: verbs[0] ? { action: verbs[0].op, label: verbs[0].label } : null,
      // An agent has its own page; a person is a user, not an object with a page.
      door: agent ? { kind: "agent", id: first.principalId } : null,
      count: 1,
    };
    return {
      key: row.key,
      principalId: first.principalId,
      principalKind: first.principalKind,
      actorKind: agent ? "agent" : "human",
      name,
      roles,
      commitment,
      commitmentMark: state ? commitmentMark(state) : null,
      counterText,
      reportedReason: delegate?.reportedReason?.trim() || null,
      reportUnacknowledged,
      silence,
      verbs,
      row,
    };
  });
}

// ── status moves ───────────────────────────────────────────────────────────

/** One move a goal offers this viewer. */
export type GoalStatusMove =
  | {
      kind: "move";
      to: TrackStatus;
      verb: TrackStatusVerb;
      label: string;
    }
  | {
      /** Closing (done) or dropping (lost): always asks a verdict — the Declare done page. */
      kind: "verdict";
      to: TrackStatus;
      verb: "close" | "drop";
      label: string;
      verdicts: readonly TrackVerdict[];
    }
  | {
      /** A closed or dropped goal reopens as a NEW version (R8); the old one stays closed. */
      kind: "reopen";
      label: string;
    };

/**
 * A plain move's words. A move between two open states ("move" — proposed,
 * agreed, ready) names where it goes, "Move to agreed": three bare "Move"
 * items would say nothing. Pause, resume and start are complete verbs.
 */
export function goalMoveLabel(move: {
  to: TrackStatus;
  verb: TrackStatusVerb;
}): string {
  return move.verb === "move"
    ? resolveTrackMoveLabel(move.to)
    : resolveActionLabel(move.verb, "imperative");
}

/**
 * The status moves THIS viewer may make, in the table's order
 * (`trackStatusMoves`, drops included). A close always asks a verdict; an
 * operation's close is "Retire" and offers only `retired`. Closing is the
 * judge's act, dropping the owner's or the judge's, and neither is ever
 * offered to an agent (the goal's declaration stays human — R9). A closed or
 * dropped goal offers only "Open a new version", to a person.
 */
export function goalStatusMoves(
  goal: GoalLike,
  viewer: GoalViewer
): GoalStatusMove[] {
  const person = viewer.kind === "person" && !!viewer.userId;
  if (isTrackClosed(goal)) {
    // `track.reopen`, not bare `reopen` (the governance verb, "Reopen").
    return person
      ? [
          {
            kind: "reopen",
            label: resolveActionLabel("track.reopen", "imperative"),
          },
        ]
      : [];
  }
  const judge = viewerIsJudge(goal, viewer);
  const mayDrop = viewerMayDrop(goal, viewer);
  const operation = goal.workKind === "operation";
  const out: GoalStatusMove[] = [];
  for (const move of trackStatusMoves(goal.status, { includeArchive: true })) {
    const category = trackStatusCategory(move.to);
    if (category === "done" || category === "lost") {
      if (category === "done" ? !judge : !mayDrop) continue;
      out.push({
        kind: "verdict",
        to: move.to,
        verb: category === "done" ? "close" : "drop",
        label: resolveActionLabel(
          category === "done" && operation ? "retire" : move.verb,
          "imperative"
        ),
        verdicts: trackVerdictsFor(move.to, goal.workKind),
      });
      continue;
    }
    out.push({
      kind: "move",
      to: move.to,
      verb: move.verb,
      label: goalMoveLabel(move),
    });
  }
  return out;
}

// ── verdicts (Declare done) ────────────────────────────────────────────────

export interface GoalVerdictChoice {
  verdict: TrackVerdict;
  /** The status the close moves to: `completed` (Closed) or `archived` (Dropped). */
  to: TrackStatus;
  ending: "close" | "drop";
  mark: GoalMarkView;
  label: string;
  /** Impossible / replaced need the closer's words (`TRACK_VERDICTS_NEEDING_REASON`). */
  needsReason: boolean;
  /**
   * Why this verdict cannot be chosen now, in a person's words — `null` when
   * it can. The rule is `checkTrackClose` (the pod's own); only the words
   * here are for a person ("2 criteria are not met yet"), not the machine
   * tokens an agent reads.
   */
  unavailable: string | null;
  /** What choosing it does — said before the person confirms. */
  consequence: string;
}

export interface GoalVerdicts {
  /** The viewer may declare: the judge closes, the owner or judge drops. */
  mayClose: boolean;
  mayDrop: boolean;
  /** Why the viewer may not declare anything — `null` when they may. */
  refusal: string | null;
  close: GoalVerdictChoice[];
  drop: GoalVerdictChoice[];
}

function consequenceOf(
  verdict: TrackVerdict,
  ending: "close" | "drop"
): string {
  const word = resolveTrackVerdictLabel(verdict).toLowerCase();
  if (verdict === "retired")
    return "The operation is retired and stops proposing runs. It stays closed.";
  if (ending === "close") {
    return verdict === "partly_met"
      ? `The goal closes as ${word}. A follow-up goal can carry the rest.`
      : `The goal closes as ${word}. It stays closed; reopening makes a new version.`;
  }
  if (verdict === "no_longer_needed")
    return "The goal is dropped. Not a failure: the need went away.";
  return `The goal is dropped as ${word}.`;
}

/**
 * The verdicts a close may carry, for THIS viewer — the Declare done bar.
 * Close: met · partly met · not met (an operation: retired only). Drop: no
 * longer needed · impossible · replaced · created by mistake. Each choice says
 * whether the pod would accept it now (`checkTrackClose` with the goal's
 * marks) and what it does. Never offered to an agent.
 */
export function goalVerdicts(goal: GoalLike, viewer: GoalViewer): GoalVerdicts {
  const closed = isTrackClosed(goal);
  const mayClose = !closed && viewerIsJudge(goal, viewer);
  const mayDrop = !closed && viewerMayDrop(goal, viewer);
  const refusal = closed
    ? "This goal is already closed."
    : viewer.kind === "agent"
      ? "An agent cannot declare a goal done — its judge does."
      : !mayClose && !mayDrop
        ? "Only the goal's owner or judge can declare it."
        : null;
  // Marks not read ⇒ the criteria cannot be known: the pod still checks.
  const marksRead = goal.criteria.every((c) => c.mark !== null);
  const criteria = marksRead
    ? goal.criteria.map((c) => ({
        key: c.key,
        required: c.required,
        mark: c.mark as string,
      }))
    : undefined;
  const notMet = goal.criteria.filter(
    (c) => c.required !== false && c.mark !== "met"
  ).length;
  const choices = (
    to: TrackStatus,
    ending: "close" | "drop"
  ): GoalVerdictChoice[] =>
    trackVerdictsFor(to, goal.workKind).map((verdict) => {
      const needsReason = (
        TRACK_VERDICTS_NEEDING_REASON as readonly string[]
      ).includes(verdict);
      const refused = checkTrackClose(
        to,
        { verdict, verdictReason: needsReason ? "reason" : null },
        criteria,
        goal.workKind
      );
      return {
        verdict,
        to,
        ending,
        mark: goalStatusMark({ status: to, verdict }),
        label: resolveTrackVerdictLabel(verdict),
        needsReason,
        unavailable: refused
          ? verdict === "met" && notMet > 0
            ? `${notMet} ${notMet === 1 ? "criterion is" : "criteria are"} not met yet`
            : (verdict === "partly_met" || verdict === "not_met") &&
                notMet === 0
              ? "Every criterion is met"
              : refused
          : null,
        consequence: consequenceOf(verdict, ending),
      };
    });
  return {
    mayClose,
    mayDrop,
    refusal,
    close: mayClose ? choices("completed", "close") : [],
    drop: mayDrop ? choices("archived", "drop") : [],
  };
}
