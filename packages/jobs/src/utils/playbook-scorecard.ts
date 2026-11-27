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
  links,
  tools,
  skills,
} from "@synap/database";
import type { db as Db } from "@synap/database";
import {
  CRITERION_SLOT_KIND,
  isTerminalSessionStatus,
  latestEvaluationPerCriterion,
  type EvaluationRowLike,
} from "@synap-core/types/focus-sessions";
import { isCriterionRequired, readCriteria } from "@synap/playbooks";
import { isUuid } from "@synap-core/types/property-render";
import { FOCUS_SESSION_CLOSED_EVENT_TYPE } from "../workers/automation-trigger-matcher.js";

/**
 * How far back the runs that teach a playbook are read (the lessons scanner's
 * evidence window, and the precedents an agent is shown). Older runs are
 * stale.
 */
export const PLAYBOOK_LEARNING_WINDOW_DAYS = 90;

export interface ScorecardSessionRow {
  id: string;
  playbookId: string | null;
  status: string;
  criteria: unknown;
  expectedOutputs: unknown;
  /** How many close events this session has emitted. */
  closeEvents: number;
  /**
   * TRUE when this session was ATTACHED to the playbook while already live
   * (`metadata.followedVia = "attach"`), as against INSTANTIATED from it.
   *
   * WHY IT IS ON THE ROW. A session attached at the end did not run under the
   * playbook: most of its work happened before the definition was bound, so
   * grading the playbook on it is grading a process for work it did not shape.
   * And this scorecard is not cosmetic — the weekly lessons scanner turns it
   * into governed `playbook/update` proposals, which feed the trusted-agent
   * widening lane. So the two populations are COUNTED BOTH, REPORTED APART
   * (`runs.instantiated` / `runs.attached`) and never silently blended; the
   * scanner then uses instantiated runs alone as failure evidence.
   */
  attached: boolean;
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
    /**
     * The split of `total` by HOW the session came to be a run of this
     * playbook. `instantiated + attached === total`, always — both numbers are
     * surfaced so a reader can see what the criteria scores are made of.
     * A criterion's pass rate above counts BOTH populations; the lessons
     * scanner re-projects over instantiated rows alone before proposing an
     * edit to the playbook (see {@link ScorecardSessionRow.attached}).
     */
    instantiated: number;
    attached: number;
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
          s.closeEvents >= 2 ||
          (s.closeEvents >= 1 && !isTerminalSessionStatus(s.status))
      ).length,
      instantiated: sessions.filter((s) => !s.attached).length,
      attached: sessions.filter((s) => s.attached).length,
    },
    escalations,
    overrides: overrides.length,
    criteria: [...scores.values()],
  };
}

/**
 * The SUCCESSFUL runs, what a precedent is made of: closed sessions
 * whose every REQUIRED criterion's current verdict is `pass`. A run that
 * declared no required criterion, or left one unmeasured, is not counted:
 * success is graded, never assumed. Pure, over the same rows the scorecard
 * reads.
 */
export function successfulRunIds(
  sessions: readonly ScorecardSessionRow[],
  evaluations: readonly ScorecardEvaluationRow[]
): string[] {
  const bySession = new Map<string, ScorecardEvaluationRow[]>();
  for (const r of evaluations) {
    bySession.set(r.sessionId, [...(bySession.get(r.sessionId) ?? []), r]);
  }
  return sessions
    .filter((s) => {
      if (s.status !== "closed") return false;
      const required = readCriteria(s.criteria).filter(isCriterionRequired);
      if (required.length === 0) return false;
      const current = new Map(
        latestEvaluationPerCriterion(bySession.get(s.id) ?? []).map((r) => [
          r.criterionKey,
          r.verdict,
        ])
      );
      return required.every((c) => current.get(c.key) === "pass");
    })
    .map((s) => s.id);
}

/** A tool or skill a run recorded using (`session --used--> tool|skill`). */
export interface RunUsedPart {
  kind: "tool" | "skill";
  id: string;
  name: string;
}

/**
 * What each run USED, from the `session --used--> tool|skill` edges the IS
 * tool-wrapper and `runs.capture` write at the moment of use (the RECORDED
 * part of `readSessionUsage`). Named by the tool's or skill's own row; an
 * edge whose target no longer exists is left out. A run with no edge maps to
 * `[]`. THROWS on a failed read.
 */
export async function loadRunsUsedParts(
  database: typeof Db,
  sessionIds: readonly string[]
): Promise<Map<string, RunUsedPart[]>> {
  const out = new Map<string, RunUsedPart[]>(sessionIds.map((id) => [id, []]));
  if (sessionIds.length === 0) return out;
  const edges = await database
    .select({ fromId: links.fromId, toType: links.toType, toId: links.toId })
    .from(links)
    .where(
      and(
        eq(links.fromType, "session"),
        inArray(links.fromId, [...sessionIds]),
        eq(links.linkType, "used"),
        inArray(links.toType, ["tool", "skill"])
      )
    );
  const idsOf = (kind: string) => [
    ...new Set(
      edges
        .filter((e) => e.toType === kind && isUuid(e.toId))
        .map((e) => e.toId)
    ),
  ];
  const toolIds = idsOf("tool");
  const skillIds = idsOf("skill");
  const names = new Map<string, string>();
  if (toolIds.length > 0) {
    for (const t of await database
      .select({ id: tools.id, name: tools.name })
      .from(tools)
      .where(inArray(tools.id, toolIds))) {
      names.set(`tool:${t.id}`, t.name);
    }
  }
  if (skillIds.length > 0) {
    for (const s of await database
      .select({ id: skills.id, slug: skills.slug, name: skills.name })
      .from(skills)
      .where(inArray(skills.id, skillIds))) {
      // The slug is what `synap_load_skill` takes; the name when it has none.
      names.set(`skill:${s.id}`, s.slug ?? s.name);
    }
  }
  for (const e of edges) {
    const kind = e.toType as RunUsedPart["kind"];
    const name = names.get(`${kind}:${e.toId}`);
    if (!name) continue;
    const list = out.get(e.fromId) ?? [];
    if (!list.some((p) => p.kind === kind && p.id === e.toId)) {
      list.push({ kind, id: e.toId, name });
    }
    out.set(e.fromId, list);
  }
  return out;
}

/**
 * Slack under the earliest `created_at` for the close-event time bound.
 * `focus_sessions.created_at` is stamped by the DATABASE clock (`defaultNow()`)
 * and the close event's `events.timestamp` by the API's (`logEvent`:
 * `new Date()`), so the two can skew; a day absorbs any sane skew and costs at
 * most one more weekly chunk.
 */
const CLOSE_EVENT_BOUND_SLACK_MS = 24 * 60 * 60 * 1000;

/**
 * How many close events each session emitted: ONE grouped read of `events`,
 * TIME-BOUNDED. `events` is a TimescaleDB hypertable (weekly chunks, most
 * compressed); a read with no `timestamp` bound opens every chunk — the
 * correlated count this replaced planned in ~110 ms per call on a live pod,
 * on the hot `synap_get_session` precedents read. The bound makes the planner
 * exclude the chunks older than the sessions.
 *
 * WHY THE BOUND IS SAFE: a session's close event cannot precede its creation.
 * The one close door (`complete-session.ts`) writes it through `logEvent`
 * with `timestamp: new Date()` at close time, never backdated, and nothing
 * rewrites `focus_sessions.created_at` after insert. A peer's sync replay
 * carries both the session's `createdAt` and the event's `timestamp` from the
 * origin pod, so they stay ordered. Not covered: a replayed session row
 * WITHOUT `createdAt`, which the sync door stamps with the local now.
 *
 * A session with no close event maps to no entry (the caller reads 0). THROWS
 * on a failed read.
 */
async function countCloseEvents(
  database: typeof Db,
  sessions: ReadonlyArray<{ id: string; createdAt: Date | string }>
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (sessions.length === 0) return out;
  const earliest = Math.min(
    ...sessions.map((s) => new Date(s.createdAt).getTime())
  );
  const since = new Date(earliest - CLOSE_EVENT_BOUND_SLACK_MS);
  const rows = await database
    .select({
      subjectId: events.subjectId,
      n: drizzleSql<number>`count(*)::int`,
    })
    .from(events)
    .where(
      and(
        eq(events.type, FOCUS_SESSION_CLOSED_EVENT_TYPE),
        inArray(
          events.subjectId,
          sessions.map((s) => s.id)
        ),
        drizzleSql`${events.timestamp} >= ${since.toISOString()}`
      )
    )
    .groupBy(events.subjectId);
  for (const r of rows) out.set(r.subjectId, Number(r.n));
  return out;
}

/**
 * The rows the projection reads: every session of `playbookId` owned by
 * `userId` (optionally only those closed after `closedAfter`), with its close-
 * event count, and every evaluation row of those sessions.
 */
export async function loadPlaybookScorecardRows(
  database: typeof Db,
  params: {
    playbookIds: string[];
    userId: string;
    closedAfter?: Date | null;
    /** At most this many sessions, the most recently closed first. */
    limit?: number;
  }
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
      // The lower time bound of the close-event read below.
      createdAt: focusSessions.createdAt,
      // The follow receipt the attach door stamps (`follow-playbook.ts`).
      // PRESENCE of the marker, not its shape: `#>>` yields a text value for a
      // JSON value of any type, and a row stamped by any future follow door
      // must read as attached rather than silently as instantiated.
      followedVia: drizzleSql<
        string | null
      >`${focusSessions.metadata} #>> '{followedVia}'`,
    })
    .from(focusSessions)
    .where(where)
    .orderBy(drizzleSql`${focusSessions.closedAt} desc nulls last`)
    .limit(params.limit ?? Number.MAX_SAFE_INTEGER);
  const closeEvents = await countCloseEvents(database, rows);
  const sessions = rows.map(({ createdAt: _createdAt, ...r }) => ({
    ...r,
    status: String(r.status),
    closeEvents: closeEvents.get(r.id) ?? 0,
    attached: r.followedVia != null,
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
