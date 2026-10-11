/**
 * Backend → IS criteria judge (`POST /api/judge-criteria`,
 * synap-intelligence-service routes/session-intelligence/judge.ts).
 *
 * Rides the shared session-intelligence transport (`postSessionIntelligence`:
 * per-call `{ serviceUrl, apiKey }`, a `generation` budget, ATTRIBUTED
 * failures). It THROWS on failure rather than
 * returning null: a judge that could not run and a judge that found nothing are
 * different facts, and the caller must keep the criterion unmeasured with the
 * reason rather than read silence as a verdict.
 */

import { postSessionIntelligence } from "./session-intelligence-client.js";

export interface JudgeCriteriaRequest {
  criteria: Array<{ key: string; statement: string; hint?: string }>;
  /** ≤ 16000 chars (`MATERIAL_MAX`, judge-material.ts): the produced work, the room. */
  material: string;
  /** The model that did the work — never allowed to grade it. */
  excludeModel?: string;
  /** Only true when the pod consented to the third-party decision model. */
  allowDecisionModel?: boolean;
}

/** Mirror of the IS `JudgeCriteriaResult`. */
export interface JudgeCriteriaResult {
  verdicts: Array<{
    key: string;
    verdict: "pass" | "fail" | "unmeasured";
    rationale: string;
  }>;
  decider: "jev" | "llm" | "none";
  model?: string;
}

/**
 * Did the IS refuse the judge REQUEST itself (HTTP 400 — its zod validation)?
 * The one refusal a caller can fix by sending less: an IS deployed before the
 * material cap was raised refuses a larger `material` this way.
 */
export function isJudgeRequestRefused(err: unknown): boolean {
  return (err as { status?: unknown } | null)?.status === 400;
}

export async function judgeSessionCriteria(
  serviceUrl: string,
  serviceApiKey: string,
  payload: JudgeCriteriaRequest
): Promise<JudgeCriteriaResult> {
  return postSessionIntelligence<JudgeCriteriaResult>(
    serviceUrl,
    serviceApiKey,
    "/api/judge-criteria",
    payload
  );
}
