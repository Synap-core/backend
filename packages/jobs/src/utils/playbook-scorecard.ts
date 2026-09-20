/**
 * PLAYBOOK SCORECARD — how a playbook's runs actually went, DERIVED (no table).
 *
 * The same shape as `diagnose/agent-scorecard.ts` and
 * `intake/quality-by-prompt-version.ts`: rows in, a pure projection out, so the
 * rule is testable on fixtures and the SQL is testable on PGlite.
 *
 * WHY IT LIVES IN `@synap/jobs`: two readers need the ONE derivation — the
 * tRPC `playbooks.scorecard` (in `@synap/api`) and the weekly lessons scanner
 * (in `@synap/jobs`). `@synap/api` depends on `@synap/jobs`, never the reverse,
 * so the lower package holds it and the router imports it
 * (`@synap/jobs/utils/playbook-scorecard.js`).
 *
 * THE RULES (each has a discriminating fixture):
 *   - a criterion's result per session is its CURRENT verdict
 *     (`latestEvaluationPerCriterion`: the latest row, a human row wins);
 *   - pass rate = passed / (passed + failed). `unmeasured` is NOT a failure and
 *     is excluded; no measured session ⇒ `null`, never 0;
 *   - an OVERRIDE is a human row whose verdict differs from the latest pass/fail
 *     NON-human row BEFORE it — a person correcting the judge. A human who
 *     merely fills in an `unmeasured`, or agrees, is not an override;
 *   - an ESCALATION is an owed `criterion` slot on the session (what the retry
 *     bound files after two non-human attempts);
 *   - REOPENED = the session emitted the close event and then either closed
 *     again or is open now.
 * Owner-floored: sessions are owner-private, so a scorecard is one person's.
 */

import {
  and,
  asc,
  eq,
  inArray,
  drizzleSql,
  focusSessions,
  sessionEvaluations,
  events,
} from "@synap/database";
import type { db as Db } from "@synap/database";
import {
  CRITERION_SLOT_KIND,
  latestEvaluationPerCriterion,
  type EvaluationRowLike,
} from "@synap-core/types/focus-sessions";
import { isCriterionRequired, readCriteria } from "@synap/playbooks";
import { FOCUS_SESSION_CLOSED_EVENT_TYPE } from "../workers/automation-trigger-matcher.js";

const TERMINAL = new Set(["closed", "cancelled", "failed"]);

export interface ScorecardSessionRow {
  id: string;
  playbookId: string | null;
  status: string;
  criteria: unknown;
  expectedOutputs: unknown;
  /** How many close events this session has emitted. */
  closeEvents: number;
}

export interface ScorecardEvaluationRow extends EvaluationRowLike {
  sessionId: string;
  rationale: string | null;
}

export interface CriterionScore {
  key: string;
  statement: string;
  required: boolean;
  /** Closed sessions that declared this criterion. */
  sessions: number;
  passed: number;
  failed: number;
  unmeasured: number;
  /** passed / (passed + failed); null when nothing was measured. */
  passRate: number | null;
  overrides: number;
}

export interface PlaybookScorecard {
  runs: {
    total: number;
    closed: number;
    /** Closed sessions with at least one evaluation row. */
    evaluated: number;
    reopened: number;
  };
  escalations: number;
  overrides: number;
  criteria: CriterionScore[];
}

/** Session ids where a human overrode a non-human verdict, per criterion. */
export function findOverrides(rows: readonly ScorecardEvaluationRow[]): Array<{
  sessionId: string;
  criterionKey: string;
  rationale: string | null;
}> {
  const at = (r: EvaluationRowLike) => new Date(r.createdAt).getTime();
  const out: Array<{
    sessionId: string;
    criterionKey: string;
    rationale: string | null;
  }> = [];
  const groups = new Map<string, ScorecardEvaluationRow[]>();
  for (const r of rows) {
    const k = `${r.sessionId}\0${r.criterionKey}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  for (const group of groups.values()) {
    const human = latestEvaluationPerCriterion(group)[0];
    if (!human || human.evaluatorKind !== "human") continue;
    const before = group
      .filter(
        (r) =>
          r.evaluatorKind !== "human" &&
          r.verdict !== "unmeasured" &&
          at(r) <= at(human)
      )
      .sort((a, b) => at(a) - at(b) || (a.attempt ?? 0) - (b.attempt ?? 0));
    const overridden = before[before.length - 1];
    if (overridden && overridden.verdict !== human.verdict) {
      out.push({
        sessionId: human.sessionId,
        criterionKey: human.criterionKey,
        rationale: human.rationale,
      });
    }
  }
  return out;
}

/** Pure: sessions + their evaluation rows → the scorecard. */
export function projectPlaybookScorecard(
  sessions: readonly ScorecardSessionRow[],
  evaluations: readonly ScorecardEvaluationRow[]
): PlaybookScorecard {
  const closed = sessions.filter((s) => s.status === "closed");
  const closedIds = new Set(closed.map((s) => s.id));
  const closedRows = evaluations.filter((e) => closedIds.has(e.sessionId));
  const bySession = new Map<string, ScorecardEvaluationRow[]>();
  for (const r of closedRows) {
    bySession.set(r.sessionId, [...(bySession.get(r.sessionId) ?? []), r]);
  }
  const overrides = findOverrides(closedRows);

  const scores = new Map<string, CriterionScore>();
  for (const s of closed) {
    const current = new Map(
      latestEvaluationPerCriterion(bySession.get(s.id) ?? []).map((r) => [
        r.criterionKey,
        r.verdict,
      ])
    );
    for (const c of readCriteria(s.criteria)) {
      const score =
        scores.get(c.key) ??
        ({
          key: c.key,
          statement: c.statement,
          required: isCriterionRequired(c),
          sessions: 0,
          passed: 0,
          failed: 0,
          unmeasured: 0,
          passRate: null,
          overrides: 0,
        } satisfies CriterionScore);
      score.sessions++;
      const v = current.get(c.key) ?? "unmeasured";
      if (v === "pass") score.passed++;
      else if (v === "fail") score.failed++;
      else score.unmeasured++;
      scores.set(c.key, score);
    }
  }
  for (const o of overrides) {
    const score = scores.get(o.criterionKey);
    if (score) score.overrides++;
  }
  for (const score of scores.values()) {
    const measured = score.passed + score.failed;
    score.passRate = measured > 0 ? score.passed / measured : null;
  }

  const escalations = closed.reduce((n, s) => {
    const slots = Array.isArray(s.expectedOutputs) ? s.expectedOutputs : [];
    return (
      n +
      slots.filter(
        (o) => (o as { kind?: unknown } | null)?.kind === CRITERION_SLOT_KIND
      ).length
    );
  }, 0);

  return {
    runs: {
      total: sessions.length,
      closed: closed.length,
      evaluated: closed.filter((s) => bySession.has(s.id)).length,
      reopened: sessions.filter(
        (s) =>
          s.closeEvents >= 2 || (s.closeEvents >= 1 && !TERMINAL.has(s.status))
      ).length,
    },
    escalations,
    overrides: overrides.length,
    criteria: [...scores.values()],
  };
}

/**
 * The rows the projection reads: every session of `playbookId` owned by
 * `userId` (optionally only those closed after `closedAfter`), with its close-
 * event count, and every evaluation row of those sessions.
 */
export async function loadPlaybookScorecardRows(
  database: typeof Db,
  params: { playbookIds: string[]; userId: string; closedAfter?: Date | null }
): Promise<{
  sessions: ScorecardSessionRow[];
  evaluations: ScorecardEvaluationRow[];
}> {
  if (params.playbookIds.length === 0) return { sessions: [], evaluations: [] };
  const where = and(
    inArray(focusSessions.playbookId, params.playbookIds),
    eq(focusSessions.userId, params.userId),
    ...(params.closedAfter
      ? [
          drizzleSql`${focusSessions.closedAt} > ${params.closedAfter.toISOString()}`,
        ]
      : [])
  );
  const rows = await database
    .select({
      id: focusSessions.id,
      playbookId: focusSessions.playbookId,
      status: focusSessions.status,
      criteria: focusSessions.criteria,
      expectedOutputs: focusSessions.expectedOutputs,
      // Columns QUALIFIED by hand: inside a correlated subquery drizzle
      // renders `${focusSessions.id}` as a bare "id", which binds to
      // events.id and silently counts nothing.
      closeEvents: drizzleSql<number>`(
        SELECT count(*)::int FROM ${events} AS ev
        WHERE ev.type = ${FOCUS_SESSION_CLOSED_EVENT_TYPE}
          AND ev.subject_id = "focus_sessions"."id"::text
      )`,
    })
    .from(focusSessions)
    .where(where);
  const sessions = rows.map((r) => ({
    ...r,
    status: String(r.status),
    closeEvents: Number(r.closeEvents ?? 0),
  }));
  if (sessions.length === 0) return { sessions, evaluations: [] };
  const evaluations = await database
    .select({
      sessionId: sessionEvaluations.sessionId,
      criterionKey: sessionEvaluations.criterionKey,
      verdict: sessionEvaluations.verdict,
      evaluatorKind: sessionEvaluations.evaluatorKind,
      attempt: sessionEvaluations.attempt,
      createdAt: sessionEvaluations.createdAt,
      rationale: sessionEvaluations.rationale,
    })
    .from(sessionEvaluations)
    .where(
      inArray(
        sessionEvaluations.sessionId,
        sessions.map((s) => s.id)
      )
    )
    .orderBy(asc(sessionEvaluations.createdAt));
  return { sessions, evaluations };
}

/**
 * Scorecards for SEVERAL playbooks in two queries — what a catalog door needs
 * (a per-playbook call would be 2N queries). Every id gets an entry, so an
 * unrun playbook reads as zero runs rather than as absent.
 */
export async function computePlaybookScorecards(
  database: typeof Db,
  params: { playbookIds: string[]; userId: string }
): Promise<Record<string, PlaybookScorecard>> {
  const { sessions, evaluations } = await loadPlaybookScorecardRows(
    database,
    params
  );
  const out: Record<string, PlaybookScorecard> = {};
  for (const playbookId of params.playbookIds) {
    out[playbookId] = projectPlaybookScorecard(
      sessions.filter((s) => s.playbookId === playbookId),
      evaluations
    );
  }
  return out;
}

/** One playbook's scorecard. */
export async function computePlaybookScorecard(
  database: typeof Db,
  params: { playbookId: string; userId: string }
): Promise<PlaybookScorecard> {
  const all = await computePlaybookScorecards(database, {
    playbookIds: [params.playbookId],
    userId: params.userId,
  });
  return all[params.playbookId]!;
}

/** A compact scorecard for a CATALOG row — a few numbers, never the full table. */
export interface CompactPlaybookScorecard {
  closedRuns: number;
  evaluatedRuns: number;
  reopenedRuns: number;
  overrides: number;
  escalations: number;
  /** Pass rate per criterion key; `null` = nothing measured yet. */
  passRate: Record<string, number | null>;
}

/**
 * The compact form, or `null` when the playbook has no closed run — a row of
 * zeroes says nothing and costs every catalog reader tokens.
 */
export function compactScorecard(
  card: PlaybookScorecard
): CompactPlaybookScorecard | null {
  if (card.runs.closed === 0) return null;
  return {
    closedRuns: card.runs.closed,
    evaluatedRuns: card.runs.evaluated,
    reopenedRuns: card.runs.reopened,
    overrides: card.overrides,
    escalations: card.escalations,
    passRate: Object.fromEntries(card.criteria.map((c) => [c.key, c.passRate])),
  };
}
