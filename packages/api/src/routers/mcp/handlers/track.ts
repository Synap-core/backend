/**
 * MCP tool handlers — TRACKS (a method running inside a project, 0272).
 *
 * ROUTING. Straight to `services/tracks` — the SAME service the tRPC `tracks`
 * router and Hub REST `/api/hub/tracks` call — so visibility, the scope
 * refusal, the write floor, governance and the stage gate have one authority.
 * The service (not the tRPC router) because the proposal's provenance must
 * say `mcp`, and a client-settable `source` on the tRPC input would let any
 * caller claim any door. Refusals come back as `{ error }` text an agent can
 * act on, never a throw.
 */

import { z } from "zod";
import {
  PROJECT_TRACK_STATUSES,
  PROJECT_TRACK_VERDICTS,
} from "@synap/database/schema";
import {
  advanceTrackStage,
  listTracks,
  loadTrackViews,
  loadWrittenTrackView,
  setTrackParams,
  setTrackStatus,
  reopenTrack,
  setTrackDirection,
  addTrackStage,
  startStageSession,
  startTrack,
  type TrackActor,
} from "../../../services/tracks/tracks-service.js";
import { pickTrackGoalInput } from "../../../services/tracks/goal-content.js";
import {
  missingStageDomainsNote,
  stageDomainFallbackNote,
} from "../../../services/tracks/stage-domain.js";
import {
  ok,
  requireScope,
  type McpToolContext,
  type CallToolResult,
  type McpHandlerMap,
} from "./shared.js";

const Uuid = z.string().uuid();

function actorOf(ctx: McpToolContext): TrackActor {
  return {
    userId: ctx.userId,
    agentUserId: ctx.agentUserId ?? null,
    isHubProtocol: true,
    sessionId: ctx.sessionId ?? null,
    source: "mcp",
    reasoning: str(ctx.args.reasoning),
  };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/** A uuid arg, or `undefined` — a malformed id is refused, never sent to SQL. */
function uuid(v: unknown): string | undefined {
  const s = str(v);
  return s && Uuid.safeParse(s).success ? s : undefined;
}

function isParams(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    return ok({ error: err instanceof Error ? err.message : String(err) });
  }
}

export const trackHandlers: McpHandlerMap = {
  synap_list_tracks: async (ctx) => {
    requireScope(ctx.apiKeyScopes, "mcp.read", ctx.toolName);
    const projectId = uuid(ctx.args.projectId);
    if (!projectId) {
      return ok({
        error:
          "projectId (uuid) is required — find it with synap_list_projects.",
      });
    }
    return run(async () => {
      const rows = await listTracks({
        projectId,
        actor: actorOf(ctx),
        includeArchived: ctx.args.includeArchived === true,
      });
      if (!rows) return { error: "Project not found" };
      return { items: await loadTrackViews(rows, ctx) };
    });
  },

  synap_start_track: async (ctx) => {
    requireScope(ctx.apiKeyScopes, "mcp.write", ctx.toolName);
    const projectId = uuid(ctx.args.projectId);
    if (!projectId) {
      return ok({
        error:
          "projectId (uuid) is required — find it with synap_list_projects.",
      });
    }
    // OPTIONAL (W1): a track needs no method. A playbookId given but malformed
    // is refused, never silently dropped into a method-less start.
    const playbookId = uuid(ctx.args.playbookId);
    if (ctx.args.playbookId != null && !playbookId) {
      return ok({
        error:
          "playbookId must be a uuid (a project-scoped playbook) — or omit it to start a track with no method.",
      });
    }
    return run(async () => {
      const result = await startTrack({
        projectId,
        ...(playbookId ? { playbookId } : {}),
        ...(str(ctx.args.name) ? { name: str(ctx.args.name) } : {}),
        ...(isParams(ctx.args.params) ? { params: ctx.args.params } : {}),
        ...(str(ctx.args.direction)
          ? { direction: str(ctx.args.direction) }
          : {}),
        ...(ctx.args.kpi != null ? { kpi: ctx.args.kpi } : {}),
        // What the goal holds (0345) — parsed (2–5 criteria, meanings) by
        // the service; a malformed one comes back as `{ error }` words.
        ...pickTrackGoalInput(ctx.args),
        actor: actorOf(ctx),
      });
      const domainsNote = missingStageDomainsNote(result.missingDomains);
      if (result.status === "proposed") {
        return { ...result, ...(domainsNote ? { domainsNote } : {}) };
      }
      return {
        status: result.status,
        track: await loadWrittenTrackView(result.track, ctx),
        missingDomains: result.missingDomains,
        ...(domainsNote ? { domainsNote } : {}),
      };
    });
  },

  synap_advance_track: async (ctx) => {
    requireScope(ctx.apiKeyScopes, "mcp.write", ctx.toolName);
    const trackId = uuid(ctx.args.trackId);
    const toStage = str(ctx.args.toStage);
    if (!trackId || !toStage) {
      return ok({
        error:
          "trackId (uuid) and toStage are required — synap_list_tracks lists each track's stage keys.",
      });
    }
    return run(async () => {
      const result = await advanceTrackStage({
        trackId,
        toStage,
        actor: actorOf(ctx),
      });
      if (result.status === "proposed") return result;
      return {
        ...result,
        track: await loadWrittenTrackView(result.track, ctx),
      };
    });
  },

  synap_set_track_status: async (ctx) => {
    requireScope(ctx.apiKeyScopes, "mcp.write", ctx.toolName);
    const trackId = uuid(ctx.args.trackId);
    const status = PROJECT_TRACK_STATUSES.find((s) => s === ctx.args.status);
    if (!trackId || !status) {
      return ok({
        error: `trackId (uuid) and status (${PROJECT_TRACK_STATUSES.join(" | ")}) are required — synap_list_tracks lists the project's tracks.`,
      });
    }
    const verdictArg = str(ctx.args.verdict);
    const verdict = PROJECT_TRACK_VERDICTS.find((v) => v === verdictArg);
    if (verdictArg && !verdict) {
      return ok({
        error: `verdict must be one of ${PROJECT_TRACK_VERDICTS.join(" | ")}.`,
      });
    }
    return run(async () => {
      // The verdict rule (closing needs one, impossible/replaced a reason)
      // is the service's, refused with words before anything is filed.
      const result = await setTrackStatus({
        trackId,
        status,
        verdict,
        verdictReason: str(ctx.args.verdictReason),
        actor: actorOf(ctx),
      });
      if (result.status === "proposed") return result;
      return {
        status: result.status,
        track: await loadWrittenTrackView(result.track, ctx),
      };
    });
  },

  // R8 — the agent's door to "open a new version" of a closed goal: the SAME
  // service the Hub REST reopen route calls (`reopenTrack` → `startTrack`),
  // so an agent's reopen is governed exactly like an agent's start.
  synap_reopen_track: async (ctx) => {
    requireScope(ctx.apiKeyScopes, "mcp.write", ctx.toolName);
    const trackId = uuid(ctx.args.trackId);
    if (!trackId) {
      return ok({
        error:
          "trackId (uuid) is required — synap_list_tracks (includeArchived) lists the project's closed and dropped tracks.",
      });
    }
    return run(async () => {
      const result = await reopenTrack({
        trackId,
        ...(str(ctx.args.name) ? { name: str(ctx.args.name) } : {}),
        actor: actorOf(ctx),
      });
      const domainsNote = missingStageDomainsNote(result.missingDomains);
      if (result.status === "proposed") {
        return { ...result, ...(domainsNote ? { domainsNote } : {}) };
      }
      return {
        status: result.status,
        track: await loadWrittenTrackView(result.track, ctx),
        missingDomains: result.missingDomains,
        ...(domainsNote ? { domainsNote } : {}),
      };
    });
  },

  synap_set_track_params: async (ctx) => {
    requireScope(ctx.apiKeyScopes, "mcp.write", ctx.toolName);
    const trackId = uuid(ctx.args.trackId);
    if (!trackId || !isParams(ctx.args.params)) {
      return ok({
        error:
          "trackId (uuid) and params (an object keyed by the declared param names) are required — synap_list_tracks returns each track's declaredParams.",
      });
    }
    const params = ctx.args.params;
    return run(async () => {
      const result = await setTrackParams({
        trackId,
        params,
        actor: actorOf(ctx),
      });
      if (result.status === "proposed") return result;
      return {
        status: result.status,
        track: await loadWrittenTrackView(result.track, ctx),
      };
    });
  },

  synap_update_track: async (ctx) => {
    requireScope(ctx.apiKeyScopes, "mcp.write", ctx.toolName);
    const trackId = uuid(ctx.args.trackId);
    const hasDirection = "direction" in ctx.args;
    const hasKpi = "kpi" in ctx.args;
    const goal = pickTrackGoalInput(ctx.args);
    if (
      !trackId ||
      (!hasDirection && !hasKpi && Object.keys(goal).length === 0)
    ) {
      return ok({
        error:
          "trackId (uuid) and something to change are required — direction, kpi, endState, criteria, dropConditions, workKind, uncertainty or loop. synap_list_tracks lists the project's tracks.",
      });
    }
    const direction = ctx.args.direction;
    if (hasDirection && direction !== null && typeof direction !== "string") {
      return ok({ error: "direction is one line of text, or null to clear." });
    }
    return run(async () => {
      const result = await setTrackDirection({
        trackId,
        ...(hasDirection ? { direction: direction as string | null } : {}),
        ...(hasKpi ? { kpi: ctx.args.kpi } : {}),
        ...goal,
        actor: actorOf(ctx),
      });
      if (result.status === "proposed") return result;
      return {
        status: result.status,
        track: await loadWrittenTrackView(result.track, ctx),
      };
    });
  },

  synap_add_track_stage: async (ctx) => {
    requireScope(ctx.apiKeyScopes, "mcp.write", ctx.toolName);
    const trackId = uuid(ctx.args.trackId);
    const name = str(ctx.args.name);
    if (!trackId || !name) {
      return ok({
        error:
          "trackId (uuid) and name are required — synap_list_tracks lists each track and its stages.",
      });
    }
    return run(async () => {
      const result = await addTrackStage({
        trackId,
        stage: {
          name,
          ...(str(ctx.args.goal) ? { goal: str(ctx.args.goal) } : {}),
          ...(str(ctx.args.key) ? { key: str(ctx.args.key) } : {}),
        },
        actor: actorOf(ctx),
      });
      if (result.status === "proposed") return result;
      return {
        status: result.status,
        stageKey: result.stageKey,
        track: await loadWrittenTrackView(result.track, ctx),
      };
    });
  },

  synap_start_stage_session: async (ctx) => {
    requireScope(ctx.apiKeyScopes, "mcp.write", ctx.toolName);
    const trackId = uuid(ctx.args.trackId);
    if (!trackId) {
      return ok({
        error:
          "trackId (uuid) is required — synap_list_tracks lists each track and its stages.",
      });
    }
    return run(async () => {
      const result = await startStageSession({
        trackId,
        stageKey: str(ctx.args.stageKey) ?? null,
        title: str(ctx.args.title) ?? null,
        goal: str(ctx.args.goal) ?? null,
        actor: actorOf(ctx),
      });
      const domainNote = stageDomainFallbackNote(result.domainFallback);
      return domainNote ? { ...result, domainNote } : result;
    });
  },
};
