/**
 * Hub Protocol REST — events query (`query_recent_events` tool for IS agents)
 * + live SSE stream for external subscribers (OpenClaw, OpenWebUI mirror,
 * connectors that previously polled).
 */

import { randomUUID } from "crypto";

import { z } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";

import { createSynapEvent } from "@synap-core/core";
import { eventRepository, type EventRecord } from "@synap/database";

import { eventStreamManager } from "../../../event-stream-manager.js";
import { emitChatEvent } from "../../../utils/chat-realtime-broadcast.js";
import { ErrorSchema } from "./_codecs/_openapi.js";
import { ListEventsQuerySchema, WireEventSchema } from "./_codecs/misc.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  getUserAccessibleWorkspaceIds,
  hasScope,
  isUuid,
  logger,
  resolveActingContext,
  type HubHono,
} from "./_shared.js";

/**
 * Body contract for POST /agent-runs. costUsd is nullable (NULL = provider did
 * not report a price — honest, never a fabricated 0). latencyMs / toolCount /
 * runStatus are required; everything else is optional.
 */
const AgentRunBodySchema = z.object({
  workspaceId: z.string(),
  agentUserId: z.string(),
  agentType: z.string(),
  threadId: z.string().optional(),
  sessionId: z.string().optional(),
  correlationId: z.string().uuid().optional(),
  tokensIn: z.number().int().optional(),
  tokensOut: z.number().int().optional(),
  tokensTotal: z.number().int().optional(),
  costUsd: z.number().nullable().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  latencyMs: z.number().int(),
  toolCount: z.number().int(),
  toolsUsed: z.array(z.string()).optional(),
  runStatus: z.enum(["succeeded", "failed"]),
  finishReason: z.string().optional(),
  errorMessage: z.string().optional(),
  summary: z.string().optional(),
});

export function registerEventsRoutes(app: HubHono): void {
  // ── OpenAPI metadata for /events (NOT /events/stream — SSE) ──────────────
  registerOpenApi(app, {
    method: "get",
    path: "/events",
    tags: ["Events"],
    summary: "List recent events for a user",
    description:
      "Returns events from the event log filtered by type/subject/window, and optionally by producer: `agentUserId` (everything one agent did), `isAgent` (agent- vs human-produced) and `correlationId` (one request chain). Default window is 7 days; default limit is 50, hard-capped at 200.",
    request: {
      query: ListEventsQuerySchema,
    },
    responses: {
      200: {
        description: "Events array (newest first)",
        schema: z.object({ events: z.array(WireEventSchema) }),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  /**
   * GET /events
   * Query the event log for IS agents (query_recent_events tool).
   * Supports: userId, workspaceId, type, subjectType, subjectId, fromDate, limit.
   */
  app.get("/events", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    // Pin to the authenticated owner — never the caller-supplied query userId
    // (it let an agent key read another user's event log).
    const userId = c.get("userId") as string;
    const type = c.req.query("type");
    const subjectType = c.req.query("subjectType");
    const subjectId = c.req.query("subjectId");
    const fromDateStr = c.req.query("fromDate");
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10), 200);

    // "What did this agent do?" — the reader for `events.agent_user_id` (indexed
    // since 0131). `agentUserId` is a TEXT column (Kratos identity id), so it is
    // NOT uuid-shape-checked; `correlationId` IS a uuid column, and a malformed
    // value there makes Postgres throw — which this route's catch would report as
    // a 500 (a client error dressed as a server fault). Shape-check it up front
    // and 400 instead.
    const agentUserId = c.req.query("agentUserId");
    const correlationId = c.req.query("correlationId");
    if (correlationId && !isUuid(correlationId)) {
      return c.json({ error: "correlationId must be a UUID" }, 400);
    }
    const isAgentRaw = c.req.query("isAgent");
    if (isAgentRaw !== undefined && !["true", "false"].includes(isAgentRaw)) {
      return c.json({ error: "isAgent must be 'true' or 'false'" }, 400);
    }
    const isAgent =
      isAgentRaw === undefined ? undefined : isAgentRaw === "true";

    if (!userId) return c.json({ error: "userId is required" }, 400);

    try {
      const events = await eventRepository.searchEvents({
        userId,
        eventType: type,
        subjectType: subjectType as any,
        subjectId,
        agentUserId,
        correlationId,
        isAgent,
        fromDate: fromDateStr
          ? new Date(fromDateStr)
          : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        limit,
      });
      return c.json({ events });
    } catch (err) {
      logger.error({ err, userId }, "listEvents failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * GET /events/stream — Server-Sent Events
   *
   * Long-lived SSE connection that pushes Synap event-chain events to the
   * subscriber in real time. Replaces polling for OpenClaw mirror, OpenWebUI
   * sync, and other external integrations.
   *
   * Auth: `hub-protocol.read` scope, Bearer API key (handled by upstream
   * middleware). Server clamps every event to the bearer-key user — never
   * trust the client to scope itself.
   *
   * Query params (all optional):
   *   ?entityType=<subjectType>  — e.g. "entity", "relation". Matched against
   *                                 events.subject_type.
   *   ?workspaceId=<id>           — matched against event.data.workspaceId.
   *                                 If the user is not a member of this
   *                                 workspace, the filter is silently dropped
   *                                 to "all my workspaces" (we never return a
   *                                 401 for an inaccessible workspace).
   *   ?since=<ISO timestamp>      — backfill catch-up: emit any events newer
   *                                 than `since` before going live. Use the
   *                                 ID of the last received event with a small
   *                                 negative skew to backfill missed events on
   *                                 reconnect.
   *
   * Emitted SSE frames:
   *   event: event       data: <EventRecord JSON>      id: <eventId>
   *   event: heartbeat   data: ""                       (every 30s, keeps
   *                                                      proxies — nginx,
   *                                                      Cloudflare — from
   *                                                      timing the connection
   *                                                      out)
   *
   * Reconnection: clients should track the last-seen event id (or its
   * timestamp) and reconnect with `?since=<timestamp>` to backfill missed
   * events.
   *
   * Delivery semantics: exactly-after-subscribe with at-least-once across the
   * subscribe/catch-up boundary. The handler subscribes to live events FIRST
   * and buffers them in-process while it drains the catch-up window from the
   * event log; once catch-up is flushed, the buffer is replayed and the
   * subscription is switched to direct write-through. This closes the race
   * window where events emitted between catch-up and subscribe would have
   * been lost. Because catch-up and the buffered live tail can overlap, the
   * SAME event may be delivered twice across that boundary — and across a
   * reconnect using `?since=` — so **consumers MUST dedupe by event id**.
   *
   * The buffer is capped at 1000 events; if the catch-up drain takes
   * pathologically long and the cap is exceeded, the overflow events are
   * dropped from the buffer (and a warning is logged). They are not lost
   * permanently — they remain in the event log and will be redelivered when
   * the client reconnects with an updated `?since=` timestamp.
   */
  app.get("/events/stream", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }

    const userId = c.get("userId") as string;
    const entityType = c.req.query("entityType");
    const workspaceIdParam = c.req.query("workspaceId");
    const since = c.req.query("since");

    // Clamp filters to what this user can see. We never reject for an
    // unknown/forbidden workspaceId — we silently drop the filter so the
    // caller doesn't gain side-channel info. The user only ever sees events
    // for their own userId.
    let allowedWorkspaceIds: string[] | undefined;
    let allowedSingleWorkspaceId: string | null = null;

    if (workspaceIdParam) {
      const accessibleWs = await getUserAccessibleWorkspaceIds(userId);
      if (accessibleWs.includes(workspaceIdParam)) {
        allowedSingleWorkspaceId = workspaceIdParam;
      } else {
        // Unknown / forbidden workspace — fall back to "all my workspaces".
        allowedWorkspaceIds = accessibleWs;
        logger.warn(
          { userId, workspaceIdParam },
          "events/stream: requested workspace not accessible — falling back to user-wide stream"
        );
      }
    }

    // SSE response headers are set by streamSSE; we add a couple extra to
    // disable proxy buffering. Setting them on the context BEFORE returning
    // streamSSE so they make it into the response.
    c.header("X-Accel-Buffering", "no");
    c.header("X-Synap-Stream", "events");

    return streamSSE(c, async (stream) => {
      let unsubscribe: (() => void) | null = null;
      let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
      let aborted = false;

      // Subscriber starts in `buffering` mode: incoming events are queued
      // (not written) until catch-up has been drained. After catch-up + the
      // buffer drain, mode flips to `live` and writes go straight through.
      // This closes the gap between catch-up read and subscription attach
      // that would otherwise lose events emitted in that window.
      let mode: "buffering" | "live" = "buffering";
      const buffer: EventRecord[] = [];
      const BUFFER_CAP = 1000;
      let bufferOverflowCount = 0;

      const cleanup = () => {
        aborted = true;
        if (unsubscribe) {
          try {
            unsubscribe();
          } catch (err) {
            logger.warn({ err }, "events/stream unsubscribe failed");
          }
          unsubscribe = null;
        }
        if (heartbeatInterval) {
          clearInterval(heartbeatInterval);
          heartbeatInterval = null;
        }
      };

      stream.onAbort(() => {
        cleanup();
      });

      try {
        // 1. Subscribe FIRST. While in `buffering` mode, every live event is
        //    pushed into a local queue rather than written to the stream.
        //    eventStreamManager.subscribe is synchronous (it just registers
        //    an in-memory subscriber), so there is no await gap here — any
        //    event broadcast on the next tick of the event loop will be
        //    captured by this subscriber.
        unsubscribe = eventStreamManager.subscribe({
          filter: {
            userId,
            entityType,
            workspaceId: allowedSingleWorkspaceId,
            workspaceIds: allowedWorkspaceIds,
          },
          onEvent: async (evt) => {
            if (aborted) return;
            if (mode === "buffering") {
              if (buffer.length < BUFFER_CAP) {
                buffer.push(evt);
              } else {
                // Cap exceeded: drop and count. The dropped event is still
                // durably in the event log; the client will pick it up on
                // the next reconnect via `?since=`.
                bufferOverflowCount++;
              }
              return;
            }
            try {
              await stream.writeSSE({
                event: "event",
                id: evt.id,
                data: JSON.stringify(evt),
              });
            } catch (err) {
              logger.warn(
                { err, userId, eventId: evt.id },
                "events/stream writeSSE failed — closing stream"
              );
              cleanup();
            }
          },
        });

        // 2. Drain catch-up. Drain any events newer than `since` for the
        //    caller — same logic as GET /events, just streamed. We pass
        //    workspaceId when the caller asked for one and is allowed;
        //    otherwise we let EventRepository.searchEvents return events
        //    for the user across all their workspaces (it'll naturally be
        //    clamped by user_id).
        if (since) {
          let sinceDate: Date | null = null;
          try {
            sinceDate = new Date(since);
            if (Number.isNaN(sinceDate.getTime())) sinceDate = null;
          } catch {
            sinceDate = null;
          }
          if (sinceDate) {
            const catchUp = await eventRepository.searchEvents({
              userId,
              subjectType: entityType,
              workspaceId: allowedSingleWorkspaceId ?? undefined,
              fromDate: sinceDate,
              limit: 500,
            });
            // searchEvents returns DESC by timestamp; flip to ASC for replay.
            for (let i = catchUp.length - 1; i >= 0; i--) {
              if (aborted) return;
              const evt = catchUp[i];
              // If we fell back to "all my workspaces", apply the additional
              // workspace clamp here (searchEvents only takes a single ID).
              if (allowedWorkspaceIds) {
                const wsId =
                  typeof evt.data === "object" && evt.data !== null
                    ? ((evt.data as Record<string, unknown>).workspaceId as
                        string | undefined | null)
                    : undefined;
                if (wsId && !allowedWorkspaceIds.includes(wsId)) continue;
              }
              try {
                await stream.writeSSE({
                  event: "event",
                  id: evt.id,
                  data: JSON.stringify(evt),
                });
              } catch (err) {
                logger.warn(
                  { err, userId, eventId: evt.id },
                  "events/stream writeSSE failed during catch-up — closing stream"
                );
                cleanup();
                return;
              }
            }
          }
        }

        if (aborted) return;

        // 3. Drain the buffered live events. Some of these may duplicate
        //    catch-up rows (an event written to the log AND broadcast over
        //    the in-memory bus before we finished step 2). That's the
        //    documented behavior — consumers dedupe by event id.
        //
        //    NOTE: the mode switch must happen AFTER this loop, otherwise
        //    events arriving during the drain would race between the buffer
        //    push and the direct write-through path.
        for (const evt of buffer) {
          if (aborted) return;
          try {
            await stream.writeSSE({
              event: "event",
              id: evt.id,
              data: JSON.stringify(evt),
            });
          } catch (err) {
            logger.warn(
              { err, userId, eventId: evt.id },
              "events/stream writeSSE failed during buffer drain — closing stream"
            );
            cleanup();
            return;
          }
        }
        buffer.length = 0;

        if (bufferOverflowCount > 0) {
          logger.warn(
            { userId, bufferOverflowCount, cap: BUFFER_CAP },
            "events/stream buffer cap exceeded during catch-up — overflow events will be redelivered on reconnect via ?since="
          );
        }

        // 4. Switch the subscription to direct write-through. From this
        //    point onward, the onEvent callback registered in step 1 writes
        //    straight to the stream instead of buffering.
        mode = "live";

        // 5. Heartbeat every 30s. Proxies (nginx, Cloudflare) routinely kill
        //    silent SSE connections within 30-60s of inactivity. Sending an
        //    explicit named `heartbeat` event (vs an SSE comment) means
        //    clients can also use it to detect connection health.
        heartbeatInterval = setInterval(() => {
          if (aborted) return;
          stream.writeSSE({ event: "heartbeat", data: "" }).catch((err) => {
            logger.warn(
              { err, userId },
              "events/stream heartbeat failed — closing stream"
            );
            cleanup();
          });
        }, 30_000);

        // 6. Block until the stream is aborted. streamSSE's `run()` wrapper
        //    calls `stream.close()` as soon as this callback resolves, so we
        //    must NOT resolve until we're done.
        await new Promise<void>((resolve) => {
          stream.onAbort(() => resolve());
        });
      } finally {
        cleanup();
      }
    });
  });

  /**
   * POST /agent-runs — "watch your agent work"
   *
   * Records a completed agent run as an `agentRun.create.completed` event with
   * first-class telemetry columns (cost / tokens / latency / tool count /
   * authorship). Persisted via the HOOKED eventRepository.append() so it both
   * lands in the event log AND broadcasts to the realtime bus (Socket.IO
   * `agent_run:updated` + SSE) for the live agent-watch surface.
   *
   * Static route — declared before any future `/:id` dynamic route.
   */
  app.post("/agent-runs", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }

    // Pin ownership to the authenticated bearer-key user — never trust a body
    // userId (would let an agent key write into another user's event log).
    const userId = c.get("userId") as string;
    if (!userId) return c.json({ error: "userId is required" }, 400);

    const raw = await c.req.json().catch(() => null);
    if (!raw) return c.json({ error: "Invalid JSON body" }, 400);

    const parsed = AgentRunBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid body", issues: parsed.error.flatten() },
        400
      );
    }
    const b = parsed.data;

    const runId = randomUUID();

    try {
      const event = createSynapEvent({
        type: "agentRun.create.completed",
        subjectId: runId,
        subjectType: "agentRun",
        userId,
        // Workspace + non-telemetry context lives in data so realtime targeting
        // (event.data.workspaceId) and downstream consumers can read it.
        data: {
          workspaceId: b.workspaceId,
          threadId: b.threadId,
          sessionId: b.sessionId,
          toolsUsed: b.toolsUsed,
          summary: b.summary,
          errorMessage: b.errorMessage,
        },
        correlationId: b.correlationId,
        // First-class telemetry → real columns on events.
        isAgent: true,
        agentUserId: b.agentUserId,
        agentType: b.agentType,
        model: b.model,
        provider: b.provider,
        costUsd: b.costUsd ?? null,
        tokensIn: b.tokensIn,
        tokensOut: b.tokensOut,
        tokensTotal: b.tokensTotal,
        latencyMs: b.latencyMs,
        toolCount: b.toolCount,
        runStatus: b.runStatus,
        finishReason: b.finishReason,
      });

      const record = await eventRepository.append(event);
      return c.json({ eventId: record.id, runId });
    } catch (err) {
      logger.error({ err, userId, runId }, "POST /agent-runs failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * GET /agent-runs — list completed agent runs for external agents.
   *
   * Read counterpart to POST /agent-runs: returns `agentRun.create.completed`
   * events (newest first) with their telemetry projection. Scoped to the
   * authenticated bearer-key user — never a caller-supplied userId.
   *
   * Static route — declared before any future `/:id` dynamic route on this
   * router (Hono matches in declaration order).
   *
   * Query params (all optional):
   *   ?workspaceId=<id>  — narrow to a single workspace (data.workspaceId)
   *   ?limit=<n>          — default 50, hard-capped at 200
   */
  app.get("/agent-runs", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    // Pin to the authenticated owner — never a caller-supplied query userId.
    const userId = c.get("userId") as string;
    if (!userId) return c.json({ error: "userId is required" }, 400);

    const workspaceId = c.req.query("workspaceId");
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10), 200);

    try {
      const runs = await eventRepository.listAgentRuns({
        userId,
        workspaceId,
        limit,
      });
      const agentRuns = runs.map((e) => {
        const data = (e.data ?? {}) as Record<string, unknown>;
        return {
          id: e.id,
          agentUserId: e.agentUserId,
          agentType: e.agentType,
          model: e.model,
          provider: e.provider,
          costUsd: e.costUsd,
          tokensIn: e.tokensIn,
          tokensOut: e.tokensOut,
          tokensTotal: e.tokensTotal,
          latencyMs: e.latencyMs,
          toolCount: e.toolCount,
          runStatus: e.runStatus,
          finishReason: e.finishReason,
          summary: typeof data.summary === "string" ? data.summary : undefined,
          workspaceId:
            typeof data.workspaceId === "string" ? data.workspaceId : undefined,
          sessionId:
            typeof data.sessionId === "string" ? data.sessionId : undefined,
          correlationId: e.correlationId,
          createdAt: e.timestamp,
        };
      });
      return c.json({ agentRuns });
    } catch (err) {
      logger.error({ err, userId }, "listAgentRuns failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /events/broadcast
   * Emit an arbitrary socket event to the user's presence room.
   * Used by IS tools (e.g. web_search) to signal session activity to
   * ambient subscribers (e.g. whiteboard session stream).
   */
  app.post("/events/broadcast", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.event !== "string") {
      return c.json({ error: "event (string) is required" }, 400);
    }
    // SECURITY — the presence room to emit into MUST be derived from the
    // verified auth context, never a body-supplied userId/workspaceId. Trusting
    // the body let any hub-protocol.write holder inject arbitrary socket events
    // into another user's presence room (same IDOR class as POST /profiles).
    const acting = await resolveActingContext(c, {
      userId: body.userId as string | undefined,
      ...(body.workspaceId ? { workspaceId: body.workspaceId as string } : {}),
    });
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    const { event, data } = body as {
      event: string;
      data?: Record<string, unknown>;
    };
    emitChatEvent({
      event,
      data: data ?? {},
      userId: acting.userId,
      workspaceId: acting.workspaceId ?? undefined,
    });
    return c.json({ ok: true });
  });
}
