/**
 * Hub REST — Tracks (`project_tracks`, 0272): a METHOD running inside a project.
 *
 *   GET   /tracks?projectId=…           the project's tracks (every one,
 *                                       oldest first); WITHOUT projectId every
 *                                       goal the caller can see, newest first,
 *                                       paged (?limit=…&cursor=… → nextCursor)
 *   POST  /tracks                       start a track { projectId, playbookId?, name? }
 *   POST  /tracks/convert               "Make it a goal" { entityId, projectId?,
 *                                       name? } — a goal / objective / okr
 *                                       entity becomes a goal, once (D2)
 *   GET   /tracks/:id                   one track
 *   POST  /tracks/:id/advance           { toStage } — any declared stage
 *   POST  /tracks/:id/reopen            { name? } — a closed goal as a NEW
 *                                       version, linked `replaces` (R8)
 *   POST  /tracks/:id/operation         { name? } — keep a goal closed as met
 *                                       running: a new operation, linked
 *                                       `spawned_from` (R6)
 *   PATCH /tracks/:id                   { status, verdict?, verdictReason? } —
 *                                       any move of the track lifecycle; a
 *                                       close/drop carries its verdict
 *   PATCH /tracks/:id/params            { params } — answer the method's params
 *   PATCH /tracks/:id/direction         { direction?, kpi?, endState?, criteria?,
 *                                       dropConditions?, workKind?, uncertainty?,
 *                                       confirmKind? } — where it is heading, the
 *                                       number it steers by (0302) and what the
 *                                       goal holds (0345)
 *   POST  /tracks/:id/criteria/:key/acceptance  { decision, note? } — the
 *                                       goal's JUDGE accepts, sends back or
 *                                       rejects a criterion (R2; never an agent)
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
import {
  PROJECT_TRACK_STATUSES,
  PROJECT_TRACK_VERDICTS,
} from "@synap/database/schema";
import { GOAL_ACCEPTANCE_DECISIONS } from "@synap-core/types/units";
import { trackGoalInputSchema } from "../../../services/tracks/goal-content.js";
import { lifecycleConflictOf } from "../../../services/lifecycle/conflict.js";
import {
  advanceTrackStage,
  decodeTrackListCursor,
  getTrack,
  listTracks,
  listTracksPage,
  TRACK_LIST_PAGE_DEFAULT,
  TRACK_LIST_PAGE_MAX,
  loadTrackView,
  loadTrackViews,
  loadWrittenTrackView,
  setTrackParams,
  setTrackStatus,
  reopenTrack,
  startOperationFrom,
  setTrackDirection,
  addTrackStage,
  trackKpiInputSchema,
  addTrackStageInputSchema,
  startStageSession,
  startTrack,
  acceptGoalCriterion,
  type TrackActor,
} from "../../../services/tracks/tracks-service.js";
import {
  missingStageDomainsNote,
  stageDomainFallbackNote,
} from "../../../services/tracks/stage-domain.js";
import {
  convertEntityToGoal,
  convertToGoalInputSchema,
} from "../../../services/tracks/convert-to-goal.js";

const Uuid = z.string().uuid();
const ParamsBag = z.record(z.string(), z.unknown());
const StartSchema = z
  .object({
    projectId: Uuid,
    // OPTIONAL (W1): a track is a lasting intent; the method is optional.
    playbookId: Uuid.optional(),
    name: z.string().trim().min(1).max(200).optional(),
    params: ParamsBag.optional(),
    direction: z.string().max(280).optional(),
    kpi: trackKpiInputSchema.optional(),
    reasoning: z.string().max(2000).optional(),
    // What the goal holds (0345) — refined (2–5 criteria) by the service.
  })
  .extend(trackGoalInputSchema.shape);
const DirectionSchema = z
  .object({
    direction: z.string().max(280).nullable().optional(),
    kpi: trackKpiInputSchema.nullable().optional(),
    reasoning: z.string().max(2000).optional(),
  })
  .extend(trackGoalInputSchema.shape);
const AcceptanceSchema = z.object({
  decision: z.enum(GOAL_ACCEPTANCE_DECISIONS),
  note: z.string().trim().max(2000).optional(),
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
  verdict: z.enum(PROJECT_TRACK_VERDICTS).optional(),
  verdictReason: z.string().trim().max(2000).optional(),
  /** The status the caller read — required for an agent (409 when stale). */
  expectedStatus: z.enum(PROJECT_TRACK_STATUSES).optional(),
  reasoning: z.string().max(2000).optional(),
});
const ReopenSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  reasoning: z.string().max(2000).optional(),
});

// Route-agnostic: the helpers read only Variables, never path params.

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
    // `projectId` OPTIONAL (W5): without it, every goal the caller can see,
    // pod-wide, newest first and paged — the same read as the tRPC door.
    const rawProject = c.req.query("projectId");
    const projectId = rawProject ? Uuid.safeParse(rawProject) : null;
    if (projectId && !projectId.success) {
      return c.json({ error: "projectId must be a uuid" }, 400);
    }
    const rawLimit = c.req.query("limit");
    const limit = rawLimit
      ? z.coerce
          .number()
          .int()
          .min(1)
          .max(TRACK_LIST_PAGE_MAX)
          .safeParse(rawLimit)
      : null;
    if (limit && !limit.success) {
      return c.json(
        { error: `limit must be an integer 1–${TRACK_LIST_PAGE_MAX}` },
        400
      );
    }
    const rawCursor = c.req.query("cursor");
    const cursor = decodeTrackListCursor(rawCursor);
    if (rawCursor && !cursor) {
      return c.json(
        { error: "cursor is not a cursor this read returned" },
        400
      );
    }
    const includeArchived = c.req.query("includeArchived") === "true";
    try {
      if (projectId && !limit && !cursor) {
        const rows = await listTracks({
          projectId: projectId.data,
          actor: actorOf(c),
          includeArchived,
        });
        if (!rows) return c.json({ error: "Project not found" }, 404);
        return c.json({
          items: await loadTrackViews(rows, actorOf(c)),
          nextCursor: null,
        });
      }
      const page = await listTracksPage({
        projectId: projectId?.data ?? null,
        actor: actorOf(c),
        includeArchived,
        limit: limit?.data ?? TRACK_LIST_PAGE_DEFAULT,
        cursor,
      });
      if (!page) return c.json({ error: "Project not found" }, 404);
      return c.json({
        items: await loadTrackViews(page.rows, actorOf(c)),
        nextCursor: page.nextCursor,
      });
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

  // Static route — BEFORE every `/tracks/:id…` route.
  app.post("/tracks/convert", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const body = convertToGoalInputSchema.safeParse(
      await c.req.json().catch(() => null)
    );
    if (!body.success) {
      return c.json(
        { error: "Validation failed", details: body.error.issues },
        400
      );
    }
    try {
      const { reasoning, ...rest } = body.data;
      const result = await convertEntityToGoal({
        ...rest,
        actor: actorOf(c, reasoning),
      });
      if (result.status === "proposed") return jsonGoverned(c, result);
      return jsonGoverned(c, {
        status: result.status,
        track: await loadWrittenTrackView(result.track, actorOf(c)),
        entityId: result.entityId,
        notCarried: result.notCarried,
      });
    } catch (err) {
      return fail(c, err, "POST /tracks/convert");
    }
  });

  app.get("/tracks/:id", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const id = Uuid.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "Invalid goal id" }, 400);
    try {
      const track = await getTrack(id.data, actorOf(c));
      if (!track) return c.json({ error: "Goal not found" }, 404);
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
    if (!id.success) return c.json({ error: "Invalid goal id" }, 400);
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

  app.post("/tracks/:id/reopen", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const id = Uuid.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "Invalid goal id" }, 400);
    // The body is optional (a reopen keeps the name): blank → {}, malformed → 400.
    const jsonRead = await readJsonBody(c);
    if (!jsonRead.ok) return jsonRead.res;
    const body = ReopenSchema.safeParse(jsonRead.body);
    if (!body.success) {
      return c.json(
        { error: "Validation failed", details: body.error.issues },
        400
      );
    }
    try {
      const result = await reopenTrack({
        trackId: id.data,
        name: body.data.name,
        actor: actorOf(c, body.data.reasoning),
      });
      if (result.status === "proposed") return jsonGoverned(c, result);
      return jsonGoverned(c, {
        status: result.status,
        track: await loadWrittenTrackView(result.track, actorOf(c)),
        missingDomains: result.missingDomains,
      });
    } catch (err) {
      return fail(c, err, "POST /tracks/:id/reopen");
    }
  });

  app.post("/tracks/:id/operation", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const id = Uuid.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "Invalid goal id" }, 400);
    // Optional body (the operation keeps the goal's name), as for a reopen.
    const jsonRead = await readJsonBody(c);
    if (!jsonRead.ok) return jsonRead.res;
    const body = ReopenSchema.safeParse(jsonRead.body);
    if (!body.success) {
      return c.json(
        { error: "Validation failed", details: body.error.issues },
        400
      );
    }
    try {
      const result = await startOperationFrom({
        trackId: id.data,
        name: body.data.name,
        actor: actorOf(c, body.data.reasoning),
      });
      if (result.status === "proposed") return jsonGoverned(c, result);
      return jsonGoverned(c, {
        status: result.status,
        track: await loadWrittenTrackView(result.track, actorOf(c)),
        missingDomains: result.missingDomains,
      });
    } catch (err) {
      return fail(c, err, "POST /tracks/:id/operation");
    }
  });

  // Static-suffix routes BEFORE the bare `PATCH /tracks/:id`.
  app.patch("/tracks/:id/params", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const id = Uuid.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "Invalid goal id" }, 400);
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
    if (!id.success) return c.json({ error: "Invalid goal id" }, 400);
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
      const { reasoning, direction, kpi, ...goal } = body.data;
      const result = await setTrackDirection({
        trackId: id.data,
        ...(direction !== undefined ? { direction } : {}),
        ...(kpi !== undefined ? { kpi } : {}),
        ...goal,
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

  app.post("/tracks/:id/criteria/:key/acceptance", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const id = Uuid.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "Invalid goal id" }, 400);
    const body = AcceptanceSchema.safeParse(
      await c.req.json().catch(() => null)
    );
    if (!body.success) {
      return c.json(
        { error: "Validation failed", details: body.error.issues },
        400
      );
    }
    try {
      // A person's act: an agent key is refused (403) by the service, and so
      // is anyone but the goal's judge — never filed as a proposal.
      const result = await acceptGoalCriterion({
        trackId: id.data,
        criterionKey: c.req.param("key"),
        decision: body.data.decision,
        note: body.data.note,
        actor: actorOf(c),
      });
      return c.json({
        status: result.status,
        track: await loadWrittenTrackView(result.track, actorOf(c)),
      });
    } catch (err) {
      return fail(c, err, "POST /tracks/:id/criteria/:key/acceptance");
    }
  });

  app.post("/tracks/:id/stages", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const id = Uuid.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "Invalid goal id" }, 400);
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
    if (!id.success) return c.json({ error: "Invalid goal id" }, 400);
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
    if (!id.success) return c.json({ error: "Invalid goal id" }, 400);
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
        verdict: body.data.verdict,
        verdictReason: body.data.verdictReason,
        expectedStatus: body.data.expectedStatus,
        actor: actorOf(c, body.data.reasoning),
      });
      if (result.status === "proposed") return jsonGoverned(c, result);
      return jsonGoverned(c, {
        status: result.status,
        track: await loadWrittenTrackView(result.track, actorOf(c)),
      });
    } catch (err) {
      // A stale status move: the current status, 409, nothing written.
      const conflict = lifecycleConflictOf(err);
      if (conflict) return c.json(conflict, 409);
      return fail(c, err, "PATCH /tracks/:id");
    }
  });
}
