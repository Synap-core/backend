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
import { proposedMessageFor } from "../../../utils/permission-check.js";
import {
  withParentSessionId,
  attachParentSessionIds,
} from "../../../services/focus-sessions/parent-lineage.js";
import { attachTriage } from "../../../services/focus-sessions/triage.js";
import {
  SESSION_KINDS,
  attachSessionKind,
  sessionKindWhere,
  sessionAutomationWhere,
} from "../../../services/focus-sessions/session-kind.js";
import {
  ok,
  requireScope,
  resolveAmbientSession,
  OPEN_SESSION_STATUSES,
  SESSION_STATUSES,
  McpToolContext,
  CallToolResult,
  McpHandlerMap,
} from "./shared.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** One line, not a transcript — mirrors the tool schema's `maxLength`. */
const SUSPENDED_INTENT_MAX = 400;

export const sessionHandlers: McpHandlerMap = {
  synap_start_session: async (ctx: McpToolContext): Promise<CallToolResult> => {
    const { toolName, args, userId, apiKeyScopes, agentUserId } = ctx;
    requireScope(apiKeyScopes, "mcp.write", toolName);
    // MCP tool schemas are ADVISORY — nothing validates the args server-side,
    // so a non-uuid handle would reach `eq(focusSessions.id, …)` against a
    // `uuid` column. Tell the agent what it may pass instead of letting the
    // shape become a database error. (Hub REST validates the same field with
    // `z.string().uuid()` — this is the MCP door catching up.)
    const parentSessionIdArg = args.parentSessionId;
    if (
      parentSessionIdArg !== undefined &&
      parentSessionIdArg !== null &&
      (typeof parentSessionIdArg !== "string" ||
        !UUID_RE.test(parentSessionIdArg))
    ) {
      return ok({
        error:
          "parentSessionId must be a session UUID (the id of a session you own that you are pushing FROM).",
      });
    }
    const suspendedIntentArg = args.suspendedIntent;
    if (
      suspendedIntentArg !== undefined &&
      suspendedIntentArg !== null &&
      (typeof suspendedIntentArg !== "string" ||
        suspendedIntentArg.length > SUSPENDED_INTENT_MAX)
    ) {
      return ok({
        error: `suspendedIntent must be a string of at most ${SUSPENDED_INTENT_MAX} characters — ONE line naming what you were about to do.`,
      });
    }
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
      parentSessionId: args.parentSessionId as string | undefined,
      suspendedIntent: args.suspendedIntent as string | undefined,
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
    // `resolveAmbientSession` now always answers when ANY session is open (it
    // picks the newest and reports `ambiguous`), so the old "multiple open →
    // refuse and list them" branch here is unreachable: it could only fire when
    // the resolver returned undefined, which now means zero open sessions.
    // Deleted rather than left behind a flag — two live definitions of what
    // ambiguity means is exactly the two-store divergence this codebase keeps
    // getting bitten by. The disclosure lives on the answer instead.
    const explicitId =
      typeof args.sessionId === "string" && args.sessionId.trim() !== ""
        ? args.sessionId
        : undefined;
    const ambient = explicitId
      ? undefined
      : await resolveAmbientSession(userId);
    const wantedId = explicitId ?? ambient?.sessionId;
    if (!wantedId) {
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
    // Disclose an inferred answer. Asking "which session am I in?" and getting a
    // confident one back while three are open is precisely the mis-attribution
    // the old refusal guarded against — the fix is to answer AND say it was
    // inferred, not to withhold the answer.
    // Detour lineage, DERIVED from the `spawned_from` edge — never a column, so
    // there is exactly one store for "what was this forked from". ONE
    // projection, shared with the tRPC `focusSessions.get`.
    return ok({
      session: await withParentSessionId(session),
      ...(ambient?.ambiguous
        ? {
            inferred: true,
            openCount: ambient.openCount,
            message: `${ambient.openCount} sessions are open — this is the most recently started. Pass sessionId to ask about another.`,
          }
        : {}),
    });
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
    // Flow DEFINITION filters — the same two the tRPC and Hub REST doors take.
    // Each names a definition, never one execution. Pair with kind 'run' or
    // 'all': every flow-linked row classifies as a run, so under 'work' either
    // filter alone returns nothing.
    if (typeof args.playbookId === "string" && args.playbookId) {
      conditions.push(eq(focusSessions.playbookId, args.playbookId));
    }
    if (typeof args.automationId === "string" && args.automationId) {
      conditions.push(sessionAutomationWhere(args.automationId));
    }
    // Population lens (`services/focus-sessions/session-kind.ts`). MCP schemas
    // are ADVISORY — nothing validates args server-side — so an off-enum value
    // is answered with the vocabulary rather than silently matching zero rows.
    // Default `all`, like the Hub REST door and unlike tRPC's `work`: an agent
    // listing sessions wants the runs and write receipts it just opened.
    const kindArg = (args.kind as string | undefined) ?? "all";
    if (kindArg !== "all") {
      if (!(SESSION_KINDS as readonly string[]).includes(kindArg)) {
        return ok({
          error: `Unknown session kind '${kindArg}'. Valid values: ${SESSION_KINDS.join(", ")}, plus 'all'.`,
        });
      }
      conditions.push(
        sessionKindWhere(kindArg as (typeof SESSION_KINDS)[number])
      );
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
    // Derived lineage for the whole page in ONE query (never N+1, never a
    // column) — the same projection the tRPC `focusSessions.list` uses.
    //
    // `triage` rides along for the SAME reason it does there: it is pure (no
    // query), and an agent that had to re-derive "is this waiting on a human?"
    // from origin + status + metadata would be writing the second, drifting
    // copy of a predicate that `services/focus-sessions/triage.ts` owns.
    //
    // No `lens` here on purpose. The tRPC door's default EXCLUDES triage rows
    // because a person's working list must not fill with drafts they never
    // asked for; an agent listing sessions is usually looking for the ones it
    // just opened, so hiding them would be the wrong default at this door.
    // The flag makes the distinction visible either way.
    // `kind` rides along on every row for the same reason `triage` does: pure,
    // no query, and the ONE place the predicate is decided.
    return ok({
      sessions: attachSessionKind(
        attachTriage(await attachParentSessionIds(sessions))
      ),
      count: sessions.length,
    });
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
      addAgentId: args.addAgentId as string | undefined,
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
          message: proposedMessageFor(
            (result as { proposalType?: string }).proposalType,
            "Focus session update proposed for review"
          ),
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
