/**
 * MCP tool handlers — a GOAL's WORKERS (goals that run, R2): list, enable,
 * pause / resume, run now. Each calls the shared door
 * (`hub-protocol/worker-doors.ts`) Hub REST `/api/hub/workers*` calls too, so
 * governance (the one rule door, the playbook run door) has one authority. An
 * agent's enable, pause and run come back `status: 'proposed'` when a rule
 * says to ask: that is success. Refusals are `{ error }` words, never a throw.
 */
import { z } from "zod";
import {
  enableWorkerDoor,
  listWorkersDoor,
  runWorkerDoor,
  setWorkerPausedDoor,
  type WorkerDoorOutcome,
} from "../../hub-protocol/worker-doors.js";
import type { PlaybookDoorIdentity } from "../../hub-protocol/playbook-doors.js";
import {
  ok,
  readReasoning,
  rejectMissingWriteWorkspace,
  requireScope,
  type CallToolResult,
  type McpHandlerMap,
  type McpToolContext,
} from "./shared.js";

const Uuid = z.string().uuid();

function identity(ctx: McpToolContext): PlaybookDoorIdentity {
  return {
    userId: ctx.userId,
    scopes: ctx.apiKeyScopes,
    agentUserId: ctx.agentUserId,
    sessionId: ctx.sessionId,
    keyType: ctx.keyType,
    keyWorkspaceId: ctx.keyWorkspaceId,
  };
}

function uuidArg(v: unknown): string | undefined {
  return typeof v === "string" && Uuid.safeParse(v.trim()).success
    ? v.trim()
    : undefined;
}

function render<T>(
  outcome: WorkerDoorOutcome<T>,
  userId: string
): Promise<CallToolResult> | CallToolResult {
  switch (outcome.kind) {
    case "result":
      return ok(outcome.result);
    case "missing_workspace":
      return rejectMissingWriteWorkspace(userId);
    case "invalid":
    case "not_found":
      return ok({ error: outcome.error });
    case "conflict":
      return ok({
        error: outcome.error,
        reasonCode: outcome.reasonCode,
        holder: outcome.holder,
      });
  }
}

export const workerHandlers: McpHandlerMap = {
  synap_list_workers: async (ctx) => {
    requireScope(ctx.apiKeyScopes, "mcp.read", ctx.toolName);
    const trackId = uuidArg(ctx.args.trackId);
    const projectId = uuidArg(ctx.args.projectId);
    if (!trackId && !projectId) {
      return ok({
        error:
          "trackId (the goal's uuid) is required — find it with synap_list_tracks.",
      });
    }
    return render(
      await listWorkersDoor(identity(ctx), { trackId, projectId }),
      ctx.userId
    );
  },

  synap_enable_worker: async (ctx) => {
    requireScope(ctx.apiKeyScopes, "mcp.write", ctx.toolName);
    const playbookId = uuidArg(ctx.args.playbookId);
    const trackId = uuidArg(ctx.args.trackId);
    const activatorKey =
      typeof ctx.args.activatorKey === "string"
        ? ctx.args.activatorKey.trim()
        : "";
    if (!playbookId || !activatorKey || !trackId) {
      return ok({
        error:
          "playbookId (uuid), activatorKey (one the playbook declares: synap_list_playbooks shows its activators) and trackId (the goal) are required.",
      });
    }
    const mode = ctx.args.mode;
    if (mode !== undefined && mode !== "run" && mode !== "propose") {
      return ok({ error: "mode is 'propose' (the default) or 'run'." });
    }
    return render(
      await enableWorkerDoor(identity(ctx), {
        playbookId,
        activatorKey,
        trackId,
        ...(mode ? { mode } : {}),
      }),
      ctx.userId
    );
  },

  synap_pause_worker: async (ctx) => {
    requireScope(ctx.apiKeyScopes, "mcp.write", ctx.toolName);
    const ruleId = uuidArg(ctx.args.ruleId);
    if (!ruleId || typeof ctx.args.paused !== "boolean") {
      return ok({
        error:
          "ruleId (the worker's, from synap_list_workers) and paused (true to pause, false to resume) are required.",
      });
    }
    return render(
      await setWorkerPausedDoor(identity(ctx), {
        ruleId,
        paused: ctx.args.paused,
      }),
      ctx.userId
    );
  },

  synap_run_worker: async (ctx) => {
    requireScope(ctx.apiKeyScopes, "mcp.write", ctx.toolName);
    const ruleId = uuidArg(ctx.args.ruleId);
    if (!ruleId) {
      return ok({
        error: "ruleId (the worker's, from synap_list_workers) is required.",
      });
    }
    const reasoning = readReasoning(ctx.args);
    return render(
      await runWorkerDoor(identity(ctx), {
        ruleId,
        ...(reasoning ? { reasoning } : {}),
        source: "mcp",
      }),
      ctx.userId
    );
  },
};
