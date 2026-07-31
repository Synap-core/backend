/**
 * executeSkillViaIS — the ONE wire contract for running a sandboxed skill.
 *
 * Skill code (`kind:"code"`) runs in the Intelligence Hub's isolated-vm executor
 * (it owns the sandbox + the Hub Protocol bridge), so the backend delegates over
 * HTTP. This helper is the single source of truth for that contract, imported by
 * BOTH the `/capabilities/execute` hub door AND the `capability.run` approve-
 * executor — so the path + body keys live in exactly one place.
 *
 * Contract (verified against intelligence-hub `routes/skills-route.ts`):
 *   POST {IS}/api/skills/execute
 *     body: { skillId, userId, parameters, workspaceId? }
 *     → SkillExecutionResult { success, result?, error?, executionTimeMs }
 *
 * NOTE: the IS execute route reads `parameters` (mapped to the skill's `args`),
 * NOT `context`, and takes the skill id in the BODY, not the path. The automation
 * worker's two skill calls were fixed to match this same contract.
 */

import { getDefaultActiveService } from "../../utils/intelligence-routing.js";
import { isCallBudgetMs } from "@synap/intelligence-client";

/** Mirrors the Intelligence Hub `SkillExecutionResult`. */
export interface SkillExecutionResult {
  success: boolean;
  result?: unknown;
  error?: string;
  executionTimeMs?: number;
}

export async function executeSkillViaIS(args: {
  skillId: string;
  userId: string;
  parameters?: Record<string, unknown>;
  /** The workspace this run is scoped to — threaded into the skill's `context`
   *  so code skills (e.g. propose.entity) default into the right workspace
   *  instead of landing pod-personal when the skill author doesn't pass one. */
  workspaceId?: string | null;
  timeoutMs?: number;
}): Promise<SkillExecutionResult> {
  // Resolve the IS endpoint + key the CANONICAL way: from the registered
  // `intelligence_services` row (credential decrypted via resolveServiceKey),
  // exactly like every other IS-outbound path (channels, capture, agents).
  // The raw env vars are a STALE fallback — re-provisioning (CP → pod) rotates
  // the key into the DB but never rewrites the container env, so reading
  // process.env.INTELLIGENCE_HUB_API_KEY here was sending a dead key and the IS
  // gateway rejected it with 401. getDefaultActiveService() returns the live DB
  // credential and only falls back to env when no service row exists.
  const { endpoint: isUrl, apiKey: isApiKey } = await getDefaultActiveService();

  const controller = new AbortController();
  // An explicit caller-supplied timeoutMs still wins; only the FALLBACK moves
  // off the 60s literal. `command` (a bounded IS action that may invoke a model)
  // rather than `generation` — /api/skills/execute runs one skill, it does not
  // loop like an agent turn. See is-call-budget.ts.
  const timer = setTimeout(
    () => controller.abort(),
    args.timeoutMs ?? isCallBudgetMs("command")
  );
  try {
    const res = await fetch(`${isUrl}/api/skills/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": isApiKey,
      },
      body: JSON.stringify({
        skillId: args.skillId,
        userId: args.userId,
        parameters: args.parameters ?? {},
        workspaceId: args.workspaceId ?? undefined,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Skill execution failed: ${res.status} ${body}`);
    }
    return (await res.json()) as SkillExecutionResult;
  } finally {
    clearTimeout(timer);
  }
}
