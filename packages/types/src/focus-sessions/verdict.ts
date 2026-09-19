/**
 * Session VERDICT — the ONE projection from a session's criteria and its
 * evaluation rows to "is this session's contract met?".
 *
 * Server-computed and returned on the session read doors, and imported by relay
 * and browser so a client never re-derives the rule. Pure and dependency-free:
 * the shapes below are structural so the backend's drizzle rows, a JSON wire
 * payload (dates as strings) and a client fixture all fit.
 *
 * Two rules carry the meaning, and each has a discriminating test:
 *   • a HUMAN row overrides every non-human row for its criterion, regardless of
 *     time — a judge that runs after a person graded does not un-grade it;
 *   • `unmeasured` is NOT `fail`. A criterion nobody could check leaves the
 *     session `incomplete`, never `failing`.
 */

export const EVALUATION_VERDICTS = ["pass", "fail", "unmeasured"] as const;
export type EvaluationVerdict = (typeof EVALUATION_VERDICTS)[number];

export const EVALUATOR_KINDS = [
  "evidence",
  "capability",
  "judge",
  "human",
] as const;
export type EvaluatorKind = (typeof EVALUATOR_KINDS)[number];

/** The fields of a `session_evaluations` row the projection reads. */
export interface EvaluationRowLike {
  criterionKey: string;
  verdict: EvaluationVerdict;
  evaluatorKind: EvaluatorKind;
  createdAt: Date | string;
  attempt?: number;
}

/** The fields of a `SessionCriterion` the projection reads. */
export interface VerdictCriterionLike {
  key: string;
  /** Absent = true. */
  required?: boolean;
}

export interface SessionVerdict {
  total: number;
  passed: number;
  failed: number;
  unmeasured: number;
  /** Required criteria whose current verdict is not `pass`. */
  requiredUnmet: number;
  /**
   * none       — the session declares no criteria.
   * passing    — every required criterion passes.
   * failing    — at least one required criterion's current verdict is `fail`.
   * incomplete — no required criterion failed, but some are not yet measured.
   */
  state: "none" | "passing" | "failing" | "incomplete";
}

function at(row: EvaluationRowLike): number {
  const t = new Date(row.createdAt).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** Does `a` supersede `b` as the current verdict for one criterion? */
function supersedes(a: EvaluationRowLike, b: EvaluationRowLike): boolean {
  const aHuman = a.evaluatorKind === "human";
  const bHuman = b.evaluatorKind === "human";
  if (aHuman !== bHuman) return aHuman;
  const dt = at(a) - at(b);
  if (dt !== 0) return dt > 0;
  return (a.attempt ?? 0) > (b.attempt ?? 0);
}

/**
 * The current row per criterion: the latest row, except that a human row wins
 * over any non-human row regardless of time. Order of the result follows first
 * appearance in `rows`.
 */
export function latestEvaluationPerCriterion<T extends EvaluationRowLike>(
  rows: readonly T[]
): T[] {
  const best = new Map<string, T>();
  for (const row of rows) {
    const current = best.get(row.criterionKey);
    if (!current || supersedes(row, current)) best.set(row.criterionKey, row);
  }
  return [...best.values()];
}

/**
 * Grade a session: `latestEvaluations` is the output of
 * `latestEvaluationPerCriterion` (rows for keys not in `criteria` are ignored;
 * a criterion with no row counts as `unmeasured`).
 */
export function computeSessionVerdict(
  criteria: readonly VerdictCriterionLike[],
  latestEvaluations: readonly Pick<
    EvaluationRowLike,
    "criterionKey" | "verdict"
  >[]
): SessionVerdict {
  const byKey = new Map(
    latestEvaluations.map((e) => [e.criterionKey, e.verdict])
  );
  let passed = 0;
  let failed = 0;
  let unmeasured = 0;
  let requiredUnmet = 0;
  let requiredFailed = 0;
  for (const c of criteria) {
    const verdict = byKey.get(c.key) ?? "unmeasured";
    if (verdict === "pass") passed++;
    else if (verdict === "fail") failed++;
    else unmeasured++;
    if (c.required !== false && verdict !== "pass") {
      requiredUnmet++;
      if (verdict === "fail") requiredFailed++;
    }
  }
  const total = criteria.length;
  const state: SessionVerdict["state"] =
    total === 0
      ? "none"
      : requiredUnmet === 0
        ? "passing"
        : requiredFailed > 0
          ? "failing"
          : "incomplete";
  return { total, passed, failed, unmeasured, requiredUnmet, state };
}
