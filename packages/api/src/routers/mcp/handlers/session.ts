/**
 * MCP tool handlers — session domain.
 *
 * Split out of `adapter.ts`'s single switch (router-decomposition Wave 7).
 * Each export is a `Partial<Record<toolName, handler>>` merged into the
 * combined dispatch map in `adapter.ts`. Behavior is byte-identical to the
 * original `case` blocks — only the wrapping (switch case → object entry,
 * captured locals → `ctx` fields) changed.
 */

import { db, focusSessions, eq, and, desc, inArray } from "@synap/database";
import {
  ok,
  requireScope,
  listOpenFocusSessions,
  resolveAmbientSession,
  OPEN_SESSION_STATUSES,
  SESSION_STATUSES,
  McpToolContext,
  CallToolResult,
  McpHandlerMap,
} from "./shared.js";

export const sessionHandlers: McpHandlerMap = {
  synap_start_session: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, agentUserId } = ctx;
    requireScope(apiKeyScopes, "mcp.write", toolName);
    const { createFocusSession } =
      await import("../../../services/focus-sessions/create-session.js");
    const result = await createFocusSession({
      userId,
      workspaceId: args.workspaceId as string | undefined,
      projectId: args.projectId as string | undefined,
      subjectEntityId: args.subjectEntityId as string | undefined,
      goal: args.goal as string,
      agentUserId,
      correlationId: args.correlationId as string | undefined,
      channelId: args.channelId as string | undefined,
      agentIds: args.agentIds as string[] | undefined,
      templateId: args.templateId as string | undefined,
      expectedOutputs: args.expectedOutputs as
        | Array<{
            kind: string;
            label: string;
            icon?: string;
            status?: "pending" | "done";
          }>
        | undefined,
    });
    return ok(result);
  },
  synap_complete_session: async (
    ctx: McpToolContext
  ): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, agentUserId } = ctx;
    requireScope(apiKeyScopes, "mcp.write", toolName);
    const { completeFocusSession } =
      await import("../../../services/focus-sessions/complete-session.js");
    const result = await completeFocusSession({
      sessionId: args.sessionId as string,
      userId,
      agentUserId,
      summary: args.summary as string | undefined,
      verificationReport: args.verificationReport as
        Record<string, unknown> | undefined,
    });
    if (!result) {
      return ok({ error: `Focus session ${args.sessionId} not found` });
    }
    // Gate 2: proposal pack on complete — one review unit for the session.
    return ok({
      status: "closed",
      session: result.session,
      pendingProposals: result.pendingProposals,
      counts: result.counts,
      warnings: result.warnings,
      note:
        result.counts.pending > 0
          ? `Review pack: ${result.counts.pending} pending proposal(s) for this session — use synap_list_proposals with sessionId, or open the session room.`
          : "Session closed with no pending proposals in the pack.",
    });
  },
  synap_get_session: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes } = ctx;
    requireScope(apiKeyScopes, "mcp.read", toolName);
    const wantedId =
      typeof args.sessionId === "string" && args.sessionId.trim() !== ""
        ? args.sessionId
        : await resolveAmbientSession(userId);
    if (!wantedId) {
      const open = await listOpenFocusSessions(userId, 5);
      if (open.length > 1) {
        return ok({
          session: null,
          multiSession: true,
          openSessions: open.map((s) => ({
            id: s.id,
            goal: s.goal,
            startedAt: s.startedAt,
          })),
          message:
            "Multiple open focus sessions — pass sessionId explicitly (or set ?sessionId= on the MCP URL). Ambient attach is disabled to prevent mis-attribution.",
        });
      }
      return ok({
        session: null,
        message:
          "You have no open focus session. Start one with synap_start_session.",
      });
    }
    const [session] = await db
      .select()
      .from(focusSessions)
      .where(
        and(eq(focusSessions.id, wantedId), eq(focusSessions.userId, userId))
      )
      .limit(1);
    if (!session) {
      return ok({ error: `Focus session ${wantedId} not found` });
    }
    return ok({ session });
  },
  synap_list_sessions: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes } = ctx;
    requireScope(apiKeyScopes, "mcp.read", toolName);
    const statusArg = (args.status as string | undefined) ?? "open";
    const conditions = [eq(focusSessions.userId, userId)];
    if (statusArg === "open") {
      conditions.push(
        inArray(focusSessions.status, [...OPEN_SESSION_STATUSES])
      );
    } else if (statusArg !== "all") {
      // MCP schemas are ADVISORY — nothing validates `status` server-side, so
      // an off-enum value ("done", "completed") would silently match zero rows
      // instead of telling the agent what it may ask for.
      if (!(SESSION_STATUSES as readonly string[]).includes(statusArg)) {
        return ok({
          error: `Unknown session status '${statusArg}'. Valid values: ${SESSION_STATUSES.join(", ")}, plus 'open' (any non-terminal) and 'all'.`,
        });
      }
      conditions.push(
        eq(
          focusSessions.status,
          statusArg as (typeof focusSessions.$inferSelect)["status"]
        )
      );
    }
    // The URL lens auto-injects workspaceId/projectId — honoured as filters,
    // never as an authorization boundary (userId above is the floor).
    if (typeof args.workspaceId === "string" && args.workspaceId) {
      conditions.push(eq(focusSessions.workspaceId, args.workspaceId));
    }
    if (typeof args.projectId === "string" && args.projectId) {
      conditions.push(eq(focusSessions.projectId, args.projectId));
    }
    if (typeof args.subjectEntityId === "string" && args.subjectEntityId) {
      conditions.push(eq(focusSessions.subjectEntityId, args.subjectEntityId));
    }
    const rawLimit =
      typeof args.limit === "number" && Number.isFinite(args.limit)
        ? args.limit
        : 20;
    const sessions = await db
      .select()
      .from(focusSessions)
      .where(and(...conditions))
      .orderBy(desc(focusSessions.startedAt))
      .limit(Math.min(Math.max(Math.trunc(rawLimit), 1), 50));
    return ok({ sessions, count: sessions.length });
  },
  synap_update_session: async (
    ctx: McpToolContext
  ): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, agentUserId } = ctx;
    requireScope(apiKeyScopes, "mcp.write", toolName);
    const { updateFocusSession } =
      await import("../../../services/focus-sessions/update-session.js");
    const result = await updateFocusSession({
      sessionId: args.sessionId as string,
      userId,
      agentUserId,
      goal: args.goal as string | undefined,
      status: args.status as "active" | "paused" | undefined,
      progress: args.progress as number | undefined,
      currentStage: args.currentStage as string | undefined,
      addOutput: args.addOutput as
        { kind: string; label: string; icon?: string } | undefined,
      completeOutput: args.completeOutput as string | undefined,
      expectedOutputs: args.expectedOutputs as
        | Array<{
            kind: string;
            label: string;
            icon?: string;
            status?: "pending" | "done";
          }>
        | undefined,
    });
    switch (result.status) {
      case "not_found":
        return ok({
          error: `Focus session ${args.sessionId as string} not found`,
        });
      case "denied":
        return ok({ error: result.reason });
      case "proposed":
        return ok({
          status: "proposed",
          message: "Focus session update proposed for review",
          proposalId: result.proposalId,
          summary: result.summary,
          reviewPath: result.reviewPath,
          reviewUrl: result.reviewUrl,
          session: null,
        });
      case "updated":
        return ok({ status: "updated", session: result.session });
    }
    // Defensive: an unhandled decision must NOT fall through — every
    // FocusSessionUpdateResult status is handled above (exhaustive switch).
  },
};
