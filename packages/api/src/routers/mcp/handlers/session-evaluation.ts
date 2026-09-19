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
    });
    if (result.status === "not_found") {
      return ok({ error: `Focus session ${parsed.data.sessionId} not found` });
    }
    return ok(result);
  },
};
