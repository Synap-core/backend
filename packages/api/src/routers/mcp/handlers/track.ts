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
  advanceTrackStage,
  getTrack,
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
  type SetTrackStatusResult,
  type TrackActor,
  type TrackView,
} from "../../../services/tracks/tracks-service.js";
import { pickTrackGoalInput } from "../../../services/tracks/goal-content.js";
import {
  pickGoalPlacementInput,
  readGoalPlacements,
} from "../../../services/tracks/goal-placement.js";
import { lifecycleConflictOf } from "../../../services/lifecycle/conflict.js";
import { convertEntityToGoal } from "../../../services/tracks/convert-to-goal.js";
import {
  missingStageDomainsNote,
  stageDomainFallbackNote,
} from "../../../services/tracks/stage-domain.js";
import {
  ok,
  requireScope,
  pageSlice,
  LIST_PAGE_DEFAULT,
  LIST_PAGE_MAX,
  type McpToolContext,
  type CallToolResult,
  type McpHandlerMap,
} from "./shared.js";
import { moveHoldToolArgs } from "../../../services/lifecycle/hold-input.js";
import { hasBlockerEdits, parseBlockerEdits } from "./blocker-args.js";

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

/** The list row an agent scans to pick a goal (`detail: 'lean'`). */
function leanTrackRow(view: TrackView) {
  return {
    id: view.id,
    name: view.name,
    status: view.status,
    pausedBy: view.pausedBy,
    verdict: view.verdict,
    direction: view.direction,
    kpi: view.kpi,
    updatedAt: view.updatedAt,
  };
}

/**
 * Each row with where its goal sits (ticket 3fb0e2c3): `parentGoalId` and
 * `pillars` (the space ids it advances, primary first), each only when set,
 * so a page of root goals costs nothing more. ONE read for the page.
 */
async function withPlacement<T extends { id: string }>(
  rows: T[]
): Promise<Array<T & { parentGoalId?: string; pillars?: string[] }>> {
  const placed = await readGoalPlacements(rows.map((r) => r.id));
  return rows.map((r) => {
    const p = placed.get(r.id);
    return {
      ...r,
      ...(p?.parentGoalId ? { parentGoalId: p.parentGoalId } : {}),
      ...(p?.pillars.length ? { pillars: p.pillars } : {}),
    };
  });
}

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    return ok({ error: err instanceof Error ? err.message : String(err) });
  }
}

export const trackHandlers = {
  synap_list_tracks: async (ctx) => {
    requireScope(ctx.apiKeyScopes, "mcp.read", ctx.toolName);
    const projectId = uuid(ctx.args.projectId);
    // ONE goal: the same read and the same view as a list row, found by its id
    // (ticket 635fbe22 — an agent holding a track id had to list a whole
    // project and filter). A malformed id is refused, never read as "absent".
    if (ctx.args.trackId != null) {
      const trackId = uuid(ctx.args.trackId);
      if (!trackId) {
        return ok({
          error:
            "trackId must be a goal (track) uuid — synap_list_tracks lists a project's goals.",
        });
      }
      return run(async () => {
        const row = await getTrack(trackId, actorOf(ctx));
        // The floor is the project's visibility, so "no such goal" and "a goal
        // you cannot see" read the same; a stated projectId must match.
        if (!row || (projectId && row.projectId !== projectId)) {
          return { error: "Track not found" };
        }
        return {
          items: await withPlacement(await loadTrackViews([row], ctx)),
        };
      });
    }
    if (!projectId) {
      return ok({
        error:
          "projectId (uuid) is required — find it with synap_list_projects. Or pass trackId to read one goal.",
      });
    }
    // `detail` (tickets c3d00d79, 9753144a): a full row carries criteria,
    // stages, participants and the loop, so one default page of a busy
    // project was ~80k chars, cut by the reply cap before the goal a caller
    // looked for. `lean` (default) is the row an agent scans to pick a goal,
    // as synap_list_sessions does; `full` (or `trackId`) reads it whole.
    const detail = ctx.args.detail ?? "lean";
    const name = str(ctx.args.name)?.toLowerCase();
    return run(async () => {
      const rows = await listTracks({
        projectId,
        actor: actorOf(ctx),
        includeArchived: ctx.args.includeArchived === true,
      });
      if (!rows) return { error: "Project not found" };
      // `name`: a routine finds its own goal by name, before the page is cut.
      const named = name
        ? rows.filter((r) => r.name.toLowerCase().includes(name))
        : rows;
      const { page, paging } = pageSlice(
        named,
        ctx.args,
        LIST_PAGE_DEFAULT,
        LIST_PAGE_MAX
      );
      const views = await loadTrackViews(page, ctx);
      return {
        items: await withPlacement(
          detail === "full" ? views : views.map(leanTrackRow)
        ),
        ...paging,
      };
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
        ...(ctx.args.params ? { params: ctx.args.params } : {}),
        ...(str(ctx.args.direction)
          ? { direction: str(ctx.args.direction) }
          : {}),
        ...(ctx.args.kpi != null ? { kpi: ctx.args.kpi } : {}),
        // What the goal holds (0345) — parsed (2–5 criteria, meanings) by
        // the service; a malformed one comes back as `{ error }` words.
        ...pickTrackGoalInput(ctx.args),
        // Where it sits (parentGoalId, pillars) — parsed by the service.
        ...pickGoalPlacementInput(ctx.args),
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
    // The id's uuid format is not in the schema: checked here.
    if (!trackId) {
      return ok({
        error:
          "trackId (uuid) is required — synap_list_tracks lists the project's tracks.",
      });
    }
    const { status, verdict, expectedStatus } = ctx.args;
    return run(async () => {
      // The verdict rule (closing needs one, impossible/replaced a reason)
      // and the expectedStatus rule are the service's, refused with words
      // before anything is filed.
      let result: SetTrackStatusResult;
      try {
        result = await setTrackStatus({
          trackId,
          status,
          verdict,
          verdictReason: str(ctx.args.verdictReason),
          ...(expectedStatus ? { expectedStatus } : {}),
          actor: actorOf(ctx),
          // A pause's hold and the move's time (W4), checked by the service.
          ...moveHoldToolArgs(ctx.args),
        });
      } catch (err) {
        // A stale status move is an answer the agent re-plans on, not a fault.
        const conflict = lifecycleConflictOf(err);
        if (conflict) return conflict;
        throw err;
      }
      // D1 step 1: a move without the agent's read still runs — say so, so
      // the agent sends it before it becomes a refusal.
      const warning =
        expectedStatus || !ctx.agentUserId
          ? {}
          : {
              warning:
                "Pass expectedStatus (the status you read the goal in): status moves without it will be refused.",
            };
      if (result.status === "proposed") return { ...result, ...warning };
      return {
        status: result.status,
        track: await loadWrittenTrackView(result.track, ctx),
        ...warning,
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

  // D2 — "Make it a goal": the SAME service the tRPC and Hub REST convert
  // doors call (`convertEntityToGoal` → `startTrack` with `fromEntity`), so an
  // agent's conversion is governed exactly like an agent's start.
  synap_convert_to_goal: async (ctx) => {
    requireScope(ctx.apiKeyScopes, "mcp.write", ctx.toolName);
    const entityId = uuid(ctx.args.entityId);
    if (!entityId) {
      return ok({
        error:
          "entityId (uuid) is required — the goal, objective or OKR entity to make a goal (synap_find lists them by kind).",
      });
    }
    const projectId = uuid(ctx.args.projectId);
    if (str(ctx.args.projectId) && !projectId) {
      return ok({ error: "projectId must be a project uuid." });
    }
    return run(async () => {
      const result = await convertEntityToGoal({
        entityId,
        ...(projectId ? { projectId } : {}),
        ...(str(ctx.args.name) ? { name: str(ctx.args.name) } : {}),
        actor: actorOf(ctx),
      });
      if (result.status === "proposed") return result;
      return {
        status: result.status,
        track: await loadWrittenTrackView(result.track, ctx),
        entityId: result.entityId,
        notCarried: result.notCarried,
      };
    });
  },

  synap_set_track_params: async (ctx) => {
    requireScope(ctx.apiKeyScopes, "mcp.write", ctx.toolName);
    const trackId = uuid(ctx.args.trackId);
    // The id's uuid format is not in the schema: checked here.
    if (!trackId) {
      return ok({
        error:
          "trackId (uuid) is required — synap_list_tracks returns each track's declaredParams.",
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
    const placement = pickGoalPlacementInput(ctx.args);
    // The goals THIS goal waits on (`track --blocked_by--> track`).
    const blockers = parseBlockerEdits(ctx.args, ["track"]);
    if ("error" in blockers) return ok(blockers);
    const editsBlockers = hasBlockerEdits(blockers);
    const editsFields =
      hasDirection ||
      hasKpi ||
      Object.keys(goal).length > 0 ||
      Object.keys(placement).length > 0;
    if (!trackId || (!editsFields && !editsBlockers)) {
      return ok({
        error:
          "trackId (uuid) and something to change are required — direction, kpi, endState, criteria, dropConditions, workKind, uncertainty, loop, parentGoalId, pillars, addBlockedByTrackIds or removeBlockedByTrackIds. synap_list_tracks lists the project's tracks.",
      });
    }
    const direction = ctx.args.direction;
    if (hasDirection && direction !== null && typeof direction !== "string") {
      return ok({ error: "direction is one line of text, or null to clear." });
    }
    /** THE governed dependency door, per id (`unit-blockers.ts`). */
    const blockerReports = async () => {
      if (!editsBlockers) return {};
      const { applyUnitBlockerEdits } =
        await import("../../../services/links/unit-blockers.js");
      const r = await applyUnitBlockerEdits({
        from: { type: "track", id: trackId },
        add: { entity: [], track: blockers.track.add },
        remove: { entity: [], track: blockers.track.remove },
        userId: ctx.userId,
        agentUserId: ctx.agentUserId ?? null,
        sessionId: ctx.sessionId ?? null,
        door: "mcp:synap_update_track",
      });
      return {
        ...(r.links.length > 0 ? { blockerLinks: r.links } : {}),
        ...(r.removals.length > 0 ? { blockerRemovals: r.removals } : {}),
      };
    };
    if (!editsFields) {
      return run(async () => ({ trackId, ...(await blockerReports()) }));
    }
    return run(async () => {
      const result = await setTrackDirection({
        trackId,
        ...(hasDirection ? { direction: direction as string | null } : {}),
        ...(hasKpi ? { kpi: ctx.args.kpi } : {}),
        ...goal,
        ...placement,
        actor: actorOf(ctx),
      });
      // After the fields: a refused field edit writes no edge either.
      const edges = await blockerReports();
      if (result.status === "proposed") return { ...result, ...edges };
      return {
        status: result.status,
        track: await loadWrittenTrackView(result.track, ctx),
        ...edges,
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
} satisfies McpHandlerMap;
