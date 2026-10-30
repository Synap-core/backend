/**
 * Hub Protocol REST — GET /timeline: what happened to a goal, a session or a
 * pull request, newest first.
 *
 * The same read as MCP `synap_get_timeline` (`services/timeline/read-timeline.ts`,
 * contract `TimelineWire` in `@synap-core/types/units`); a goal's is the goal
 * history read behind tRPC `tracks.history`. An agent door: sessions are read
 * owner-only, and a workspace-bound key reads its own workspace's sessions and
 * facts. A goal's history has no workspace lens yet, so a bound key is refused
 * it (403), never answered past its workspace.
 */

import { z } from "@hono/zod-openapi";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  confineWorkspaceOrForbidden,
  hasScope,
  httpStatusForTrpcError,
  logger,
  resolveActingContext,
  type HubHono,
} from "./_shared.js";
import {
  readTimeline,
  timelineSubjectOf,
} from "../../../services/timeline/read-timeline.js";

/** `TimelineWire` (`@synap-core/types/units`). */
const TimelineWireSchema = z
  .object({
    subject: z
      .object({
        kind: z.enum(["goal", "session", "pull_request"]),
      })
      .passthrough(),
    /** Newest first; each `{ id, kind, at, recordedAt?, actor, refs, … }`. */
    events: z.array(z.object({}).passthrough()),
    truncated: z.boolean(),
  })
  .openapi("Timeline");

const TimelineQuerySchema = z
  .object({
    goalId: z.string().optional().describe("A goal (track) id."),
    sessionId: z.string().optional().describe("A focus session id."),
    pr: z
      .string()
      .optional()
      .describe("A pull request: `owner/name#n` or its GitHub url."),
  })
  .openapi("TimelineQuery");

export function registerTimelineRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "get",
    path: "/timeline",
    tags: ["FocusSessions"],
    summary: "What happened to a goal, a session or a pull request",
    description:
      "Newest first. Name exactly one subject: `goalId` (its history: step " +
      "moves, checks, sessions, decisions, status moves), `sessionId` (its " +
      "start, status moves with their holds, the dev facts of its PRs and " +
      "devbox jobs, its decisions) or `pr` (`owner/name#n`: its opened / " +
      "merged / closed facts and CI runs). `at` is when a thing happened; " +
      "`recordedAt` appears only when the pod recorded it a second or more " +
      "later (a backdated move, a late webhook). 404 when the goal or " +
      "session is not yours; a PR with no recorded fact has no events.",
    request: { query: TimelineQuerySchema },
    responses: {
      200: { description: "Timeline", schema: TimelineWireSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.get("/timeline", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const subject = timelineSubjectOf({
      goalId: c.req.query("goalId"),
      sessionId: c.req.query("sessionId"),
      pr: c.req.query("pr"),
    });
    if (!subject.ok) return c.json({ error: subject.error }, 400);
    const confined = confineWorkspaceOrForbidden(c, undefined);
    if (!confined.ok) return c.json({ error: confined.error }, 403);
    if (confined.workspaceId && subject.subject.kind === "goal") {
      return c.json(
        {
          error:
            "A workspace-bound key cannot read a goal's history: it has no workspace lens yet.",
        },
        403
      );
    }
    const acting = await resolveActingContext(c, {});
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    try {
      const timeline = await readTimeline(subject.subject, {
        userId: acting.userId,
        isHubProtocol: true,
        ...(confined.workspaceId ? { lens: confined.workspaceId } : {}),
      });
      if (!timeline) return c.json({ error: "Not found" }, 404);
      return c.json(timeline, 200);
    } catch (err) {
      logger.error({ err }, "GET /timeline failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  });
}
