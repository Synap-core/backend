/**
 * recordSessionEvaluation — THE ONE WRITE DOOR for `session_evaluations`.
 *
 * A session carries binary criteria (`focus_sessions.criteria`); each grade is
 * an append-only row here, never a field on the session. Every writer — the
 * evidence door, `evaluateSession`, the human `grade` door — comes through this
 * function, so the four rules below cannot fork between them:
 *
 *   1. HUMAN IS FINAL. Only the session owner, acting as a human (no agent key),
 *      may write a `human` row. Once one exists for a criterion, non-human rows
 *      for it are refused — the projection would ignore them anyway, and a row
 *      that can never count is noise that burns an attempt.
 *   2. BOUNDED RETRIES. At most `MAX_NON_HUMAN_ATTEMPTS` non-human rows per
 *      criterion per session; the next is refused (`attempts_exhausted`).
 *   3. ESCALATION, NOT A NEW STATUS — AND NOT MID-SESSION. When the LAST
 *      allowed non-human attempt on a REQUIRED criterion is not a pass, the
 *      row is `exhausted`: the criterion stays the AGENT's work, and the
 *      caller shows it as news in the session room (`evaluate.ts`). It is
 *      handed to the human only when the session is evaluated through
 *      `evaluate_session` ({@link escalateFailingCriteria}, founder decision
 *      E3, 2026-10-27), through the EXISTING owed-slot mechanism: an
 *      ExpectedOutput with `owner: "human"` + `blockedReason: "decision"`
 *      (Needs-you). A later human grade attests that slot through the
 *      existing attest door. Before E3 every second failed self-grade put a
 *      "Check: …" slot in the founder's Needs you while the agent was still
 *      at work.
 *   4. NO SELF-GRADING. A `judge` row whose evaluator is the agent that worked
 *      the session (its caller, its roster, or the model it ran on) is refused.
 *
 * Serialised on the session row (`FOR UPDATE`) so two concurrent evaluations
 * cannot both read "1 attempt so far" and write a third.
 */

import {
  db,
  focusSessions,
  sessionEvaluations,
  and,
  asc,
  eq,
  inArray,
} from "@synap/database";
import type { FocusSession } from "@synap/database";
import {
  isCriterionRequired,
  readCriteria,
  type ExpectedOutput,
  type SessionCriterion,
  type SlotAnswerValue,
  type SlotAsk,
} from "@synap/playbooks";
import {
  CRITERION_SLOT_KIND,
  computeSessionVerdict,
  latestEvaluationPerCriterion,
  resolveSessionTitle,
  type EvaluationVerdict,
  type EvaluatorKind,
  type SessionVerdict,
} from "@synap-core/types/focus-sessions";
import { createLogger } from "@synap-core/core";
import { NotificationService } from "../../../notifications/NotificationService.js";
import { updateExpectedOutputsLocked } from "../delegate-output.js";
import { reconcileOwedSince } from "../update-session.js";
import { normalizeExpectedLabel } from "../expected-label.js";
import { attestExpectedOutput } from "../satisfy-expected-output.js";

/** Non-human attempts allowed per criterion per session before escalation. */
export const MAX_NON_HUMAN_ATTEMPTS = 2;

const logger = createLogger({ module: "criterion-evaluations" });

/**
 * The registry type this file produces — declared under the lowercase name
 * `notificationType` first, deliberately. `notification-producer-allowlist.test.ts`
 * proves a registry row has a producer by scanning source for the literal next
 * to a case-SENSITIVE `(type|notificationType)\s*[:=?]`, so a SCREAMING_SNAKE
 * declaration alone is invisible to it and a real producer reads as a dead row.
 * (Same trick, same reason, as `session-unblock-reactor.ts`.)
 */
const notificationType = "session.criterion_escalated" as const;
export const CRITERION_ESCALATED_NOTIFICATION_TYPE = notificationType;

/**
 * The escalation's identity is the SESSION, not the criterion — the founder's
 * decision: one grouped notification per session. Used as both the display
 * group and the suppression key (`dedupeWindowMs` in the registry).
 */
export function criterionEscalationGroupKey(sessionId: string): string {
  return `${CRITERION_ESCALATED_NOTIFICATION_TYPE}:${sessionId}`;
}

/** Longest criterion statement quoted in the escalation `why` (500-char cap). */
export const CRITERION_WHY_STATEMENT_MAX = 400;

export type SessionEvaluationRow = typeof sessionEvaluations.$inferSelect;

export interface RecordSessionEvaluationParams {
  sessionId: string;
  /** Owner floor — the session must belong to this user. */
  userId: string;
  /** Set when an AGENT drives the write. A human row may never carry one. */
  agentUserId?: string | null;
  criterionKey: string;
  verdict: EvaluationVerdict;
  evaluatorKind: EvaluatorKind;
  /** agent id / capability verb / model id; defaulted for human + evidence rows. */
  evaluatorId?: string | null;
  evidence?: Record<string, unknown>;
  rationale?: string | null;
}

export type RecordSessionEvaluationResult =
  | { status: "not_found" }
  | { status: "unknown_criterion" }
  | { status: "refused"; reason: string }
  | { status: "attempts_exhausted"; attempts: number }
  | {
      status: "recorded";
      evaluation: SessionEvaluationRow;
      /**
       * True when this row spent the LAST non-human attempt on a REQUIRED
       * criterion without a pass. Nothing is handed to the person here (rule
       * 3): `evaluate_session` escalates it ({@link escalateFailingCriteria}).
       */
      exhausted: boolean;
    };

/** The label of the owed slot an escalated criterion files. */
export function criterionSlotLabel(criterion: SessionCriterion): string {
  const label = `Check: ${criterion.statement}`;
  return label.length > 120 ? `${label.slice(0, 119)}…` : label;
}

/**
 * Everything that WORKED the session and therefore may not judge it: the
 * acting agent, the invited roster, and the model the session ran on when the
 * producer recorded one (`metadata.modelId`).
 */
export function workingIdentities(
  session: Pick<FocusSession, "agentIds" | "metadata">,
  agentUserId?: string | null
): Set<string> {
  const ids = new Set<string>(session.agentIds ?? []);
  if (agentUserId) ids.add(agentUserId);
  const modelId = (session.metadata as { modelId?: unknown } | null)?.modelId;
  if (typeof modelId === "string" && modelId) ids.add(modelId);
  return ids;
}

export async function recordSessionEvaluation(
  params: RecordSessionEvaluationParams
): Promise<RecordSessionEvaluationResult> {
  const { sessionId, userId, criterionKey, evaluatorKind } = params;
  const agentUserId = params.agentUserId ?? null;

  if (evaluatorKind === "human" && agentUserId) {
    return {
      status: "refused",
      reason:
        "Only the session owner can grade a criterion as a human — an agent cannot.",
    };
  }

  const outcome = await db.transaction(async (tx) => {
    const [session] = await tx
      .select()
      .from(focusSessions)
      .where(
        and(eq(focusSessions.id, sessionId), eq(focusSessions.userId, userId))
      )
      .for("update");
    if (!session) return { status: "not_found" as const };

    const criterion = readCriteria(session.criteria).find(
      (c) => c.key === criterionKey
    );
    if (!criterion) return { status: "unknown_criterion" as const };

    const prior = await tx
      .select({ evaluatorKind: sessionEvaluations.evaluatorKind })
      .from(sessionEvaluations)
      .where(
        and(
          eq(sessionEvaluations.sessionId, sessionId),
          eq(sessionEvaluations.criterionKey, criterionKey)
        )
      );
    const nonHuman = prior.filter((r) => r.evaluatorKind !== "human").length;

    let evaluatorId = params.evaluatorId ?? null;
    if (evaluatorKind === "human") {
      evaluatorId = userId;
    } else {
      if (prior.some((r) => r.evaluatorKind === "human")) {
        return {
          status: "refused" as const,
          reason: `"${criterionKey}" was already graded by a person — that verdict is final.`,
        };
      }
      if (nonHuman >= MAX_NON_HUMAN_ATTEMPTS) {
        return { status: "attempts_exhausted" as const, attempts: nonHuman };
      }
      if (evaluatorKind === "judge") {
        if (!evaluatorId) {
          return {
            status: "refused" as const,
            reason: "A judge verdict must name the model that judged it.",
          };
        }
        if (workingIdentities(session, agentUserId).has(evaluatorId)) {
          return {
            status: "refused" as const,
            reason: `"${evaluatorId}" worked this session and may not judge it.`,
          };
        }
      }
      if (!evaluatorId) evaluatorId = agentUserId ?? userId;
    }

    const [evaluation] = await tx
      .insert(sessionEvaluations)
      .values({
        sessionId,
        userId: session.userId,
        workspaceId: session.workspaceId,
        criterionKey,
        attempt: prior.length + 1,
        verdict: params.verdict,
        evaluatorKind,
        evaluatorId,
        evidence: params.evidence ?? {},
        rationale: params.rationale ?? null,
      })
      .returning();

    const exhausted =
      evaluatorKind !== "human" &&
      params.verdict !== "pass" &&
      nonHuman + 1 >= MAX_NON_HUMAN_ATTEMPTS &&
      isCriterionRequired(criterion);

    return {
      status: "recorded" as const,
      evaluation: evaluation!,
      criterion,
      exhausted,
      trackId: session.trackId ?? null,
    };
  });

  if (outcome.status !== "recorded") return outcome;

  if (evaluatorKind === "human") {
    // The human answered the question an escalation asked — discharge the slot
    // through the ONE attest door. Any refusal (no slot, already done) is fine.
    await attestExpectedOutput({
      sessionId,
      userId,
      expectedLabel: criterionSlotLabel(outcome.criterion),
      // The verdict IS the answer the slot's pass/fail ask wanted.
      criterionGraded: true,
    });
  }

  // A grade on a run filed into a goal may CLAIM one of its criteria, put
  // the goal in review, or take a claim back (a later fail): its judge's
  // items are refreshed — judgements, first in their Needs you (W5, F1).
  // After the commit; never throws. Loaded on use: the goal reader pulls the
  // tracks service graph, which this module must not drag into every
  // importer at init.
  if (outcome.trackId) {
    const { refreshGoalJudgements } =
      await import("../../tracks/goal-review-notice.js");
    await refreshGoalJudgements(outcome.trackId);
  }

  return {
    status: "recorded",
    evaluation: outcome.evaluation,
    exhausted: outcome.exhausted,
  };
}

/**
 * HAND THE PERSON what the agent could not pass (rule 3) — run by
 * `evaluate_session`, never by a mid-session grade. Every REQUIRED criterion
 * whose non-human attempts are spent, that a person has not graded, and whose
 * latest verdict is not a pass gets its owed slot (idempotent by label).
 * Returns the keys whose slot was filed now.
 *
 * TELL THE PERSON in the same branch: the slot puts the criterion in the
 * needs-you tray, which they see only if they look, and an escalation is work
 * that has STOPPED until they answer. There is no escalation EVENT, so the
 * notification is written under the same condition as the slots and the two
 * can never disagree about whether an escalation happened. ONE per session,
 * not one per criterion: the registry type declares a session-keyed
 * `dedupeWindowMs`. `create()` never throws.
 */
export async function escalateFailingCriteria(params: {
  sessionId: string;
  /** Owner floor — the session must belong to this user. */
  userId: string;
}): Promise<string[]> {
  const session = await db.query.focusSessions.findFirst({
    where: and(
      eq(focusSessions.id, params.sessionId),
      eq(focusSessions.userId, params.userId)
    ),
  });
  if (!session) return [];
  const criteria = readCriteria(session.criteria).filter(isCriterionRequired);
  if (criteria.length === 0) return [];
  const rows = await listSessionEvaluations({
    sessionId: session.id,
    userId: session.userId,
  });
  const latest = new Map(
    latestEvaluationPerCriterion(rows).map((r) => [r.criterionKey, r.verdict])
  );
  const escalated: Array<{ criterion: SessionCriterion; attempts: number }> =
    [];
  for (const criterion of criteria) {
    const mine = rows.filter((r) => r.criterionKey === criterion.key);
    if (mine.some((r) => r.evaluatorKind === "human")) continue;
    const attempts = mine.filter((r) => r.evaluatorKind !== "human").length;
    if (attempts < MAX_NON_HUMAN_ATTEMPTS) continue;
    if (latest.get(criterion.key) === "pass") continue;
    // After any commit: the owed-slot door takes its own row lock.
    if (
      await fileCriterionSlot(
        session.id,
        criterion,
        criterionSlotWhy(criterion)
      )
    ) {
      escalated.push({ criterion, attempts });
    }
  }
  const [first] = escalated;
  if (first) {
    await NotificationService.create({
      type: CRITERION_ESCALATED_NOTIFICATION_TYPE,
      userId: session.userId,
      workspaceId: session.workspaceId,
      sourceType: "session",
      // The SESSION is the destination — the registry's `navigate-object`
      // action and the push tap both read this as the object id.
      sourceId: session.id,
      groupKey: criterionEscalationGroupKey(session.id),
      data: {
        sessionId: session.id,
        sessionTitle: resolveSessionTitle(session),
        criterionKey: first.criterion.key,
        criterionStatement: first.criterion.statement,
        // What the founder is told they were checked.
        attempts: first.attempts,
      },
    });
  }
  return escalated.map((e) => e.criterion.key);
}

/**
 * The news a spent criterion is in the session room while the agent still
 * works (rule 3): what failed, and that the person is not asked yet.
 */
export function criterionExhaustedNews(criterion: SessionCriterion): string {
  return `"${criterion.statement}" is still not passing after ${MAX_NON_HUMAN_ATTEMPTS} checks. It stays with the agent; you are asked only if it still fails when the session is evaluated.`;
}

/**
 * WHY the person is being asked. Names the criterion's STATEMENT, never its
 * `key` — the key is a machine slug (`no-stale`) and this sentence is read in
 * the needs-you tray. The statement is clipped so the whole sentence fits the
 * 500-char `why` ceiling the slot doors enforce.
 */
export function criterionSlotWhy(criterion: SessionCriterion): string {
  const statement =
    criterion.statement.length > CRITERION_WHY_STATEMENT_MAX
      ? `${criterion.statement.slice(0, CRITERION_WHY_STATEMENT_MAX - 1)}…`
      : criterion.statement;
  return `Checked ${MAX_NON_HUMAN_ATTEMPTS} times and still not passing — mark "${statement}" pass or fail.`;
}

/**
 * The ask on an escalated criterion's slot. The option VALUES are the grade
 * door's verdicts (`EvaluationVerdict` pass | fail), so an answer maps onto
 * `recordSessionEvaluation` with no translation table.
 */
export const CRITERION_SLOT_ASK: SlotAsk = {
  mode: "choose",
  options: [
    { label: "Pass", value: "pass" },
    { label: "Fail", value: "fail" },
  ],
  // Closed: the answer IS the verdict (`criterionVerdictOf`); words would
  // mark the slot answered while the grade never moves.
  allowOther: false,
};

/** A criterion slot answer's verdict, or `null` when it is not pass/fail. */
export function criterionVerdictOf(
  value: SlotAnswerValue | undefined
): "pass" | "fail" | null {
  if (value?.type !== "chip") return null;
  const v = value.chip.value ?? value.chip.label;
  return v === "pass" || v === "fail" ? v : null;
}

/**
 * THE GRADES DECLARED UP FRONT (work-model W5), kept in step with the
 * session's criteria — one locked write, after every criteria write (the
 * create, update and follow doors, and their approved proposals). The rule is
 * {@link reconcileGradeSlots}. NEVER THROWS: it runs after the session's own
 * write has committed, so a failure is logged and reported as `error`, never
 * thrown over a session that exists. `outputs` is the list as written, `null`
 * when nothing changed.
 */
export async function fileDeclaredGradeSlots(sessionId: string): Promise<{
  filed: string[];
  outputs: ExpectedOutput[] | null;
  error?: string;
}> {
  try {
    const session = await db.query.focusSessions.findFirst({
      where: eq(focusSessions.id, sessionId),
      columns: { criteria: true, userId: true },
    });
    if (!session) return { filed: [], outputs: null };
    const criteria = readCriteria(session.criteria);
    const graded = new Set(
      (await listSessionEvaluations({ sessionId, userId: session.userId }))
        .filter((r) => r.evaluatorKind === "human")
        .map((r) => r.criterionKey)
    );
    let result: ReturnType<typeof reconcileGradeSlots> = null;
    await updateExpectedOutputsLocked(sessionId, (current) => {
      result = reconcileGradeSlots(current, criteria, graded);
      return result?.outputs ?? null;
    });
    const written = result as ReturnType<typeof reconcileGradeSlots>;
    if (!written) return { filed: [], outputs: null };
    // The list as stored (the lock stamps the new slot's key).
    const row = await db.query.focusSessions.findFirst({
      where: eq(focusSessions.id, sessionId),
      columns: { expectedOutputs: true },
    });
    return {
      filed: written.filed,
      outputs: Array.isArray(row?.expectedOutputs)
        ? (row.expectedOutputs as ExpectedOutput[])
        : written.outputs,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.warn({ err, sessionId }, "declared grade slots not reconciled");
    return { filed: [], outputs: null, error };
  }
}

/**
 * A grade slot filed for a criterion declared up front: a criterion slot
 * naming the output it checks. The escalation never stamps `outputKey`, so its
 * slots are never this, and this rule never touches them.
 */
function isDeclaredGradeSlot(o: ExpectedOutput | null | undefined): boolean {
  return (
    o?.kind === CRITERION_SLOT_KIND &&
    typeof o.outputKey === "string" &&
    o.outputKey !== ""
  );
}

/** A criterion the person grades on an output it names: one that gets a slot. */
function declaresGrade(c: SessionCriterion): boolean {
  return isCriterionRequired(c) && c.check.kind === "human" && !!c.outputKey;
}

/**
 * The pure half of {@link fileDeclaredGradeSlots}: the session's slots with
 * its declared grade slots in step with `criteria`, or `null` when nothing
 * changes (a second run over the same criteria writes nothing). A slot is
 * matched to its criterion by `criterionKey` (by label only for a legacy
 * criterion slot that carries none). For a declared grade slot not yet done:
 *   - its criterion still declares a grade (required, `human`, an output
 *     named): the slot follows it — label, why, and the output it waits on;
 *   - its criterion was removed, made optional, moved to a machine check, or
 *     no longer names an output: the slot is withdrawn
 *     (`retiredReason: "withdrawn"`), never left owed;
 * and for every criterion that declares a grade the person has not given yet
 * (`graded`: criterion keys with a human verdict) and that holds no live slot,
 * a withdrawn slot of its own comes back, else a new one is filed. Done slots
 * and the escalation's slots are left as they are.
 */
export function reconcileGradeSlots(
  outputs: readonly ExpectedOutput[],
  criteria: readonly SessionCriterion[],
  graded: ReadonlySet<string> = new Set(),
  now: Date = new Date()
): { outputs: ExpectedOutput[]; filed: string[] } | null {
  const byKey = new Map(criteria.map((c) => [c.key, c]));
  const at = now.toISOString();
  let changed = false;
  const next: ExpectedOutput[] = outputs.map((o) => {
    if (!isDeclaredGradeSlot(o) || o.status === "done") return o;
    if (o.retiredAt != null) return o;
    const c = o.criterionKey ? byKey.get(o.criterionKey) : undefined;
    if (!c || !declaresGrade(c)) {
      changed = true;
      return { ...o, retiredAt: at, retiredReason: "withdrawn" as const };
    }
    const synced = syncGradeSlot(o, c);
    if (synced !== o) changed = true;
    return synced;
  });
  const filed: string[] = [];
  for (const c of criteria) {
    if (!declaresGrade(c) || graded.has(c.key)) continue;
    const label = normalizeExpectedLabel(criterionSlotLabel(c));
    const mine = (o: ExpectedOutput | null | undefined) =>
      o?.kind === CRITERION_SLOT_KIND &&
      (o.criterionKey
        ? o.criterionKey === c.key
        : normalizeExpectedLabel(o.label) === label);
    if (next.some((o) => mine(o) && o.retiredAt == null)) continue;
    const withdrawn = next.findIndex(
      (o) => mine(o) && isDeclaredGradeSlot(o) && o.status !== "done"
    );
    if (withdrawn !== -1) {
      const { retiredAt: _at, retiredReason: _why, ...rest } = next[withdrawn]!;
      next[withdrawn] = syncGradeSlot({ ...rest, owedSince: at }, c);
      filed.push(c.key);
      continue;
    }
    // Never a second slot under a label another slot already holds.
    if (next.some((o) => normalizeExpectedLabel(o?.label) === label)) continue;
    next.push(criterionSlot(c, declaredGradeWhy(c), now));
    filed.push(c.key);
  }
  return changed || filed.length > 0 ? { outputs: next, filed } : null;
}

/** A declared grade slot following its criterion; the same object when equal. */
function syncGradeSlot(o: ExpectedOutput, c: SessionCriterion): ExpectedOutput {
  const label = criterionSlotLabel(c);
  const why = declaredGradeWhy(c);
  if (
    o.label === label &&
    o.why === why &&
    o.outputKey === c.outputKey &&
    o.criterionKey === c.key
  ) {
    return o;
  }
  return { ...o, label, why, outputKey: c.outputKey, criterionKey: c.key };
}

/** WHY the person grades a criterion declared up front (statement clipped). */
export function declaredGradeWhy(criterion: SessionCriterion): string {
  const statement =
    criterion.statement.length > CRITERION_WHY_STATEMENT_MAX
      ? `${criterion.statement.slice(0, CRITERION_WHY_STATEMENT_MAX - 1)}…`
      : criterion.statement;
  return `You grade this one: mark "${statement}" pass or fail.`;
}

/**
 * A criterion's human-owned grade slot. `outputKey` is stamped ONLY for a
 * grade declared up front: an escalated criterion failed its own checks and
 * the person is asked now, whatever its output is doing.
 */
function criterionSlot(
  criterion: SessionCriterion,
  why: string,
  now: Date = new Date(),
  declared = true
): ExpectedOutput {
  return reconcileOwedSince(
    {
      kind: CRITERION_SLOT_KIND,
      label: criterionSlotLabel(criterion),
      // WHICH criterion this slot stands for, as a machine key. The label is
      // prose and is clipped, so a surface must never match it back to find
      // the criterion — that would fork this file's label format into every
      // UI. Slots filed before this field existed carry none.
      criterionKey: criterion.key,
      // The output a declared grade waits on (`isGradeAwaitingOutput`).
      ...(declared && criterion.outputKey
        ? { outputKey: criterion.outputKey }
        : {}),
      status: "pending",
      owner: "human",
      blockedReason: "decision",
      why,
      // HOW the person answers it — pass or fail, rendered by every surface
      // from the generic ask. Answering it reaches THIS module's grade door
      // (`answerSessionSlot` → `gradeCriterionAsOwner`), never a second one.
      ask: CRITERION_SLOT_ASK,
    },
    now
  );
}

/** File the human-owned slot for a criterion's grade; idempotent by label. */
async function fileCriterionSlot(
  sessionId: string,
  criterion: SessionCriterion,
  why: string
): Promise<boolean> {
  const wanted = normalizeExpectedLabel(criterionSlotLabel(criterion));
  return updateExpectedOutputsLocked(sessionId, (current) => {
    const next = withEscalationSlot(current, criterion, why, wanted);
    return next === current ? null : [...next];
  });
}

/**
 * The slots with the escalation's slot for `criterion` filed, or `outputs`
 * itself when it is already there. Pure. A LIVE slot of the criterion (by
 * `criterionKey`, else by label) means it is filed; a WITHDRAWN one comes back
 * as itself, now the escalation's (no `outputKey`: owed at once), never
 * leaving the required criterion with no way to be graded.
 */
export function withEscalationSlot(
  outputs: readonly ExpectedOutput[],
  criterion: SessionCriterion,
  why: string,
  wanted: string | undefined = normalizeExpectedLabel(
    criterionSlotLabel(criterion)
  ),
  now: Date = new Date()
): readonly ExpectedOutput[] {
  const mine = (o: ExpectedOutput | null | undefined) =>
    !!o &&
    (o.kind === CRITERION_SLOT_KIND && o.criterionKey
      ? o.criterionKey === criterion.key
      : normalizeExpectedLabel(o.label) === wanted);
  if (outputs.some((o) => mine(o) && o.retiredAt == null)) return outputs;
  const withdrawn = outputs.findIndex((o) => mine(o) && o.status !== "done");
  const slot = criterionSlot(criterion, why, now, false);
  if (withdrawn === -1) return [...outputs, slot];
  const was = outputs[withdrawn]!;
  return outputs.map((o, i) =>
    i === withdrawn ? { ...slot, ...(was.key ? { key: was.key } : {}) } : o
  );
}

/** Every evaluation row of a session, oldest first (owner-floored). */
export async function listSessionEvaluations(params: {
  sessionId: string;
  userId: string;
}): Promise<SessionEvaluationRow[]> {
  return db
    .select()
    .from(sessionEvaluations)
    .where(
      and(
        eq(sessionEvaluations.sessionId, params.sessionId),
        eq(sessionEvaluations.userId, params.userId)
      )
    )
    .orderBy(asc(sessionEvaluations.createdAt));
}

export interface SessionEvaluationSummary {
  criteria: SessionCriterion[];
  /** The CURRENT row per criterion (human wins), for criteria still declared. */
  evaluations: SessionEvaluationRow[];
  verdict: SessionVerdict;
}

/** Pure: project a session's criteria + all its rows into the read shape. */
export function summarizeEvaluations(
  rawCriteria: unknown,
  rows: readonly SessionEvaluationRow[]
): SessionEvaluationSummary {
  const criteria = readCriteria(rawCriteria);
  const declared = new Set(criteria.map((c) => c.key));
  const evaluations = latestEvaluationPerCriterion(rows).filter((r) =>
    declared.has(r.criterionKey)
  );
  return {
    criteria,
    evaluations,
    verdict: computeSessionVerdict(criteria, evaluations),
  };
}

/**
 * The read shape every session door carries: `criteria`, `verdict`, and the
 * latest evaluation per criterion. One query; none when the session declares
 * no criteria.
 */
export async function loadSessionEvaluationSummary(
  session: Pick<FocusSession, "id" | "userId" | "criteria">
): Promise<SessionEvaluationSummary> {
  const hasCriteria = readCriteria(session.criteria).length > 0;
  const rows = hasCriteria
    ? await listSessionEvaluations({
        sessionId: session.id,
        userId: session.userId,
      })
    : [];
  return summarizeEvaluations(session.criteria, rows);
}

/**
 * Batch the verdict onto a PAGE of session rows — ONE `session_evaluations`
 * read for the whole page, never N+1, and none when no row declares criteria.
 * `verdict` is attached only to rows WITH criteria; a row without it declares
 * none (it is never "unknown"). A failed read THROWS, like the participants
 * projection beside it, so a broken lookup can never render as "no criteria".
 */
export async function attachSessionVerdicts<
  T extends Pick<FocusSession, "id" | "userId" | "criteria">,
>(
  rows: T[],
  database: typeof db = db
): Promise<Array<T & { verdict?: SessionVerdict }>> {
  const graded = rows.filter((r) => readCriteria(r.criteria).length > 0);
  if (graded.length === 0) return rows;
  const evals = await database
    .select()
    .from(sessionEvaluations)
    .where(
      inArray(
        sessionEvaluations.sessionId,
        graded.map((r) => r.id)
      )
    );
  const bySession = new Map<string, SessionEvaluationRow[]>();
  for (const e of evals) {
    const list = bySession.get(e.sessionId) ?? [];
    list.push(e);
    bySession.set(e.sessionId, list);
  }
  return rows.map((r) => {
    if (readCriteria(r.criteria).length === 0) return r;
    // Owner floor, same as `listSessionEvaluations`: only rows the session's
    // owner's evaluations count.
    const mine = (bySession.get(r.id) ?? []).filter(
      (e) => e.userId === r.userId
    );
    return { ...r, verdict: summarizeEvaluations(r.criteria, mine).verdict };
  });
}
