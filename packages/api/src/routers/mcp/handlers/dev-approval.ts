/**
 * MCP door for the dev loop's DEPLOY gate — `synap_request_deploy_approval`.
 *
 * The same service as Hub `POST /proposals/dev-approval`
 * (`createDevApprovalProposal`): the payload is parsed against
 * `DevDeployApprovalPayloadSchema` there, and the proposal goes through the
 * one event-backed door, so the push, the session lens and the
 * `focus_session/dev.deploy_approval` executor all apply unchanged. This door
 * only FILES — approval stays the person's (there is no approve tool).
 *
 * Owner floor first: the session must be the key's person's (the same floor as
 * `updateFocusSession`), so an agent cannot hang a deploy ask on someone else's
 * session. The proposal is filed under the session's own space, project and
 * room — the session decides where the ask lives, not the call's lens.
 */

import { db, focusSessions, eq, and } from "@synap/database";
import {
  createDevApprovalProposal,
  DEV_DEPLOY_APPROVAL_TYPE,
} from "../../../services/proposals/dev-approval.js";
import { UUID_RE } from "../../../services/focus-sessions/session-metadata.js";
import {
  ok,
  requireScope,
  type McpToolContext,
  type CallToolResult,
  type McpHandlerMap,
} from "./shared.js";

export const devApprovalHandlers: McpHandlerMap = {
  synap_request_deploy_approval: async (
    ctx: McpToolContext
  ): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, agentUserId } = ctx;
    requireScope(apiKeyScopes, "mcp.write", toolName);

    const sessionId = args.sessionId;
    const session =
      typeof sessionId === "string" && UUID_RE.test(sessionId)
        ? await db.query.focusSessions.findFirst({
            where: and(
              eq(focusSessions.id, sessionId),
              eq(focusSessions.userId, userId)
            ),
            columns: {
              id: true,
              workspaceId: true,
              projectId: true,
              channelId: true,
            },
          })
        : undefined;
    if (!session) {
      return ok({ error: `Focus session ${String(sessionId)} not found` });
    }

    try {
      const filed = await createDevApprovalProposal({
        type: DEV_DEPLOY_APPROVAL_TYPE,
        payload: {
          sessionId: session.id,
          repo: args.repo,
          branch: args.branch,
          commitSha: args.commitSha,
          gateReport: args.gateReport,
          targetHost: args.targetHost,
          deployCommand: args.deployCommand,
        },
        // The HUMAN reviews; the agent is attribution (see the Hub route).
        userId,
        workspaceId: session.workspaceId,
        projectId: session.projectId,
        agentUserId: agentUserId ?? null,
        channelId: session.channelId,
      });
      return ok({
        status: "proposed",
        proposalId: filed.id,
        sessionId: filed.sessionId,
        message:
          "Deploy approval requested — the person approves or rejects it. Ship only after it is approved, and only this commit.",
      });
    } catch (err) {
      // A zod parse failure is the caller's to fix — name the fields.
      if (err && typeof err === "object" && "issues" in err) {
        return ok({
          error: `Invalid ${DEV_DEPLOY_APPROVAL_TYPE} payload: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
      throw err;
    }
  },
};
