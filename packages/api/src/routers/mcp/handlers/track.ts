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
import { PROJECT_TRACK_STATUSES } from "@synap/database/schema";
import {
  advanceTrackStage,
  listTracks,
  loadTrackViews,
  loadWrittenTrackView,
  setTrackParams,
  setTrackStatus,
  startStageSession,
  startTrack,
  type TrackActor,
} from "../../../services/tracks/tracks-service.js";
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
    const playbookId = uuid(ctx.args.playbookId);
    if (!projectId || !playbookId) {
      return ok({
        error:
          "projectId and playbookId (uuids) are required — a method is a playbook with scope 'project' (synap_list_playbooks).",
      });
    }
    return run(async () => {
      const result = await startTrack({
        projectId,
        playbookId,
        ...(str(ctx.args.name) ? { name: str(ctx.args.name) } : {}),
        ...(isParams(ctx.args.params) ? { params: ctx.args.params } : {}),
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
    return run(async () => {
      const result = await setTrackStatus({
        trackId,
        status,
        actor: actorOf(ctx),
      });
      if (result.status === "proposed") return result;
      return {
        status: result.status,
        track: await loadWrittenTrackView(result.track, ctx),
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
