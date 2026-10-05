/**
 * Hub REST — Tracks (`project_tracks`, 0272): a METHOD running inside a project.
 *
 *   GET   /tracks?projectId=…           the project's tracks
 *   POST  /tracks                       start a method { projectId, playbookId, name? }
 *   GET   /tracks/:id                   one track
 *   POST  /tracks/:id/advance           { toStage } — any declared stage
 *   PATCH /tracks/:id                   { status } — pause/resume/complete/archive
 *   PATCH /tracks/:id/params            { params } — answer the method's params
 *   PATCH /tracks/:id/direction         { direction?, kpi? } — where it is heading
 *                                       and the number it steers by (0302)
 *   POST  /tracks/:id/stages            { name, goal?, key? } — add an EMERGENT
 *                                       stage (appended; never entered)
 *   POST  /tracks/:id/stages/:stageKey/sessions  { title?, goal? } — start the
 *                                       session a stage offers (idempotent)
 *
 * Every rule lives in `services/tracks` (the same service the tRPC `tracks`
 * router and the MCP track tools call). Writes are governed: an agent key gets
 * `status: "proposed"` (HTTP 202 via `jsonGoverned`) — SUCCESS, not an error.
 * Static routes are registered BEFORE `/:id`.
 */

import { z } from "zod";
import {
  hasScope,
  httpStatusForTrpcError,
  logger,
  type HubHono,
  type HubVariables,
  readJsonBody,
} from "./_shared.js";
import type { Context } from "hono";
import { jsonGoverned } from "../proposal-response.js";
import { PROJECT_TRACK_STATUSES } from "@synap/database/schema";
import {
  advanceTrackStage,
  getTrack,
  listTracks,
  loadTrackView,
  loadTrackViews,
  loadWrittenTrackView,
  setTrackParams,
  setTrackStatus,
  setTrackDirection,
  addTrackStage,
  trackKpiInputSchema,
  addTrackStageInputSchema,
  startStageSession,
  startTrack,
  type TrackActor,
} from "../../../services/tracks/tracks-service.js";
import {
  missingStageDomainsNote,
  stageDomainFallbackNote,
} from "../../../services/tracks/stage-domain.js";

const Uuid = z.string().uuid();
const ParamsBag = z.record(z.string(), z.unknown());
const StartSchema = z.object({
  projectId: Uuid,
  playbookId: Uuid,
  name: z.string().trim().min(1).max(200).optional(),
  params: ParamsBag.optional(),
  direction: z.string().max(280).optional(),
  kpi: trackKpiInputSchema.optional(),
  reasoning: z.string().max(2000).optional(),
});
const DirectionSchema = z.object({
  direction: z.string().max(280).nullable().optional(),
  kpi: trackKpiInputSchema.nullable().optional(),
  reasoning: z.string().max(2000).optional(),
});
const AddStageSchema = addTrackStageInputSchema.extend({
  reasoning: z.string().max(2000).optional(),
});
const ParamsSchema = z.object({
  params: ParamsBag,
  reasoning: z.string().max(2000).optional(),
});
const StageSessionSchema = z.object({
  title: z.string().max(200).optional(),
  goal: z.string().max(5000).optional(),
});
const StageKey = z.string().min(1).max(120);
const AdvanceSchema = z.object({
  toStage: z.string().min(1).max(120),
  reasoning: z.string().max(2000).optional(),
});
const StatusSchema = z.object({
  status: z.enum(PROJECT_TRACK_STATUSES),
  reasoning: z.string().max(2000).optional(),
});

// Route-agnostic: the helpers read only Variables, never path params.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = Context<{ Variables: HubVariables }, any, any>;

function actorOf(c: Ctx, reasoning?: string): TrackActor {
  return {
    userId: c.get("userId"),
    agentUserId: (c.get("agentUserId") as string | undefined) ?? null,
    isHubProtocol: true,
    source: "hub-rest",
    reasoning,
  };
}

function fail(c: Ctx, err: unknown, what: string) {
  const status = httpStatusForTrpcError(err);
  if (status === 500) logger.error({ err }, `${what} failed`);
  return c.json(
    { error: err instanceof Error ? err.message : `${what} failed` },
    status
  );
}

export function registerTracksRoutes(app: HubHono): void {
  app.get("/tracks", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const projectId = Uuid.safeParse(c.req.query("projectId"));
    if (!projectId.success) {
      return c.json({ error: "projectId (uuid) is required" }, 400);
    }
    try {
      const rows = await listTracks({
        projectId: projectId.data,
        actor: actorOf(c),
        includeArchived: c.req.query("includeArchived") === "true",
      });
      if (!rows) return c.json({ error: "Project not found" }, 404);
      return c.json({ items: await loadTrackViews(rows, actorOf(c)) });
    } catch (err) {
      return fail(c, err, "GET /tracks");
    }
  });

  app.post("/tracks", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const body = StartSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { error: "Validation failed", details: body.error.issues },
        400
      );
    }
    try {
      const { reasoning, ...rest } = body.data;
      const result = await startTrack({
        ...rest,
        actor: actorOf(c, reasoning),
      });
      const domainsNote = missingStageDomainsNote(result.missingDomains);
      if (result.status === "proposed") {
        return jsonGoverned(c, {
          ...result,
          ...(domainsNote ? { domainsNote } : {}),
        });
      }
      return jsonGoverned(c, {
        status: result.status,
        track: await loadWrittenTrackView(result.track, actorOf(c)),
        missingDomains: result.missingDomains,
        ...(domainsNote ? { domainsNote } : {}),
      });
    } catch (err) {
      return fail(c, err, "POST /tracks");
    }
  });

  app.get("/tracks/:id", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const id = Uuid.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "Invalid track id" }, 400);
    try {
      const track = await getTrack(id.data, actorOf(c));
      if (!track) return c.json({ error: "Track not found" }, 404);
      return c.json(await loadTrackView(track, actorOf(c)));
    } catch (err) {
      return fail(c, err, "GET /tracks/:id");
    }
  });

  app.post("/tracks/:id/advance", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const id = Uuid.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "Invalid track id" }, 400);
    const body = AdvanceSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { error: "Validation failed", details: body.error.issues },
        400
      );
    }
    try {
      const result = await advanceTrackStage({
        trackId: id.data,
        toStage: body.data.toStage,
        actor: actorOf(c, body.data.reasoning),
      });
      if (result.status === "proposed") return jsonGoverned(c, result);
      return jsonGoverned(c, {
        ...result,
        track: await loadWrittenTrackView(result.track, actorOf(c)),
      });
    } catch (err) {
      return fail(c, err, "POST /tracks/:id/advance");
    }
  });

  // Static-suffix routes BEFORE the bare `PATCH /tracks/:id`.
  app.patch("/tracks/:id/params", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const id = Uuid.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "Invalid track id" }, 400);
    const body = ParamsSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { error: "Validation failed", details: body.error.issues },
        400
      );
    }
    try {
      const result = await setTrackParams({
        trackId: id.data,
        params: body.data.params,
        actor: actorOf(c, body.data.reasoning),
      });
      if (result.status === "proposed") return jsonGoverned(c, result);
      return jsonGoverned(c, {
        status: result.status,
        track: await loadWrittenTrackView(result.track, actorOf(c)),
      });
    } catch (err) {
      return fail(c, err, "PATCH /tracks/:id/params");
    }
  });

  app.patch("/tracks/:id/direction", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const id = Uuid.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "Invalid track id" }, 400);
    const body = DirectionSchema.safeParse(
      await c.req.json().catch(() => null)
    );
    if (!body.success) {
      return c.json(
        { error: "Validation failed", details: body.error.issues },
        400
      );
    }
    try {
      const { reasoning, direction, kpi } = body.data;
      const result = await setTrackDirection({
        trackId: id.data,
        ...(direction !== undefined ? { direction } : {}),
        ...(kpi !== undefined ? { kpi } : {}),
        actor: actorOf(c, reasoning),
      });
      if (result.status === "proposed") return jsonGoverned(c, result);
      return jsonGoverned(c, {
        status: result.status,
        track: await loadWrittenTrackView(result.track, actorOf(c)),
      });
    } catch (err) {
      return fail(c, err, "PATCH /tracks/:id/direction");
    }
  });

  app.post("/tracks/:id/stages", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const id = Uuid.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "Invalid track id" }, 400);
    const body = AddStageSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { error: "Validation failed", details: body.error.issues },
        400
      );
    }
    try {
      const { reasoning, ...stage } = body.data;
      const result = await addTrackStage({
        trackId: id.data,
        stage,
        actor: actorOf(c, reasoning),
      });
      if (result.status === "proposed") return jsonGoverned(c, result);
      return jsonGoverned(c, {
        status: result.status,
        stageKey: result.stageKey,
        track: await loadWrittenTrackView(result.track, actorOf(c)),
      });
    } catch (err) {
      return fail(c, err, "POST /tracks/:id/stages");
    }
  });

  app.post("/tracks/:id/stages/:stageKey/sessions", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const id = Uuid.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "Invalid track id" }, 400);
    const stageKey = StageKey.safeParse(c.req.param("stageKey"));
    if (!stageKey.success) return c.json({ error: "Invalid stage key" }, 400);
    // An empty body is fine — the stage's own goal is the default brief.
    const jsonRead = await readJsonBody(c);
    if (!jsonRead.ok) return jsonRead.res;
    const body = StageSessionSchema.safeParse(jsonRead.body);
    if (!body.success) {
      return c.json(
        { error: "Validation failed", details: body.error.issues },
        400
      );
    }
    try {
      const result = await startStageSession({
        trackId: id.data,
        stageKey: stageKey.data,
        ...body.data,
        actor: actorOf(c),
      });
      const domainNote = stageDomainFallbackNote(result.domainFallback);
      return jsonGoverned(c, domainNote ? { ...result, domainNote } : result);
    } catch (err) {
      return fail(c, err, "POST /tracks/:id/stages/:stageKey/sessions");
    }
  });

  app.patch("/tracks/:id", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const id = Uuid.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "Invalid track id" }, 400);
    const body = StatusSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { error: "Validation failed", details: body.error.issues },
        400
      );
    }
    try {
      const result = await setTrackStatus({
        trackId: id.data,
        status: body.data.status,
        actor: actorOf(c, body.data.reasoning),
      });
      if (result.status === "proposed") return jsonGoverned(c, result);
      return jsonGoverned(c, {
        status: result.status,
        track: await loadWrittenTrackView(result.track, actorOf(c)),
      });
    } catch (err) {
      return fail(c, err, "PATCH /tracks/:id");
    }
  });
}
