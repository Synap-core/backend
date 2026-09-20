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
 *   3. ESCALATION, NOT A NEW STATUS. When the LAST allowed non-human attempt on a
 *      REQUIRED criterion is not a pass, the criterion is handed to the human
 *      through the EXISTING owed-slot mechanism: an ExpectedOutput with
 *      `owner: "human"` + `blockedReason: "decision"` (Needs-you). A later human
 *      grade attests that slot through the existing attest door.
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
  type SessionCriterion,
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
import { NotificationService } from "../../../notifications/NotificationService.js";
import { updateExpectedOutputsLocked } from "../delegate-output.js";
import { reconcileOwedSince } from "../update-session.js";
import { normalizeExpectedLabel } from "../expected-label.js";
import { attestExpectedOutput } from "../satisfy-expected-output.js";

/** Non-human attempts allowed per criterion per session before escalation. */
export const MAX_NON_HUMAN_ATTEMPTS = 2;

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
      /** True when this row handed the criterion to the human (owed slot filed). */
      escalated: boolean;
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

    const escalate =
      evaluatorKind !== "human" &&
      params.verdict !== "pass" &&
      nonHuman + 1 >= MAX_NON_HUMAN_ATTEMPTS &&
      isCriterionRequired(criterion);

    return {
      status: "recorded" as const,
      evaluation: evaluation!,
      criterion,
      escalate,
      // Carried out of the transaction so the escalation notification can name
      // the session without a second read. `attempts` is the count INCLUDING
      // the row just written — what the founder is told they were checked.
      session: {
        id: session.id,
        userId: session.userId,
        workspaceId: session.workspaceId,
        title: resolveSessionTitle(session),
      },
      attempts: nonHuman + 1,
    };
  });

  if (outcome.status !== "recorded") return outcome;

  // After the commit: the owed-slot doors take their own row lock.
  let escalated = false;
  if (outcome.escalate) {
    escalated = await fileCriterionSlot(sessionId, outcome.criterion);
    // TELL THE PERSON. The owed slot above puts the criterion in the needs-you
    // tray, which they see only if they open the app and look — and an
    // escalation is, by definition, work that has STOPPED until they answer.
    // This call sits inside the same `if` as the slot, not beside it and not in
    // a reactor, for one reason: there is no escalation EVENT. Escalation is a
    // branch of this function, so the notification has to be a branch of it
    // too, and putting it here means the slot and the notification are written
    // under one condition and can never disagree about whether an escalation
    // happened.
    //
    // ONE per session, not one per criterion: the registry type declares a
    // session-keyed `dedupeWindowMs`, so the second criterion to escalate in
    // the same run writes no row and raises no push. `create()` never throws.
    await NotificationService.create({
      type: CRITERION_ESCALATED_NOTIFICATION_TYPE,
      userId: outcome.session.userId,
      workspaceId: outcome.session.workspaceId,
      sourceType: "session",
      // The SESSION is the destination — the registry's `navigate-object`
      // action and the push tap both read this as the object id.
      sourceId: outcome.session.id,
      groupKey: criterionEscalationGroupKey(outcome.session.id),
      data: {
        sessionId: outcome.session.id,
        sessionTitle: outcome.session.title,
        criterionKey: outcome.criterion.key,
        criterionStatement: outcome.criterion.statement,
        attempts: outcome.attempts,
      },
    });
  } else if (evaluatorKind === "human") {
    // The human answered the question an escalation asked — discharge the slot
    // through the ONE attest door. Any refusal (no slot, already done) is fine.
    await attestExpectedOutput({
      sessionId,
      userId,
      expectedLabel: criterionSlotLabel(outcome.criterion),
    });
  }

  return { status: "recorded", evaluation: outcome.evaluation, escalated };
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

/** File the human-owned slot for an escalated criterion; idempotent by label. */
async function fileCriterionSlot(
  sessionId: string,
  criterion: SessionCriterion
): Promise<boolean> {
  const label = criterionSlotLabel(criterion);
  const wanted = normalizeExpectedLabel(label);
  return updateExpectedOutputsLocked(sessionId, (current) => {
    if (current.some((o) => normalizeExpectedLabel(o?.label) === wanted)) {
      return null;
    }
    return [
      ...current,
      reconcileOwedSince({
        kind: CRITERION_SLOT_KIND,
        label,
        status: "pending",
        owner: "human",
        blockedReason: "decision",
        why: criterionSlotWhy(criterion),
      }),
    ];
  });
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
>(rows: T[]): Promise<Array<T & { verdict?: SessionVerdict }>> {
  const graded = rows.filter((r) => readCriteria(r.criteria).length > 0);
  if (graded.length === 0) return rows;
  const evals = await db
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
