/**
 * scorecard: the session's definition of done, read ONCE for both surfaces.
 * Relay's `ScorecardSection` and browser's scorecard both render this. Neither
 * re-derives which rows are gradable, how they are ordered, or what the glance
 * says.
 *
 * ── One rule, shared ────────────────────────────────────────────────────────
 * The verdict comes from `computeSessionVerdict` over
 * `latestEvaluationPerCriterion` (`@synap-core/types/focus-sessions`). The pod
 * uses the same pair, so relay never keeps a second table saying what "met"
 * means. It is recomputed here rather than read off `row.verdict` because an
 * optimistic grade only edits `evaluations`. Recomputing with the same function
 * means the glance line moves in the same frame as the row the person tapped.
 *
 * ── Empty is not failed ─────────────────────────────────────────────────────
 * `focusSessions.get` spreads the raw row, so `criteria` is there even when the
 * evaluations read failed. In that case the pod omits `verdict` and
 * `evaluations`. So:
 *   - no criteria at all      → `null`: the section does not render.
 *   - criteria, no `verdict`  → `unreadable`: the section says so and offers
 *                               a retry. It never reads as "Not checked".
 *
 * ── Who may grade a row ─────────────────────────────────────────────────────
 * The owner's grade overrides every automated row, so the pod accepts one on
 * any criterion. The surfaces offer it only where it is a real act and not a
 * rubber stamp:
 *   - a `human`-check criterion that is not passed (nothing else will ever
 *     grade it), and
 *   - an automated criterion that has REPORTED and did not pass, whether it
 *     failed or could not be checked,
 *   - a criterion with NO declared check at all — no machine will ever run it,
 *     so it was the person's from the moment it was written, and
 *   - an automated criterion on a TERMINAL session that never reported. Its
 *     check is not "still coming"; the session is over and nothing will run.
 * An automated criterion that has not run yet on a LIVE session still shows no
 * verbs. Its check really is coming, and an "Accept" there would skip it.
 *
 * ⚠️ The last two exist because a row that offers no verb and no verdict is a
 * DEAD ROW: it tells the reader a judgement is pending and hands them nothing
 * to bring it about. Dogfooded 2026-09-21 on a closed session whose two
 * `evidence` criteria had never run — it read "Not checked · Waiting for its
 * check" forever, and the founder's words were "I can't do anything from that."
 * Distinguishing "nobody is coming" from "someone is coming" is the same
 * empty-vs-failed discipline the rest of this module is built on.
 */

import {
  computeSessionVerdict,
  latestEvaluationPerCriterion,
  type EvaluationVerdict,
  type EvaluatorKind,
  type SessionVerdict,
} from "./verdict.js";
import { resolveStatusLabel } from "../vocabulary/index.js";
import { isTerminalSessionStatus } from "./statuses.js";

/** A criterion as `focusSessions.get` returns it (normalized by the pod). */
export interface WireCriterion {
  key: string;
  statement: string;
  required?: boolean;
  check?: { kind?: string; hint?: string } | null;
  stageKey?: string;
}

/** The CURRENT evaluation per criterion, as the packet item carries it. */
export interface WireEvaluation {
  criterionKey: string;
  verdict: EvaluationVerdict;
  evaluatorKind: EvaluatorKind;
  evaluatorId?: string | null;
  attempt?: number;
  rationale?: string | null;
  /** The evaluator's structured bag, when it recorded one. Read shallowly. */
  evidence?: unknown;
  createdAt: string | Date;
}

export type ScorecardTone = "success" | "error" | "warning" | "neutral";

export interface ScorecardRow {
  key: string;
  statement: string;
  required: boolean;
  verdict: EvaluationVerdict;
  /** Through the vocabulary door: "Passed" / "Failed" / "Not checked". */
  verdictLabel: string;
  tone: ScorecardTone;
  /**
   * Who judged it, in plain words ("AI review", "Decided by you"). When nothing
   * has judged it yet, this says who it is waiting FOR — or, when no judge is
   * coming at all, says that instead of naming a wait that will never end.
   */
  judgedBy: string;
  /** The evaluator's reasoning. `null` when none was recorded. */
  rationale: string | null;
  /** Offer Accept / Send back. See the module header for who may grade. */
  gradable: boolean;
  /**
   * Something other than a person checks this one. A surface with a "Run
   * checks" verb offers it only when some row is automated — a person-only
   * contract has nothing to run.
   */
  automated: boolean;
  /** When the current verdict was recorded. `null` while nothing has judged it. */
  gradedAt: string | null;
  /**
   * The one human-readable `detail` the evidence bag carried, when it carried
   * one. A machine value, rendered as such.
   */
  evidenceDetail: string | null;
}

export type ScorecardView =
  | { state: "unreadable" }
  | {
      state: "ok";
      verdict: SessionVerdict;
      /** "All 4 met" / "1 of 4 failed" / "2 of 4 met · 2 not checked". */
      summary: string;
      /** The verdict state through the vocabulary door ("Passing", …). */
      stateLabel: string;
      tone: ScorecardTone;
      /** In the order a person acts: failed, then not checked, then passed. */
      rows: ScorecardRow[];
      /** Some row awaits the reader's grade. The section opens for it. */
      needsYou: boolean;
    };

/**
 * Who judged a criterion, in plain words. This is provenance COPY, not a label
 * for the stored token: "AI review" names a way of checking, not the value
 * `judge`. Typed against `EvaluatorKind`, so a new kind breaks the build until
 * it has words here.
 *
 * `grade` is owner-only (`routers/focus-sessions.ts` `grade`), so a human row
 * is always the OWNER's: "Decided by you" to the owner, "Decided by <owner>"
 * to a room member reading the session (decision C) — `who` is `grader(reader)`.
 */
const JUDGED_BY: Record<
  EvaluatorKind,
  (row: WireEvaluation, who: string) => string
> = {
  evidence: () => "Agent reported evidence",
  // The verb that ran is the capability row's `evaluatorId`.
  capability: (row) =>
    row.evaluatorId?.trim() ? `Ran ${row.evaluatorId.trim()}` : "Ran a check",
  judge: () => "AI review",
  human: (_row, who) => `Decided by ${who}`,
};

/**
 * Who is READING the scorecard when it is NOT the session's owner — a room
 * member (founder decision C, 2026-09-25). Omitted ⇒ the reader is the owner.
 * Each host builds it from its own `canWriteSession` door and the SAME owner
 * name its "Shared by" chip shows.
 */
export interface ScorecardReader {
  /** The owner's display name; `null` when the roster could not resolve it. */
  ownerName: string | null;
}

/** The person a human grade belongs to, as THIS reader names them. */
function grader(reader: ScorecardReader | null | undefined): string {
  if (!reader) return "you";
  return reader.ownerName?.trim() || "the owner";
}

/** The first human-readable `detail` an evidence bag carries (one level deep). */
export function readEvidenceDetail(evidence: unknown): string | null {
  if (!isRecord(evidence)) return null;
  const direct = evidence.detail;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  for (const value of Object.values(evidence)) {
    const nested = isRecord(value) ? value.detail : null;
    if (typeof nested === "string" && nested.trim()) return nested.trim();
  }
  return null;
}

/**
 * The glance sentence for a verdict — ONE phrasing, so the phone, the desk and
 * anything else that says this fact say it with the same words.
 */
export function glanceSummary(v: SessionVerdict): string {
  if (v.state === "failing") {
    // ⚠️ The unmeasured half is NOT dropped here. A session can fail on one
    // required criterion while others were never checked at all
    // (`verdict.test.ts`: "a failed REQUIRED criterion fails the session even
    // when another is unmeasured"), and saying only "2 of 4 failed" invites
    // the reader to assume the other 2 passed. Keeping them apart is this
    // module's whole job; the `failing` branch used to be the one place it
    // quietly stopped doing it.
    const unchecked = v.unmeasured > 0 ? ` · ${v.unmeasured} not checked` : "";
    return `${v.failed} of ${v.total} failed${unchecked}`;
  }
  if (v.state === "incomplete") {
    return `${v.passed} of ${v.total} met · ${v.unmeasured} not checked`;
  }
  // `passing` is about REQUIRED criteria. An optional one may still be unmet,
  // so "All" is claimed only when it is literally true.
  return v.passed === v.total
    ? `All ${v.total} met`
    : `${v.passed} of ${v.total} met`;
}

const VERDICT_RANK: Record<EvaluationVerdict, number> = {
  fail: 0,
  unmeasured: 1,
  pass: 2,
};

const VERDICT_TONE: Record<EvaluationVerdict, ScorecardTone> = {
  pass: "success",
  fail: "error",
  // NOT a failure. Nobody could check it.
  unmeasured: "neutral",
};

const STATE_TONE: Record<SessionVerdict["state"], ScorecardTone> = {
  none: "neutral",
  passing: "success",
  failing: "error",
  incomplete: "warning",
};

const AUTOMATED_CHECK_KINDS = new Set(["evidence", "capability", "judge"]);

const asIso = (v: string | Date | undefined): string | null =>
  v instanceof Date
    ? v.toISOString()
    : typeof v === "string" && v.trim()
      ? v
      : null;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function readCriteria(raw: unknown): WireCriterion[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (c): c is WireCriterion =>
      isRecord(c) &&
      typeof c.key === "string" &&
      typeof c.statement === "string"
  );
}

function readEvaluations(raw: unknown): WireEvaluation[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is WireEvaluation =>
      isRecord(e) &&
      typeof e.criterionKey === "string" &&
      typeof e.verdict === "string" &&
      typeof e.evaluatorKind === "string"
  );
}

export function deriveScorecard(
  session: {
    criteria?: unknown;
    verdict?: unknown;
    evaluations?: unknown;
    /**
     * Read for ONE reason: once a session is terminal, an automated check that
     * never ran is never going to run. See `gradable` below. Both call sites
     * (relay's session room, the desk's `deriveScorecardSurface`) already hand
     * this function the whole session, so nothing upstream had to change.
     */
    status?: unknown;
  },
  reader?: ScorecardReader | null
): ScorecardView | null {
  const who = grader(reader);
  const criteria = readCriteria(session.criteria);
  if (criteria.length === 0) return null;
  // The pod lifts `verdict` + `evaluations` only when the read succeeded.
  if (!isRecord(session.verdict)) return { state: "unreadable" };

  const terminal = isTerminalSessionStatus(
    typeof session.status === "string" ? session.status : undefined
  );

  const current = new Map(
    latestEvaluationPerCriterion(readEvaluations(session.evaluations)).map(
      (e) => [e.criterionKey, e]
    )
  );
  const verdict = computeSessionVerdict(criteria, [...current.values()]);

  const rows = criteria
    .map((c): ScorecardRow => {
      const row = current.get(c.key);
      const v: EvaluationVerdict = row?.verdict ?? "unmeasured";
      const humanCheck = c.check?.kind === "human";
      // A criterion with no declared check kind is nobody's automated job:
      // only the three machine kinds are run by `focusSessions.evaluate`.
      const automated = AUTOMATED_CHECK_KINDS.has(c.check?.kind ?? "");
      // ── The two ways a criterion ends up with NO judge at all ────────────
      // Both used to render a state and no act, so the reader was told a
      // verdict was coming and handed nothing to bring it about.
      //   ownerless — no human check and no machine check. Nothing will ever
      //               run; it was the person's from the moment it was written.
      //   neverRan  — a machine check was declared and the session went
      //               terminal without it running. Nothing is coming now.
      // In both, the person is the only remaining judge, so the row becomes
      // gradable and `judgedBy` stops promising a check.
      const ownerless = !humanCheck && !automated;
      const neverRan = !row && automated && terminal;
      return {
        key: c.key,
        statement: c.statement,
        required: c.required !== false,
        verdict: v,
        verdictLabel: resolveStatusLabel(v),
        tone: VERDICT_TONE[v],
        judgedBy: row
          ? (JUDGED_BY[row.evaluatorKind]?.(row, who) ?? "Checked")
          : humanCheck || ownerless
            ? `Waiting for ${who}`
            : neverRan
              ? "Its check never ran"
              : "Waiting for its check",
        rationale: row?.rationale?.trim() || null,
        gradable:
          v !== "pass" && (humanCheck || Boolean(row) || ownerless || neverRan),
        automated,
        gradedAt: row ? asIso(row.createdAt) : null,
        evidenceDetail: row ? readEvidenceDetail(row.evidence) : null,
      };
    })
    // `sort` is stable, so the declared order holds within a verdict.
    .sort((a, b) => VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict]);

  return {
    state: "ok",
    verdict,
    summary: glanceSummary(verdict),
    stateLabel: resolveStatusLabel(verdict.state),
    tone: STATE_TONE[verdict.state],
    rows,
    needsYou: rows.some((r) => r.gradable),
  };
}

/**
 * The optimistic half of a grade: the evaluations list with the reader's own
 * human row appended. `latestEvaluationPerCriterion` then lets it win.
 */
export function withOptimisticGrade(
  evaluations: unknown,
  grade: { criterionKey: string; verdict: "pass" | "fail"; rationale?: string },
  now: Date = new Date()
): WireEvaluation[] {
  return [
    ...readEvaluations(evaluations),
    {
      criterionKey: grade.criterionKey,
      verdict: grade.verdict,
      evaluatorKind: "human",
      rationale: grade.rationale ?? null,
      createdAt: now.toISOString(),
    },
  ];
}

/** "2 criteria not met", or `null` when every required criterion passes. */
export function unmetPhrase(
  verdict: Pick<SessionVerdict, "requiredUnmet"> | null | undefined
): string | null {
  const n = verdict?.requiredUnmet ?? 0;
  if (n <= 0) return null;
  return `${n} ${n === 1 ? "criterion" : "criteria"} not met`;
}

/**
 * The compact verdict chip for a session LIST row, or `null`.
 *
 * Only when the row carries a verdict over real criteria (`state !== 'none'`).
 *   - terminal + required unmet → "2 unmet". Warning tone, or error when one
 *     failed. Close never blocks, so this chip is the only way a closed-but-unmet
 *     session stays visible on the list.
 *   - live → a quiet "2 of 4 met". Unmet is normal while work is under way, so
 *     it does not warn.
 *   - terminal and passing → nothing. The status chip already says it ended.
 */
export function sessionListVerdictChip(
  row: { verdict?: unknown },
  terminal: boolean
): { label: string; tone: "warning" | "error" | "neutral" } | null {
  const v = row.verdict;
  if (
    !isRecord(v) ||
    v.state === "none" ||
    typeof v.requiredUnmet !== "number" ||
    typeof v.passed !== "number" ||
    typeof v.total !== "number" ||
    v.total <= 0
  ) {
    return null;
  }
  if (!terminal)
    return { label: `${v.passed} of ${v.total} met`, tone: "neutral" };
  if (v.requiredUnmet <= 0) return null;
  return {
    label: `${v.requiredUnmet} unmet`,
    tone: v.state === "failing" ? "error" : "warning",
  };
}
