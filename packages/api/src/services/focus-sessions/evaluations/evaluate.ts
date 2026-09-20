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
 *                A judge that could not run records nothing and says why.
 *   human      — left unmeasured until the owner grades it.
 *
 * "Pending" = not already passing, not human-graded, attempts remaining. Every
 * row goes through `recordSessionEvaluation`, which owns the retry bound and the
 * escalation — this function only decides WHAT to record.
 */

import { db, focusSessions, and, eq, drizzleSql } from "@synap/database";
import { readCriteria, type SessionCriterion } from "@synap/playbooks";
import {
  judgeSessionCriteria,
  resolveIntelligenceService,
} from "@synap/intelligence-client";
import type { EvaluationVerdict } from "@synap-core/types/focus-sessions";
import { executeCapability } from "../../capabilities/execute-capability.js";
import {
  CHECK_GATE_METADATA_KEY,
  checkGateFailing,
} from "../../playbooks/stage-gate.js";
import {
  MAX_NON_HUMAN_ATTEMPTS,
  listSessionEvaluations,
  recordSessionEvaluation,
  summarizeEvaluations,
  type SessionEvaluationRow,
  type SessionEvaluationSummary,
} from "./record.js";

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

const MATERIAL_MAX = 8000;

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

function buildJudgeMaterial(
  session: typeof focusSessions.$inferSelect,
  rows: readonly SessionEvaluationRow[],
  evidence?: PostedEvidence
): string {
  const outputs = Array.isArray(session.expectedOutputs)
    ? (session.expectedOutputs as Array<{ label?: string; status?: string }>)
    : [];
  const parts = [
    `GOAL: ${session.goal}`,
    outputs.length
      ? `OUTPUTS:\n${outputs.map((o) => `- ${o.label ?? "?"} [${o.status ?? "pending"}]`).join("\n")}`
      : "",
    session.verificationReport
      ? `REPORT: ${JSON.stringify(session.verificationReport)}`
      : "",
    evidence && Object.keys(evidence).length
      ? `POSTED EVIDENCE: ${JSON.stringify(evidence)}`
      : "",
    rows.length
      ? `EARLIER CHECKS:\n${rows
          .map(
            (r) =>
              `- ${r.criterionKey}: ${r.verdict}${r.rationale ? ` — ${r.rationale}` : ""}`
          )
          .join("\n")}`
      : "",
  ].filter(Boolean);
  return parts.join("\n\n").slice(0, MATERIAL_MAX);
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
      (params.kinds === undefined || params.kinds.includes(c.check.kind))
  );

  const results: CriterionRunOutcome[] = [];
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
    results.push(
      out.status === "recorded"
        ? { key: c.key, status: "recorded", verdict, escalated: out.escalated }
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
        parameters: { sessionId, criterionKey: c.key },
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
      const judgement = await judgeSessionCriteria(
        svc.endpoint,
        svc.serviceApiKey,
        {
          criteria: judged.map((c) => ({
            key: c.key,
            statement: c.statement,
            ...(c.check.hint ? { hint: c.check.hint } : {}),
          })),
          material: buildJudgeMaterial(session, rows, params.evidence),
          ...(typeof modelId === "string" && modelId
            ? { excludeModel: modelId }
            : {}),
        }
      );
      const byKey = new Map(judgement.verdicts.map((v) => [v.key, v]));
      for (const c of judged) {
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
      for (const c of judged)
        results.push({ key: c.key, status: "skipped", reason });
    }
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
 * The RESUME half of a `check` stage gate (services/playbooks/stage-gate.ts):
 * a session paused by a check gate goes back to `active` once every required
 * criterion of the stage it left passes. Called after every evaluation and every
 * human grade — re-running the check IS the resume, no proposal involved.
 * Guarded on `status = 'paused'` so a session a person paused for another reason
 * (no `checkGate` record) is never resumed by it.
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
  ] as { fromStage?: unknown } | undefined;
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
  const resumed = await db
    .update(focusSessions)
    .set({
      status: "active",
      updatedAt: new Date(),
      metadata: drizzleSql`COALESCE(${focusSessions.metadata}, '{}'::jsonb) - ${CHECK_GATE_METADATA_KEY}`,
    })
    .where(
      and(eq(focusSessions.id, session.id), eq(focusSessions.status, "paused"))
    )
    .returning({ id: focusSessions.id });
  return resumed.length > 0;
}
