/**
 * Hub REST — WHO IS ON A GOAL (`track_participants`, 0346, work model W3).
 *
 *   POST   /tracks/:id/participants          { principalId, role, commitment? }
 *                                            — add a judge, a delegate or an
 *                                            integrator (owner or judge only)
 *   DELETE /tracks/:id/participants/:pid     — remove someone (not the owner)
 *   POST   /tracks/:id/participants/:pid/answer       { move, text? } — the
 *                                            delegate answers their own
 *                                            commitment: accept · counter ·
 *                                            decline · report_impossible
 *   POST   /tracks/:id/participants/:pid/acknowledge  — the owner or judge
 *                                            acknowledges an "impossible" report
 *
 * Every rule lives in `services/tracks/track-participants.ts` — the same door
 * the tRPC `tracks.changeParticipants` procedure and the MCP tool
 * `synap_set_track_participant` call. Writes are governed: an agent key gets
 * `status: "proposed"` (HTTP 202 via `jsonGoverned`) — SUCCESS, not an error.
 * Participants are READ with the goal (`GET /tracks/:id`, `participants`).
 */

import { z } from "zod";
import type { Context } from "hono";
import {
  hasScope,
  httpStatusForTrpcError,
  logger,
  readJsonBody,
  type HubHono,
  type HubVariables,
} from "./_shared.js";
import { jsonGoverned } from "../proposal-response.js";
import type { TrackActor } from "../../../services/tracks/tracks-service.js";
import {
  changeTrackParticipants,
  trackParticipantChangeSchema,
  type TrackParticipantChange,
} from "../../../services/tracks/track-participants.js";

type Ctx = Context<{ Variables: HubVariables }, any, any>;

const Uuid = z.string().uuid();
const Reasoning = z.object({ reasoning: z.string().max(2000).optional() });

function actorOf(c: Ctx, reasoning?: string): TrackActor {
  return {
    userId: c.get("userId"),
    agentUserId: (c.get("agentUserId") as string | undefined) ?? null,
    isHubProtocol: true,
    source: "hub-rest",
    reasoning,
  };
}

/** Parse `{ ...change fields, reasoning? }` for one `op`, then run the door. */
async function change(
  c: Ctx,
  what: string,
  raw: Record<string, unknown>
): Promise<Response> {
  if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
    return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
  }
  const id = Uuid.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "Invalid track id" }, 400);
  const { reasoning, ...fields } = raw;
  const reason = Reasoning.safeParse({ reasoning });
  const parsed = trackParticipantChangeSchema.safeParse(fields);
  if (!parsed.success || !reason.success) {
    return c.json(
      {
        error: "Validation failed",
        details: [
          ...(parsed.success ? [] : parsed.error.issues),
          ...(reason.success ? [] : reason.error.issues),
        ],
      },
      400
    );
  }
  try {
    const result = await changeTrackParticipants({
      trackId: id.data,
      change: parsed.data as TrackParticipantChange,
      actor: actorOf(c, reason.data.reasoning),
    });
    return jsonGoverned(c, result);
  } catch (err) {
    const status = httpStatusForTrpcError(err);
    if (status === 500) logger.error({ err }, `${what} failed`);
    return c.json(
      { error: err instanceof Error ? err.message : `${what} failed` },
      status
    );
  }
}

/** The JSON body as an object — blank is `{}`, malformed is the 400 reply. */
async function body(
  c: Ctx
): Promise<
  { ok: true; body: Record<string, unknown> } | { ok: false; res: Response }
> {
  const read = await readJsonBody(c);
  if (!read.ok) return read;
  const b = read.body;
  return {
    ok: true,
    body:
      b && typeof b === "object" && !Array.isArray(b)
        ? (b as Record<string, unknown>)
        : {},
  };
}

export function registerTrackParticipantsRoutes(app: HubHono): void {
  app.post("/tracks/:id/participants", async (c) => {
    const b = await body(c);
    if (!b.ok) return b.res;
    return change(c, "POST /tracks/:id/participants", { ...b.body, op: "add" });
  });

  app.post("/tracks/:id/participants/:pid/answer", async (c) => {
    const b = await body(c);
    if (!b.ok) return b.res;
    return change(c, "POST /tracks/:id/participants/:pid/answer", {
      ...b.body,
      op: "move",
      participantId: c.req.param("pid"),
    });
  });

  app.post("/tracks/:id/participants/:pid/acknowledge", async (c) => {
    const b = await body(c);
    if (!b.ok) return b.res;
    return change(c, "POST /tracks/:id/participants/:pid/acknowledge", {
      reasoning: b.body.reasoning,
      op: "acknowledge",
      participantId: c.req.param("pid"),
    });
  });

  app.delete("/tracks/:id/participants/:pid", async (c) =>
    change(c, "DELETE /tracks/:id/participants/:pid", {
      op: "remove",
      participantId: c.req.param("pid"),
    })
  );
}
