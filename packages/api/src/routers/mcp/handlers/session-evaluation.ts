/**
 * MCP tool handlers — session EVALUATION (criteria graded against their work).
 *
 * `synap_evaluate_session { sessionId, evidence? }` runs the session's pending
 * criteria through `evaluateSession` (evidence → capability → judge; human
 * criteria wait for the owner) and returns the verdict. Reading the grade needs
 * no tool of its own: `synap_get_session` carries it on the continuation
 * packet's `evaluation` section.
 *
 * Kept in its own file so the session-domain handler (`session.ts`) and the
 * tool list stay single-owner; its tool definition is declared in
 * `tools/index.ts` `list()` like every other tool.
 */

import { z } from "zod";
import { sessionEvidenceSchema } from "../../../schemas/session-criteria.js";
import {
  ok,
  requireScope,
  type McpToolContext,
  type CallToolResult,
  type McpHandlerMap,
} from "./shared.js";

export const EvaluateSessionArgsSchema = z.object({
  sessionId: z.string().uuid(),
  evidence: sessionEvidenceSchema.optional(),
});

export const sessionEvaluationHandlers: McpHandlerMap = {
  synap_evaluate_session: async (
    ctx: McpToolContext
  ): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, agentUserId } = ctx;
    requireScope(apiKeyScopes, "mcp.write", toolName);
    const parsed = EvaluateSessionArgsSchema.safeParse(args);
    if (!parsed.success) {
      return ok({
        error: parsed.error.issues
          .map((i) => `${i.path.join(".") || "args"}: ${i.message}`)
          .join("; "),
      });
    }
    const { evaluateSession } =
      await import("../../../services/focus-sessions/evaluations/evaluate.js");
    const result = await evaluateSession({
      sessionId: parsed.data.sessionId,
      userId,
      agentUserId: agentUserId ?? null,
      evidence: parsed.data.evidence,
      // `evaluate_session` is where a criterion the agent could not pass
      // becomes the person's ask (E3) — never a mid-session grade.
      escalate: true,
    });
    if (result.status === "not_found") {
      return ok({ error: `Focus session ${parsed.data.sessionId} not found` });
    }
    // REPLY SHAPING (2026-11-05): the agent declared the criteria and sent the
    // evidence, so neither is echoed back (`criteria` ~112 tokens, the full
    // evaluation rows ~515, measured over 24 days). Each current evaluation
    // keeps what the agent acts on: which criterion, its verdict, who graded
    // it, on which attempt, and why. The Hub REST and tRPC doors keep the
    // whole read shape.
    const { criteria: _criteria, evaluations, ...rest } = result;
    return ok({
      ...rest,
      evaluations: evaluations.map((e) => ({
        criterionKey: e.criterionKey,
        verdict: e.verdict,
        evaluatorKind: e.evaluatorKind,
        attempt: e.attempt,
        ...(e.rationale ? { rationale: e.rationale } : {}),
      })),
    });
  },
};
