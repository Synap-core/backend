/**
 * evaluateSession — run a session's PENDING criteria through the evaluation
 * ladder, in order of trust:
 *
 *   evidence   — deterministic: the agent posted `{ [evidenceKey]: { passed } }`.
 *                No evidence posted ⇒ nothing is recorded (not a fail).
 *   capability — the criterion's capability verb, via `executeCapability` with
 *                `suppressProposal` (a check never files a proposal). The run's
 *                result must carry a boolean `passed`; anything else — including
 *                an execution ERROR — is `unmeasured` with the reason, never `fail`.
 *   judge      — the IS criteria judge, never the model that worked the session.
 *                It reads the produced work's CONTENT (`judge-material.ts`),
 *                not only the output labels. A judge that could not run
 *                records nothing and says why.
 *   human      — left unmeasured until the owner grades it.
 *
 * "Pending" = not already passing, not human-graded, attempts remaining. Every
 * row goes through `recordSessionEvaluation`, which owns the retry bound — this
 * function decides WHAT to record, and what a spent criterion becomes:
 *
 *   `escalate` (the `evaluate_session` doors) — every required criterion the
 *                agent could not pass is handed to the person
 *                (`escalateFailingCriteria`);
 *   otherwise  (the evidence door, a stage gate's check) — it stays the
 *                agent's work, and the room gets the news (founder decision E3,
 *                2026-10-27: a failed self-grade is not a person's ask until
 *                the session is evaluated).
 */

import {
  db,
  focusSessions,
  and,
  eq,
  drizzleSql,
  setSessionStatus,
} from "@synap/database";
import {
  readCriteria,
  type ExpectedOutput,
  type SessionCriterion,
} from "@synap/playbooks";
import { deriveSlotKeys } from "../slot-keys.js";
import {
  isJudgeRequestRefused,
  judgeSessionCriteria,
  resolveIntelligenceService,
} from "@synap/intelligence-client";
import { createLogger } from "@synap-core/core";
import type { EvaluationVerdict } from "@synap-core/types/focus-sessions";
import { executeCapability } from "../../capabilities/execute-capability.js";
import {
  CHECK_GATE_METADATA_KEY,
  checkGateFailing,
} from "../../playbooks/stage-gate.js";
import {
  MAX_NON_HUMAN_ATTEMPTS,
  criterionExhaustedNews,
  escalateFailingCriteria,
  listSessionEvaluations,
  recordSessionEvaluation,
  summarizeEvaluations,
  type SessionEvaluationRow,
  type SessionEvaluationSummary,
} from "./record.js";
import {
  buildJudgeMaterial,
  isClippedMaterial,
  LEGACY_IS_MATERIAL_MAX,
  loadProducedMaterial,
  loadRoomMaterial,
  MATERIAL_MAX,
} from "./judge-material.js";

const logger = createLogger({ module: "focus-sessions/evaluate" });

/** What an agent posts: one entry per evidence key. */
export type PostedEvidence = Record<
  string,
  { passed: boolean; detail?: string }
>;

export interface EvaluateSessionParams {
  sessionId: string;
  userId: string;
  agentUserId?: string | null;
  evidence?: PostedEvidence;
  /** Restrict to the criteria copied from this stage (the `check` gate). */
  stageKey?: string;
  /**
   * Restrict to these check kinds. The evidence door passes `["evidence"]` so
   * posting evidence never spends an LLM call or runs a capability.
   */
  kinds?: ReadonlyArray<SessionCriterion["check"]["kind"]>;
  /**
   * Restrict to the criteria a fact is ABOUT: a criterion whose key, or whose
   * evidence key, is listed. The event re-check (`dev-loop/recheck-criteria.ts`)
   * passes the outcome keys a fact just moved, so a merge re-grades the
   * criteria on that PR and never the rest of the session.
   */
  criterionKeys?: ReadonlyArray<string>;
  /**
   * Hand the person every required criterion the agent could not pass. Only
   * the `evaluate_session` doors (MCP, Hub REST `/evaluate`, the person's
   * tRPC `evaluate`) set it; absent ⇒ a spent criterion stays the agent's work.
   */
  escalate?: boolean;
}

export interface CriterionRunOutcome {
  key: string;
  /** `recorded` wrote a row; `skipped` wrote nothing and says why. */
  status: "recorded" | "skipped";
  verdict?: EvaluationVerdict;
  reason?: string;
  escalated?: boolean;
}

export type EvaluateSessionResult =
  | { status: "not_found" }
  | ({
      status: "evaluated";
      results: CriterionRunOutcome[];
      /** True when this evaluation cleared a check gate and resumed the run. */
      resumed: boolean;
    } & SessionEvaluationSummary);

/** Pure: which criteria still need a non-human check. */
export function pendingCriteria(
  criteria: SessionCriterion[],
  rows: readonly Pick<
    SessionEvaluationRow,
    "criterionKey" | "evaluatorKind" | "verdict"
  >[],
  latest: readonly Pick<SessionEvaluationRow, "criterionKey" | "verdict">[]
): SessionCriterion[] {
  const current = new Map(latest.map((r) => [r.criterionKey, r.verdict]));
  return criteria.filter((c) => {
    if (c.check.kind === "human") return false;
    if (current.get(c.key) === "pass") return false;
    const mine = rows.filter((r) => r.criterionKey === c.key);
    if (mine.some((r) => r.evaluatorKind === "human")) return false;
    return mine.length < MAX_NON_HUMAN_ATTEMPTS;
  });
}

/**
 * Pure: a capability run's outcome as a verdict. Only an explicit boolean
 * `passed` on a completed run is a verdict; everything else is unmeasured.
 */
export function capabilityVerdict(
  result: Awaited<ReturnType<typeof executeCapability>>
): { verdict: EvaluationVerdict; rationale: string } {
  if (result.kind === "run") {
    const passed = (result.result as { passed?: unknown } | null)?.passed;
    if (typeof passed === "boolean") {
      const detail = (result.result as { detail?: unknown }).detail;
      return {
        verdict: passed ? "pass" : "fail",
        rationale: typeof detail === "string" ? detail : `passed: ${passed}`,
      };
    }
    return {
      verdict: "unmeasured",
      rationale: "The capability ran but returned no boolean `passed`.",
    };
  }
  const why =
    "message" in result
      ? result.message
      : "reason" in result
        ? result.reason
        : result.kind;
  return {
    verdict: "unmeasured",
    rationale: `The check could not run (${result.kind}): ${why}`,
  };
}

/**
 * The outcome a criterion checks, as a capability parameter: the session's
 * slot with the criterion's key, `{ outcome: {key, kind, label, ref?} }`, or
 * nothing when there is none. Pure.
 */
export function outcomeParameter(
  expectedOutputs: unknown,
  criterionKey: string
): { outcome?: { key: string; kind: string; label: string; ref?: unknown } } {
  const slots = Array.isArray(expectedOutputs)
    ? (expectedOutputs as ExpectedOutput[])
    : [];
  const index = deriveSlotKeys(slots).indexOf(criterionKey);
  const slot = index === -1 ? undefined : slots[index];
  if (!slot) return {};
  return {
    outcome: {
      key: criterionKey,
      kind: slot.kind,
      label: slot.label,
      ...(slot.ref ? { ref: slot.ref } : {}),
    },
  };
}

export async function evaluateSession(
  params: EvaluateSessionParams
): Promise<EvaluateSessionResult> {
  const { sessionId, userId } = params;
  const agentUserId = params.agentUserId ?? null;

  const session = await db.query.focusSessions.findFirst({
    where: and(
      eq(focusSessions.id, sessionId),
      eq(focusSessions.userId, userId)
    ),
  });
  if (!session) return { status: "not_found" };

  const criteria = readCriteria(session.criteria);
  const rows = await listSessionEvaluations({ sessionId, userId });
  const before = summarizeEvaluations(session.criteria, rows);
  const pending = pendingCriteria(criteria, rows, before.evaluations).filter(
    (c) =>
      (params.stageKey === undefined || c.stageKey === params.stageKey) &&
      (params.kinds === undefined || params.kinds.includes(c.check.kind)) &&
      (params.criterionKeys === undefined ||
        params.criterionKeys.includes(c.key) ||
        (c.check.kind === "evidence" &&
          c.check.evidenceKey !== undefined &&
          params.criterionKeys.includes(c.check.evidenceKey)))
  );

  const results: CriterionRunOutcome[] = [];
  const exhausted: SessionCriterion[] = [];
  const record = async (
    c: SessionCriterion,
    verdict: EvaluationVerdict,
    extra: {
      evaluatorId?: string | null;
      evidence?: Record<string, unknown>;
      rationale?: string;
    }
  ) => {
    const out = await recordSessionEvaluation({
      sessionId,
      userId,
      agentUserId,
      criterionKey: c.key,
      verdict,
      evaluatorKind: c.check.kind,
      ...extra,
    });
    if (out.status === "recorded" && out.exhausted) exhausted.push(c);
    results.push(
      out.status === "recorded"
        ? { key: c.key, status: "recorded", verdict, escalated: false }
        : {
            key: c.key,
            status: "skipped",
            reason: "reason" in out ? out.reason : out.status,
          }
    );
  };

  const judged: SessionCriterion[] = [];
  for (const c of pending) {
    if (c.check.kind === "evidence") {
      const posted = c.check.evidenceKey
        ? params.evidence?.[c.check.evidenceKey]
        : undefined;
      if (!posted || typeof posted.passed !== "boolean") {
        results.push({
          key: c.key,
          status: "skipped",
          reason: "No evidence posted yet.",
        });
        continue;
      }
      await record(c, posted.passed ? "pass" : "fail", {
        evidence: { [c.check.evidenceKey!]: posted },
        ...(posted.detail ? { rationale: posted.detail } : {}),
      });
    } else if (c.check.kind === "capability") {
      const run = await executeCapability({
        verbId: c.check.capability,
        parameters: {
          sessionId,
          criterionKey: c.key,
          // The outcome this criterion checks (same key), with its `ref`, so
          // a verb that reads the world (a GitHub PR read) can find WHAT to
          // check without a second lookup (plan v5 T2).
          ...outcomeParameter(session.expectedOutputs, c.key),
        },
        workspaceId: session.workspaceId,
        userId,
        agentUserId,
        suppressProposal: true,
        // A check run is a measurement, not work: the event only, never a
        // "Ran capability …" recall fact per attempt.
        observability: "mirror",
        sessionId,
      });
      const { verdict, rationale } = capabilityVerdict(run);
      await record(c, verdict, { evaluatorId: c.check.capability, rationale });
    } else if (c.check.kind === "judge") {
      judged.push(c);
    }
  }

  if (judged.length > 0) {
    try {
      const svc = await resolveIntelligenceService({
        userId,
        workspaceId: session.workspaceId ?? undefined,
      });
      const modelId = (session.metadata as { modelId?: unknown } | null)
        ?.modelId;
      // The judge reads the WORK, not its labels: the produced documents' and
      // entities' content, floored to the session owner. A failed read throws
      // into the catch below ("the judge could not run"), never a verdict
      // over labels alone.
      // The room is read too (evidence is often posted there), as the owner:
      // a room they cannot read, or a failed read, is stated in the material,
      // not fatal to the judge.
      const [produced, room] = await Promise.all([
        loadProducedMaterial({ sessionId, userId }),
        loadRoomMaterial({ channelId: session.channelId, userId }),
      ]);
      // Earlier verdicts of EVERY criterion graded now are withheld from
      // every call, so a split into several calls never shows one criterion
      // another's prior verdict on itself.
      const judgedKeys = new Set(judged.map((c) => c.key));
      const material = (max: number, focus?: SessionCriterion) =>
        buildJudgeMaterial(
          session,
          rows,
          params.evidence,
          produced,
          room,
          max,
          judgedKeys,
          focus
            ? {
                key: focus.key,
                statement: focus.statement,
                ...(focus.check.hint ? { hint: focus.check.hint } : {}),
              }
            : undefined
        );
      // ONE call over one shared material while everything fits. Once
      // something must be cut, each criterion gets material chosen for it
      // (its outline + sections, `judge-material.ts` `excerpt`), and criteria
      // whose material comes out identical share a call.
      const shared = material(MATERIAL_MAX);
      const scoped = isClippedMaterial(shared);
      const groups = new Map<string, SessionCriterion[]>();
      for (const c of judged) {
        const m = scoped ? material(MATERIAL_MAX, c) : shared;
        groups.set(m, [...(groups.get(m) ?? []), c]);
      }
      for (const [first, group] of groups) {
        try {
          const judge = (m: string) =>
            judgeSessionCriteria(svc.endpoint, svc.serviceApiKey, {
              criteria: group.map((c) => ({
                key: c.key,
                statement: c.statement,
                ...(c.check.hint ? { hint: c.check.hint } : {}),
              })),
              material: m,
              ...(typeof modelId === "string" && modelId
                ? { excludeModel: modelId }
                : {}),
            });
          // An IS deployed before the material cap was raised refuses the
          // larger material as a bad request: rebuild it at that IS's cap
          // (the same fair budget and the same focus, not a blind cut) and
          // ask ONCE more. Any other failure, or a second refusal, is "the
          // judge could not run" below.
          const judgement = await judge(first).catch((err: unknown) => {
            if (!isJudgeRequestRefused(err)) throw err;
            logger.warn(
              {
                sessionId,
                err: err instanceof Error ? err.message : String(err),
              },
              `IS refused the judge request; retrying with material capped at ${LEGACY_IS_MATERIAL_MAX}`
            );
            return judge(
              material(LEGACY_IS_MATERIAL_MAX, scoped ? group[0] : undefined)
            );
          });
          const byKey = new Map(judgement.verdicts.map((v) => [v.key, v]));
          for (const c of group) {
            const v = byKey.get(c.key);
            if (judgement.decider === "none" || !judgement.model || !v) {
              results.push({
                key: c.key,
                status: "skipped",
                reason: v?.rationale || "No judge could grade this criterion.",
              });
              continue;
            }
            await record(c, v.verdict, {
              evaluatorId: judgement.model,
              rationale: v.rationale,
            });
          }
        } catch (err) {
          const reason = `The judge could not run: ${err instanceof Error ? err.message : String(err)}`;
          for (const c of group)
            results.push({ key: c.key, status: "skipped", reason });
        }
      }
    } catch (err) {
      const reason = `The judge could not run: ${err instanceof Error ? err.message : String(err)}`;
      for (const c of judged)
        results.push({ key: c.key, status: "skipped", reason });
    }
  }

  if (params.escalate) {
    const escalated = new Set(
      await escalateFailingCriteria({ sessionId, userId })
    );
    for (const r of results) if (escalated.has(r.key)) r.escalated = true;
  } else if (exhausted.length > 0 && session.channelId) {
    await postExhaustedNews(session.channelId, session.userId, exhausted);
  }

  const after = summarizeEvaluations(
    session.criteria,
    await listSessionEvaluations({ sessionId, userId })
  );
  const resumed = await resumeCheckGateIfMet({
    sessionId,
    userId,
    summary: after,
  });
  return { status: "evaluated", results, resumed, ...after };
}

/**
 * The room's news about spent criteria: a POD notice (role system), never an
 * ask. Never throws: the grades are recorded; a failed post only loses the news.
 */
async function postExhaustedNews(
  channelId: string,
  userId: string,
  criteria: readonly SessionCriterion[]
): Promise<void> {
  try {
    // Loaded on use: the messaging door pulls the room-question graph, which
    // this module must not drag into every importer at init.
    const { postChannelMessage } =
      await import("../../messaging/post-message.js");
    await postChannelMessage({
      channelId,
      content: criteria.map(criterionExhaustedNews).join("\n"),
      userId,
      role: "system",
    });
  } catch (err) {
    logger.warn(
      { channelId, err: err instanceof Error ? err.message : String(err) },
      "could not post the spent-criterion news to the session room"
    );
  }
}

/**
 * The OWNER's verdict on one criterion — THE grade door, whichever surface it
 * came through: the scorecard (tRPC `focusSessions.grade`) or the answer to a
 * criterion slot's pass/fail ask (`answerSessionSlot`). A human row, final
 * over every evidence / capability / judge row; it discharges the criterion's
 * escalation slot (`recordSessionEvaluation`) and resumes a check-gated pause
 * it clears. One function so the two entrances cannot grade two ways.
 */
export async function gradeCriterionAsOwner(params: {
  sessionId: string;
  userId: string;
  criterionKey: string;
  verdict: EvaluationVerdict;
  rationale?: string | null;
}): Promise<{
  out: Awaited<ReturnType<typeof recordSessionEvaluation>>;
  resumed: boolean;
}> {
  const out = await recordSessionEvaluation({
    sessionId: params.sessionId,
    userId: params.userId,
    criterionKey: params.criterionKey,
    verdict: params.verdict,
    evaluatorKind: "human",
    rationale: params.rationale ?? null,
  });
  if (out.status !== "recorded") return { out, resumed: false };
  const resumed = await resumeCheckGateIfMet({
    sessionId: params.sessionId,
    userId: params.userId,
  });
  return { out, resumed };
}

/**
 * {@link gradeCriterionAsOwner} AFTER the person's act committed: their
 * answer to a criterion slot's pass/fail ask, or a task of theirs that meets
 * a criterion (`criterionMetBy`, satisfy-expected-output.ts — plan aac47c4a,
 * Q7.4). Never throws: the act stands either way, and the result says
 * whether the grade landed (`recorded` false: the criterion was removed in
 * between, or the write failed).
 */
export async function gradeCriterionAfterAct(params: {
  sessionId: string;
  userId: string;
  criterionKey: string;
  verdict: "pass" | "fail";
  rationale?: string | null;
}): Promise<{ verdict: "pass" | "fail"; recorded: boolean; resumed: boolean }> {
  try {
    const { out, resumed } = await gradeCriterionAsOwner(params);
    if (out.status !== "recorded") {
      logger.warn(
        { sessionId: params.sessionId, status: out.status },
        "criterion grade after the person's act did not land — the act stands"
      );
    }
    return {
      verdict: params.verdict,
      recorded: out.status === "recorded",
      resumed,
    };
  } catch (err) {
    logger.warn(
      { err, sessionId: params.sessionId },
      "criterion grade after the person's act threw — the act stands"
    );
    return { verdict: params.verdict, recorded: false, resumed: false };
  }
}

/**
 * The RESUME half of a `check` stage gate (services/playbooks/stage-gate.ts):
 * a session paused by a check gate goes back to `active` once every required
 * criterion of the stage it left passes. Called after every evaluation and every
 * human grade — re-running the check IS the resume, no proposal involved.
 * Guarded on `status = 'paused'` so a session a person paused for another reason
 * (no `checkGate` record) is never resumed by it. Resuming writes the gated
 * stage's `subjectStatus` (the pass the advance door was waiting for).
 */
export async function resumeCheckGateIfMet(params: {
  sessionId: string;
  userId: string;
  summary?: SessionEvaluationSummary;
}): Promise<boolean> {
  const session = await db.query.focusSessions.findFirst({
    where: and(
      eq(focusSessions.id, params.sessionId),
      eq(focusSessions.userId, params.userId)
    ),
  });
  const gate = (session?.metadata as Record<string, unknown> | null)?.[
    CHECK_GATE_METADATA_KEY
  ] as { fromStage?: unknown; stageKey?: unknown } | undefined;
  if (
    !session ||
    session.status !== "paused" ||
    typeof gate?.fromStage !== "string"
  ) {
    return false;
  }
  const summary =
    params.summary ??
    summarizeEvaluations(
      session.criteria,
      await listSessionEvaluations({
        sessionId: session.id,
        userId: params.userId,
      })
    );
  if (checkGateFailing(summary, gate.fromStage).length > 0) return false;
  // The check gate's own release: the system's move.
  const { rows: resumed } = await setSessionStatus(db, {
    sessionId: session.id,
    from: "paused",
    to: "active",
    actor: { kind: "system", userId: params.userId },
    reason: "Its check gate now passes.",
    set: {
      updatedAt: new Date(),
      metadata: drizzleSql`COALESCE(${focusSessions.metadata}, '{}'::jsonb) - ${CHECK_GATE_METADATA_KEY}`,
    },
  });
  if (resumed.length === 0) return false;
  // The gate PASSED: the gated stage's `subjectStatus` is written now — the
  // advance door held it while the check failed. Only while the run still
  // stands on that stage; a skip/failure never un-resumes.
  if (
    typeof gate.stageKey === "string" &&
    session.currentStage === gate.stageKey
  ) {
    const { writeStageSubjectStatus } =
      await import("../stage-subject-status.js");
    await writeStageSubjectStatus({
      session,
      toStage: gate.stageKey,
      userId: params.userId,
    });
  }
  return true;
}
