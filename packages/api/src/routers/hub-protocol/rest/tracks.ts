/**
 * Hub REST — Tracks (`project_tracks`, 0272): a METHOD running inside a project.
 *
 *   GET   /tracks?projectId=…           the project's tracks
 *   POST  /tracks                       start a method { projectId, playbookId, name? }
 *   GET   /tracks/:id                   one track
 *   POST  /tracks/:id/advance           { toStage } — any declared stage
 *   PATCH /tracks/:id                   { status } — pause/resume/complete/archive
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
} from "./_shared.js";
import type { Context } from "hono";
import { jsonGoverned } from "../proposal-response.js";
import { PROJECT_TRACK_STATUSES } from "@synap/database/schema";
import {
  advanceTrackStage,
  getTrack,
  listTracks,
  setTrackStatus,
  startTrack,
  toTrackView,
  type TrackActor,
} from "../../../services/tracks/tracks-service.js";

const Uuid = z.string().uuid();
const StartSchema = z.object({
  projectId: Uuid,
  playbookId: Uuid,
  name: z.string().trim().min(1).max(200).optional(),
  reasoning: z.string().max(2000).optional(),
});
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
      return c.json({ items: rows.map(toTrackView) });
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
      if (result.status === "proposed") return jsonGoverned(c, result);
      return jsonGoverned(c, {
        status: result.status,
        track: toTrackView(result.track),
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
      return c.json(toTrackView(track));
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
      return jsonGoverned(c, { ...result, track: toTrackView(result.track) });
    } catch (err) {
      return fail(c, err, "POST /tracks/:id/advance");
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
        track: toTrackView(result.track),
      });
    } catch (err) {
      return fail(c, err, "PATCH /tracks/:id");
    }
  });
}
