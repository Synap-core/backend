/**
 * Hub Protocol REST — background tasks CRUD
 *
 * Per-user CRUD for `background_tasks`. Permission scoping is enforced
 * SERVER-SIDE: every read/write filters on the bearer key's `userId` so a
 * Hub key cannot see or mutate tasks owned by another user, even if it
 * forges an id in the URL.
 *
 * Action validation is delegated to `services/background-task-actions.ts`
 * — same registry the tRPC router uses, so the two surfaces cannot drift.
 */

import type { Context } from "hono";
import { z as zOpenapi } from "@hono/zod-openapi";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  hasScope,
  logger,
  type HubHono,
  type HubVariables,
} from "./_shared.js";
import {
  BackgroundTaskPermissionError,
  InvalidActionError,
  createBackgroundTask,
  deleteBackgroundTask,
  getBackgroundTask,
  listBackgroundTasks,
  updateBackgroundTask,
} from "../../../services/background-tasks-service.js";
import { listActions } from "../../../services/background-task-actions.js";

// ── Wire schemas ───────────────────────────────────────────────────────────
//
// These mirror the tRPC input shapes one-for-one. `action` is left as a
// plain string at the schema level — the registry check happens inside
// the service layer so the same registry powers both surfaces.

const ListQuerySchema = zOpenapi.object({
  workspaceId: zOpenapi.string().uuid().optional(),
  status: zOpenapi.enum(["active", "paused", "error", "all"]).optional(),
  type: zOpenapi.enum(["cron", "event", "interval"]).optional(),
  limit: zOpenapi.coerce.number().min(1).max(100).optional(),
  offset: zOpenapi.coerce.number().min(0).optional(),
});

const CreateBodySchema = zOpenapi.object({
  workspaceId: zOpenapi.string().uuid().optional(),
  name: zOpenapi.string().min(1).max(255),
  description: zOpenapi.string().optional(),
  type: zOpenapi.enum(["cron", "event", "interval"]),
  schedule: zOpenapi.string().optional(),
  action: zOpenapi.string().min(1),
  context: zOpenapi.record(zOpenapi.string(), zOpenapi.unknown()).optional(),
});

const UpdateBodySchema = zOpenapi.object({
  name: zOpenapi.string().min(1).max(255).optional(),
  description: zOpenapi.string().optional(),
  schedule: zOpenapi.string().optional(),
  action: zOpenapi.string().min(1).optional(),
  context: zOpenapi.record(zOpenapi.string(), zOpenapi.unknown()).optional(),
  status: zOpenapi.enum(["active", "paused", "error"]).optional(),
  /** ISO datetime string. */
  nextRunAt: zOpenapi.string().datetime().optional(),
});

const TaskWireSchema = zOpenapi.object({
  id: zOpenapi.string(),
  userId: zOpenapi.string(),
  workspaceId: zOpenapi.string().nullable(),
  name: zOpenapi.string(),
  description: zOpenapi.string().nullable(),
  type: zOpenapi.string(),
  schedule: zOpenapi.string().nullable(),
  action: zOpenapi.string(),
  context: zOpenapi.record(zOpenapi.string(), zOpenapi.unknown()),
  status: zOpenapi.string(),
  errorMessage: zOpenapi.string().nullable(),
  lastRunAt: zOpenapi.string().nullable(),
  nextRunAt: zOpenapi.string().nullable(),
  executionCount: zOpenapi.number(),
  successCount: zOpenapi.number(),
  failureCount: zOpenapi.number(),
  metadata: zOpenapi.record(zOpenapi.string(), zOpenapi.unknown()),
  createdAt: zOpenapi.string(),
  updatedAt: zOpenapi.string(),
});

/** Hono context shape for handlers in this file (carries HubVariables). */
type HubContext = Context<{ Variables: HubVariables }>;

/**
 * Map service-layer errors to the right HTTP shape. Returns the Hono Response
 * directly (the caller `return`s it). Centralised so every endpoint reports
 * action-validation / permission outcomes the same way.
 */
function errorResponse(c: HubContext, err: unknown): Response {
  if (err instanceof InvalidActionError) {
    return c.json(
      {
        error: err.message,
        validActions: err.validActions,
      },
      400
    );
  }
  if (err instanceof BackgroundTaskPermissionError) {
    if (err.kind === "denied") {
      return c.json({ error: err.message }, 403);
    }
    // proposed — return 202 + proposalId so the client knows a proposal was
    // created and the action did NOT execute.
    return c.json(
      {
        status: "proposed",
        proposalId: err.proposalId,
      },
      202
    );
  }
  if (err instanceof Error && err.name === "BackgroundTaskNotFoundError") {
    return c.json({ error: err.message }, 404);
  }
  logger.error({ err }, "Background task service error");
  return c.json(
    { error: err instanceof Error ? err.message : "Unknown error" },
    500
  );
}

export function registerBackgroundTasksRoutes(app: HubHono): void {
  // ── OpenAPI metadata ─────────────────────────────────────────────────────
  registerOpenApi(app, {
    method: "get",
    path: "/background-tasks",
    tags: ["BackgroundTasks"],
    summary: "List background tasks owned by the calling user",
    request: { query: ListQuerySchema },
    responses: {
      200: {
        description: "Tasks owned by the caller",
        schema: zOpenapi.object({ tasks: zOpenapi.array(TaskWireSchema) }),
      },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/background-tasks",
    tags: ["BackgroundTasks"],
    summary: "Create a background task",
    description:
      "Creates a task owned by the calling user. The `action` field MUST " +
      "match a registered id from the action vocabulary (`custom` is the " +
      "free-form escape hatch). Unknown ids return 400 with the full registry.",
    request: { body: CreateBodySchema },
    responses: {
      200: {
        description: "Task created",
        schema: zOpenapi.object({
          id: zOpenapi.string(),
          status: zOpenapi.literal("created"),
        }),
      },
      202: {
        description: "Proposal created — caller must approve before execution",
        schema: zOpenapi.object({
          status: zOpenapi.literal("proposed"),
          proposalId: zOpenapi.string(),
        }),
      },
      400: {
        description: "Invalid action id",
        schema: zOpenapi.object({
          error: zOpenapi.string(),
          validActions: zOpenapi
            .array(
              zOpenapi.object({
                id: zOpenapi.string(),
                description: zOpenapi.string(),
              })
            )
            .optional(),
        }),
      },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "get",
    path: "/background-tasks/{id}",
    tags: ["BackgroundTasks"],
    summary: "Fetch one background task",
    request: { params: zOpenapi.object({ id: zOpenapi.string().uuid() }) },
    responses: {
      200: {
        description: "Task",
        schema: zOpenapi.object({ task: TaskWireSchema }),
      },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: {
        description: "Not found (or not owned by caller)",
        schema: ErrorSchema,
      },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "patch",
    path: "/background-tasks/{id}",
    tags: ["BackgroundTasks"],
    summary: "Update a background task",
    request: {
      params: zOpenapi.object({ id: zOpenapi.string().uuid() }),
      body: UpdateBodySchema,
    },
    responses: {
      200: {
        description: "Task updated",
        schema: zOpenapi.object({ status: zOpenapi.literal("updated") }),
      },
      202: {
        description: "Proposal created",
        schema: zOpenapi.object({
          status: zOpenapi.literal("proposed"),
          proposalId: zOpenapi.string(),
        }),
      },
      400: { description: "Invalid action id", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "delete",
    path: "/background-tasks/{id}",
    tags: ["BackgroundTasks"],
    summary: "Delete a background task",
    request: { params: zOpenapi.object({ id: zOpenapi.string().uuid() }) },
    responses: {
      200: {
        description: "Task deleted",
        schema: zOpenapi.object({ status: zOpenapi.literal("deleted") }),
      },
      202: {
        description: "Proposal created",
        schema: zOpenapi.object({
          status: zOpenapi.literal("proposed"),
          proposalId: zOpenapi.string(),
        }),
      },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  // ── Handlers ──────────────────────────────────────────────────────────────
  //
  // IMPORTANT: register specific routes BEFORE `/:id` to avoid Hono's
  // first-match dispatcher routing `/background-tasks/actions` (a future
  // listing endpoint) into the `:id` handler. Currently we have no such
  // collision, but the convention is enforced for safety.

  /**
   * GET /background-tasks — list tasks for the calling user.
   */
  app.get("/background-tasks", async (c) => {
    const scopes = c.get("scopes") as string[];
    if (!hasScope(scopes, "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const userId = c.get("userId") as string;
    const query = ListQuerySchema.safeParse({
      workspaceId: c.req.query("workspaceId"),
      status: c.req.query("status"),
      type: c.req.query("type"),
      limit: c.req.query("limit"),
      offset: c.req.query("offset"),
    });
    if (!query.success) {
      return c.json(
        { error: "Invalid query parameters", details: query.error.issues },
        400
      );
    }

    try {
      const result = await listBackgroundTasks({
        userId,
        ...query.data,
      });
      return c.json(result);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  /**
   * POST /background-tasks — create a task owned by the calling user.
   */
  app.post("/background-tasks", async (c) => {
    const scopes = c.get("scopes") as string[];
    if (!hasScope(scopes, "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const userId = c.get("userId") as string;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = CreateBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid request body", details: parsed.error.issues },
        400
      );
    }

    try {
      const { id } = await createBackgroundTask({
        userId,
        ...parsed.data,
      });
      return c.json({ id, status: "created" as const }, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  /**
   * GET /background-tasks/:id — fetch one task. 404 when the row exists
   * but belongs to another user (don't leak existence across boundaries).
   */
  app.get("/background-tasks/:id", async (c) => {
    const scopes = c.get("scopes") as string[];
    if (!hasScope(scopes, "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const userId = c.get("userId") as string;
    const id = c.req.param("id");
    const task = await getBackgroundTask({ id, userId });
    if (!task) {
      return c.json({ error: "Background task not found" }, 404);
    }
    return c.json({ task });
  });

  /**
   * PATCH /background-tasks/:id — update fields on a task. Includes
   * `nextRunAt` (write-only re-schedule path) which is NOT exposed by
   * tRPC create.
   */
  app.patch("/background-tasks/:id", async (c) => {
    const scopes = c.get("scopes") as string[];
    if (!hasScope(scopes, "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const userId = c.get("userId") as string;
    const id = c.req.param("id");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = UpdateBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid request body", details: parsed.error.issues },
        400
      );
    }

    try {
      await updateBackgroundTask({
        id,
        userId,
        ...parsed.data,
      });
      return c.json({ status: "updated" as const }, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  /**
   * DELETE /background-tasks/:id — delete a task owned by the caller.
   */
  app.delete("/background-tasks/:id", async (c) => {
    const scopes = c.get("scopes") as string[];
    if (!hasScope(scopes, "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const userId = c.get("userId") as string;
    const id = c.req.param("id");

    try {
      await deleteBackgroundTask({ id, userId });
      return c.json({ status: "deleted" as const }, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // Currently unused — referenced for forward-compatibility so callers can
  // discover the registry programmatically. Kept here so a future
  // `/background-tasks/actions` listing endpoint has its handler co-located.
  void listActions;
}
