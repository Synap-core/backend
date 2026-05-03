/**
 * Hub Protocol REST — sessions + compacted states (session-scoped memory)
 */

import { TRPCError } from "@trpc/server";
import { z } from "@hono/zod-openapi";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  ActiveSessionQuerySchema,
  CloseSessionRequestSchema,
  CreateCompactedStateRequestSchema,
  GetOrCreateSessionRequestSchema,
  ListCompactedStatesQuerySchema,
  ListSessionsQuerySchema,
  UpdateSessionRequestSchema,
  WireCompactedStateSchema,
  WireSessionSchema,
} from "./_codecs/session.js";
import { getCaller, hasScope, logger, type HubHono } from "./_shared.js";

export function registerSessionsRoutes(app: HubHono): void {
  // ── OpenAPI metadata ─────────────────────────────────────────────────────
  registerOpenApi(app, {
    method: "post",
    path: "/sessions/getOrCreate",
    tags: ["Sessions"],
    summary: "Get or create a session for a channel",
    description:
      "Returns the active session for the channel or creates one. Sessions are scoped to a chat/channel; supports a `bootstrapStateId` to start from a compacted state.",
    request: {
      body: GetOrCreateSessionRequestSchema,
    },
    responses: {
      200: { description: "Session", schema: WireSessionSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "get",
    path: "/sessions/active",
    tags: ["Sessions"],
    summary: "Get the active session for a channel",
    request: {
      query: ActiveSessionQuerySchema,
    },
    responses: {
      200: {
        description: "Active session, or null if none is open",
        schema: WireSessionSchema.nullable(),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "get",
    path: "/sessions/{sessionId}",
    tags: ["Sessions"],
    summary: "Get a session by id",
    request: {
      params: z.object({ sessionId: z.string() }),
    },
    responses: {
      200: { description: "Session", schema: WireSessionSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Session not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "get",
    path: "/sessions",
    tags: ["Sessions"],
    summary: "List sessions for a channel",
    request: {
      query: ListSessionsQuerySchema,
    },
    responses: {
      200: {
        description: "Sessions",
        schema: z.array(WireSessionSchema),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "patch",
    path: "/sessions/{sessionId}",
    tags: ["Sessions"],
    summary: "Update a session",
    request: {
      params: z.object({ sessionId: z.string() }),
      body: UpdateSessionRequestSchema,
    },
    responses: {
      200: { description: "Updated session", schema: WireSessionSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Session not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/sessions/{sessionId}/close",
    tags: ["Sessions"],
    summary: "Close a session",
    description:
      "Closes a session and optionally records the produced compacted-state id.",
    request: {
      params: z.object({ sessionId: z.string() }),
      body: CloseSessionRequestSchema,
    },
    responses: {
      200: { description: "Closed session", schema: WireSessionSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Session not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/compacted-states",
    tags: ["Sessions"],
    summary: "Create a compacted state",
    description:
      "Persists a summarized state snapshot for a channel. Used to bootstrap subsequent sessions cheaply.",
    request: {
      body: CreateCompactedStateRequestSchema,
    },
    responses: {
      200: {
        description: "Created compacted state",
        schema: WireCompactedStateSchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "get",
    path: "/compacted-states/latest",
    tags: ["Sessions"],
    summary: "Get the latest compacted state for a channel",
    request: {
      query: ActiveSessionQuerySchema,
    },
    responses: {
      200: {
        description: "Latest compacted state, or null",
        schema: WireCompactedStateSchema.nullable(),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "get",
    path: "/compacted-states/{stateId}",
    tags: ["Sessions"],
    summary: "Get a compacted state by id",
    request: {
      params: z.object({ stateId: z.string() }),
    },
    responses: {
      200: { description: "Compacted state", schema: WireCompactedStateSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "State not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "get",
    path: "/compacted-states",
    tags: ["Sessions"],
    summary: "List compacted states for a channel",
    request: {
      query: ListCompactedStatesQuerySchema,
    },
    responses: {
      200: {
        description: "Compacted states (newest first)",
        schema: z.array(WireCompactedStateSchema),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  // ============================================================================
  // Sessions
  // ============================================================================

  /**
   * POST /sessions/getOrCreate
   * Body: { channelId, bootstrapStateId? }
   */
  app.post("/sessions/getOrCreate", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const body = (await c.req.json().catch(() => null)) as {
      channelId?: string;
      bootstrapStateId?: string;
    } | null;
    if (!body) return c.json({ error: "Invalid JSON in request body" }, 400);
    if (!body.channelId) {
      return c.json({ error: "channelId is required" }, 400);
    }
    try {
      const caller = await getCaller(c);
      const result = await caller.sessions.getOrCreate({
        channelId: body.channelId,
        bootstrapStateId: body.bootstrapStateId,
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "sessions.getOrCreate failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * GET /sessions/active?channelId=...
   */
  app.get("/sessions/active", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const channelId = c.req.query("channelId");
    if (!channelId) {
      return c.json({ error: "channelId is required" }, 400);
    }
    try {
      const caller = await getCaller(c);
      const result = await caller.sessions.getActive({ channelId });
      return c.json(result ?? null);
    } catch (err) {
      logger.error({ err }, "sessions.getActive failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * GET /sessions/:sessionId
   */
  app.get("/sessions/:sessionId", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const sessionId = c.req.param("sessionId");
    try {
      const caller = await getCaller(c);
      const result = await caller.sessions.get({ sessionId });
      return c.json(result);
    } catch (err) {
      logger.error({ err, sessionId }, "sessions.get failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        err instanceof TRPCError && err.code === "NOT_FOUND" ? 404 : 500
      );
    }
  });

  /**
   * GET /sessions?channelId=...&limit=...
   */
  app.get("/sessions", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const channelId = c.req.query("channelId");
    const limit = parseInt(c.req.query("limit") ?? "10", 10);
    if (!channelId) {
      return c.json({ error: "channelId is required" }, 400);
    }
    try {
      const caller = await getCaller(c);
      const result = await caller.sessions.list({ channelId, limit });
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "sessions.list failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * PATCH /sessions/:sessionId
   */
  app.patch("/sessions/:sessionId", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const sessionId = c.req.param("sessionId");
    const body = (await c.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body) return c.json({ error: "Invalid JSON in request body" }, 400);
    try {
      const caller = await getCaller(c);
      const result = await caller.sessions.update({
        sessionId,
        ...body,
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err, sessionId }, "sessions.update failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        err instanceof TRPCError && err.code === "NOT_FOUND" ? 404 : 500
      );
    }
  });

  /**
   * POST /sessions/:sessionId/close
   * Body: { producedStateId? }
   */
  app.post("/sessions/:sessionId/close", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const sessionId = c.req.param("sessionId");
    const body = (await c.req.json().catch(() => null)) as {
      producedStateId?: string;
    } | null;
    if (!body) return c.json({ error: "Invalid JSON in request body" }, 400);
    try {
      const caller = await getCaller(c);
      const result = await caller.sessions.close({
        sessionId,
        producedStateId: body.producedStateId,
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err, sessionId }, "sessions.close failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        err instanceof TRPCError && err.code === "NOT_FOUND" ? 404 : 500
      );
    }
  });

  // ============================================================================
  // Compacted States
  // ============================================================================

  /**
   * POST /compacted-states
   */
  app.post("/compacted-states", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const body = (await c.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body) return c.json({ error: "Invalid JSON in request body" }, 400);
    if (!body.channelId) {
      return c.json({ error: "channelId is required" }, 400);
    }
    try {
      const caller = await getCaller(c);
      const result = await caller.compactedStates.create(
        body as Parameters<typeof caller.compactedStates.create>[0]
      );
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "compactedStates.create failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * GET /compacted-states/latest?channelId=...
   */
  app.get("/compacted-states/latest", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const channelId = c.req.query("channelId");
    if (!channelId) {
      return c.json({ error: "channelId is required" }, 400);
    }
    try {
      const caller = await getCaller(c);
      const result = await caller.compactedStates.getLatest({
        channelId,
      });
      return c.json(result ?? null);
    } catch (err) {
      logger.error({ err }, "compactedStates.getLatest failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * GET /compacted-states/:stateId
   */
  app.get("/compacted-states/:stateId", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const stateId = c.req.param("stateId");
    try {
      const caller = await getCaller(c);
      const result = await caller.compactedStates.get({ stateId });
      return c.json(result);
    } catch (err) {
      logger.error({ err, stateId }, "compactedStates.get failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        err instanceof TRPCError && err.code === "NOT_FOUND" ? 404 : 500
      );
    }
  });

  /**
   * GET /compacted-states?channelId=...&limit=...
   */
  app.get("/compacted-states", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const channelId = c.req.query("channelId");
    const limit = parseInt(c.req.query("limit") ?? "5", 10);
    if (!channelId) {
      return c.json({ error: "channelId is required" }, 400);
    }
    try {
      const caller = await getCaller(c);
      const result = await caller.compactedStates.list({
        channelId,
        limit,
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "compactedStates.list failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
