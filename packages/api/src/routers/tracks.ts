/**
 * Tracks Router — a METHOD running inside a project (`project_tracks`, 0272).
 *
 * A thin door over `services/tracks`: every rule (visibility, the scope
 * refusal, the write floor, governance, the stage gate) lives in the service,
 * so this door, Hub REST `/api/hub/tracks` and the MCP track tools cannot
 * disagree. podProcedure: a project is a cross-cutting lens, reachable
 * pod-wide, exactly like `projects.get` — requiring an active workspace would
 * gate a read that does not use one.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, podProcedure } from "../trpc.js";
import { PROJECT_TRACK_STATUSES } from "@synap/database/schema";
import {
  advanceTrackStage,
  getTrack,
  listTracks,
  loadTrackView,
  loadTrackViews,
  loadWrittenTrackView,
  setTrackParams,
  setTrackDirection,
  addTrackStage,
  trackKpiInputSchema,
  addTrackStageInputSchema,
  setTrackStatus,
  startStageSession,
  startTrack,
  type TrackActor,
} from "../services/tracks/tracks-service.js";

function actorOf(
  ctx: { userId: string; agentUserId?: string | null; isHubProtocol?: boolean },
  reasoning?: string
): TrackActor {
  return {
    userId: ctx.userId,
    agentUserId: ctx.agentUserId ?? null,
    isHubProtocol: ctx.isHubProtocol,
    reasoning,
  };
}

/** Why — shown to the reviewer when the write lands as a proposal. */
const reasoning = z.string().max(2000).optional();
/** Answers to the method's declared params — validated by the service. */
const params = z.record(z.string(), z.unknown());

export const tracksRouter = router({
  /** The project's tracks (non-archived unless asked), oldest first. */
  list: podProcedure
    .input(
      z.object({
        projectId: z.string().uuid(),
        includeArchived: z.boolean().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const rows = await listTracks({
        projectId: input.projectId,
        actor: actorOf(ctx),
        includeArchived: input.includeArchived,
      });
      if (!rows) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project not found",
        });
      }
      return { items: await loadTrackViews(rows, ctx) };
    }),

  get: podProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const track = await getTrack(input.id, actorOf(ctx));
      if (!track) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Track not found" });
      }
      return loadTrackView(track, ctx);
    }),

  /** Start a project-scoped method on a project. Idempotent per method. */
  start: podProcedure
    .input(
      z.object({
        projectId: z.string().uuid(),
        playbookId: z.string().uuid(),
        name: z.string().trim().min(1).max(200).optional(),
        params: params.optional(),
        /** Where the track is heading, one line (0302). */
        direction: z.string().max(280).optional(),
        /** The number it steers by (0302) — a whole KPI: label + target. */
        kpi: trackKpiInputSchema.optional(),
        reasoning,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { reasoning: why, ...rest } = input;
      const result = await startTrack({ ...rest, actor: actorOf(ctx, why) });
      if (result.status === "proposed") return result;
      return {
        status: result.status,
        track: await loadWrittenTrackView(result.track, ctx),
      };
    }),

  /** Move to ANY declared stage of the pinned method (re-enterable). */
  advance: podProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        toStage: z.string().min(1).max(120),
        reasoning,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const result = await advanceTrackStage({
        trackId: input.id,
        toStage: input.toStage,
        actor: actorOf(ctx, input.reasoning),
      });
      if (result.status === "proposed") return result;
      return {
        ...result,
        track: await loadWrittenTrackView(result.track, ctx),
      };
    }),

  setStatus: podProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        status: z.enum(PROJECT_TRACK_STATUSES),
        reasoning,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const result = await setTrackStatus({
        trackId: input.id,
        status: input.status,
        actor: actorOf(ctx, input.reasoning),
      });
      if (result.status === "proposed") return result;
      return {
        status: result.status,
        track: await loadWrittenTrackView(result.track, ctx),
      };
    }),

  /**
   * Answer (some of) the method's params — merged onto the current answers;
   * `null` clears one. Governed `track/update`.
   */
  setParams: podProcedure
    .input(z.object({ id: z.string().uuid(), params, reasoning }))
    .mutation(async ({ ctx, input }) => {
      const result = await setTrackParams({
        trackId: input.id,
        params: input.params,
        actor: actorOf(ctx, input.reasoning),
      });
      if (result.status === "proposed") return result;
      return {
        status: result.status,
        track: await loadWrittenTrackView(result.track, ctx),
      };
    }),

  /**
   * Say where the track is heading and/or the number it steers by (0302).
   * `kpi` is a PATCH merged onto the stored KPI (`null` clears it); stating
   * `current` stamps when and by whom. Governed `track/update`. Reaching the
   * target nudges — it never completes the track.
   */
  setDirection: podProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        direction: z.string().max(280).nullable().optional(),
        kpi: trackKpiInputSchema.nullable().optional(),
        reasoning,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const result = await setTrackDirection({
        trackId: input.id,
        ...(input.direction !== undefined
          ? { direction: input.direction }
          : {}),
        ...(input.kpi !== undefined ? { kpi: input.kpi } : {}),
        actor: actorOf(ctx, input.reasoning),
      });
      if (result.status === "proposed") return result;
      return {
        status: result.status,
        track: await loadWrittenTrackView(result.track, ctx),
      };
    }),

  /**
   * Append an EMERGENT stage (0302) — work the method did not foresee.
   * Adding never enters it (advance does). Governed `track/update`.
   */
  addStage: podProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        stage: addTrackStageInputSchema,
        reasoning,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const result = await addTrackStage({
        trackId: input.id,
        stage: input.stage,
        actor: actorOf(ctx, input.reasoning),
      });
      if (result.status === "proposed") return result;
      return {
        status: result.status,
        stageKey: result.stageKey,
        track: await loadWrittenTrackView(result.track, ctx),
      };
    }),

  /**
   * Start the session a stage OFFERS (M2) — the ONE door. Idempotent on an
   * open session already filed at that stage; an agent PROPOSES.
   */
  startStageSession: podProcedure
    .input(
      z.object({
        trackId: z.string().uuid(),
        stageKey: z.string().min(1).max(120).optional(),
        title: z.string().max(200).optional(),
        goal: z.string().max(5000).optional(),
      })
    )
    .mutation(async ({ ctx, input }) =>
      startStageSession({ ...input, actor: actorOf(ctx) })
    ),
});
