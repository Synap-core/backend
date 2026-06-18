/**
 * Hub Protocol REST — focus sessions
 *
 * IS-facing REST surface for goal-bound user work sessions.
 * All routes require hub-protocol.write (or .read) scope.
 *
 * Routes (static before dynamic — Hono is first-match):
 *   GET    /focus-sessions          — list sessions for a workspace
 *   GET    /focus-sessions/:id      — get a single session by id
 *   POST   /focus-sessions          — create/upsert a session (by correlationId)
 *   PATCH  /focus-sessions/:id      — update progress / status / correlationId
 *
 * Uses Drizzle directly — focusSessions lives on coreRouter, not hubProtocolRouter,
 * so getCaller() (which creates a hubProtocolRouter caller) cannot reach it.
 */

import { z } from "@hono/zod-openapi";
import {
  db,
  eq,
  and,
  desc,
  focusSessions,
  playbookRuns,
} from "@synap/database";
import { checkPermissionOrPropose } from "../../../utils/permission-check.js";
import { createLinks } from "../../../services/links/links-service.js";
import { emitHubRealtimeEvent } from "../../../utils/domain-event-bridge.js";
import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  hasScope,
  logger,
  resolveActingContext,
  type HubHono,
} from "./_shared.js";

// ── Wire schemas ───────────────────────────────────────────────────────────

const ExpectedOutputItemSchema = z.object({
  kind: z.string(),
  label: z.string(),
  icon: z.string().optional(),
});

const FocusSessionWireSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  userId: z.string(),
  correlationId: z.string().nullable(),
  goal: z.string(),
  status: z.string(),
  templateId: z.string().nullable(),
  expectedOutputs: z.unknown(),
  channelId: z.string().nullable(),
  progress: z.number().nullable(),
  agentIds: z.array(z.string()),
  closedAt: z.string().nullable(),
  contextReport: z.unknown().nullable(),
  planReport: z.unknown().nullable(),
  executionLog: z.unknown().nullable(),
  verificationReport: z.unknown().nullable(),
  startedAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const CreateBodySchema = z.object({
  workspaceId: z.string().min(1),
  userId: z.string().min(1),
  goal: z.string().min(1).max(2000),
  correlationId: z.string().optional(),
  templateId: z.string().optional(),
  expectedOutputs: z.array(ExpectedOutputItemSchema).optional(),
  channelId: z.string().uuid().optional(),
  agentIds: z.array(z.string()).optional(),
});

// workspaceId is accepted for back-compat with CLI callers that still send it,
// but the authoritative workspace comes from the LOADED ROW (write-gate rule:
// never trust a caller-supplied workspaceId for scoping a mutation).
const UpdateBodySchema = z.object({
  workspaceId: z.string().min(1).optional(),
  status: z.enum(["active", "paused", "closed"]).optional(),
  progress: z.number().int().min(0).max(100).optional(),
  channelId: z.string().uuid().optional(),
  correlationId: z.string().optional(),
  goal: z.string().min(1).max(2000).optional(),
  agentIds: z.array(z.string()).optional(),
  expectedOutputs: z.array(ExpectedOutputItemSchema).optional(),
  contextReport: z.unknown().optional(),
  planReport: z.unknown().optional(),
  executionLog: z.unknown().optional(),
  verificationReport: z.unknown().optional(),
  agentUserId: z.string().uuid().optional(),
  reasoning: z.string().optional(),
});

const UsedCapabilityBodySchema = z.object({
  capabilityKind: z.enum(["tool", "skill", "command"]),
  capabilityId: z.string().min(1),
});

// ── Registration ───────────────────────────────────────────────────────────

export function registerFocusSessionsRoutes(app: HubHono): void {
  // ── OpenAPI metadata ─────────────────────────────────────────────────────

  registerOpenApi(app, {
    method: "get",
    path: "/focus-sessions",
    tags: ["FocusSessions"],
    summary: "List focus sessions for a workspace",
    request: {
      query: z.object({
        workspaceId: z.string(),
        status: z.enum(["active", "paused", "closed", "all"]).optional(),
        limit: z.coerce.number().int().min(1).max(50).optional(),
      }),
    },
    responses: {
      200: { description: "Sessions", schema: z.array(FocusSessionWireSchema) },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "get",
    path: "/focus-sessions/:id",
    tags: ["FocusSessions"],
    summary: "Get a focus session by ID",
    request: {
      params: z.object({ id: z.string().uuid() }),
      query: z.object({ workspaceId: z.string() }),
    },
    responses: {
      200: { description: "Session", schema: FocusSessionWireSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/focus-sessions",
    tags: ["FocusSessions"],
    summary: "Create a focus session",
    description:
      "IS creates a focus session, optionally with a correlationId for idempotency. " +
      "If a session with the same correlationId already exists it is returned as-is.",
    request: { body: CreateBodySchema },
    responses: {
      200: {
        description: "Created or existing session",
        schema: FocusSessionWireSchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "patch",
    path: "/focus-sessions/:id",
    tags: ["FocusSessions"],
    summary: "Update a focus session",
    request: {
      params: z.object({ id: z.string().uuid() }),
      body: UpdateBodySchema,
    },
    responses: {
      200: { description: "Updated session", schema: FocusSessionWireSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  // ── Handlers ─────────────────────────────────────────────────────────────
  // Static route (/focus-sessions) BEFORE dynamic (/focus-sessions/:id) —
  // Hono is first-match.

  /**
   * GET /focus-sessions?workspaceId=...&status=...&limit=...
   */
  app.get("/focus-sessions", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }

    const workspaceIdParam = c.req.query("workspaceId");
    if (!workspaceIdParam) {
      return c.json({ error: "workspaceId is required" }, 400);
    }
    // Validate the caller is a member of the requested workspace and bind the
    // acting user. Without this the read scoped by a caller-supplied workspaceId
    // ALONE with no userId floor — exposing every member's private sessions in
    // any workspace id an agent key chose to pass (cross-user + cross-workspace).
    const acting = await resolveActingContext(c, {
      workspaceId: workspaceIdParam,
    });
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);

    const statusRaw = c.req.query("status") ?? "all";
    const limitRaw = parseInt(c.req.query("limit") ?? "20", 10);
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(limitRaw, 1), 50)
      : 20;
    const validStatuses = ["active", "paused", "closed", "all"] as const;
    const status = validStatuses.includes(
      statusRaw as (typeof validStatuses)[number]
    )
      ? (statusRaw as (typeof validStatuses)[number])
      : "all";

    try {
      const conditions = [
        eq(focusSessions.workspaceId, acting.workspaceId),
        eq(focusSessions.userId, acting.userId),
      ];
      if (status !== "all") {
        conditions.push(eq(focusSessions.status, status));
      }

      const rows = await db
        .select()
        .from(focusSessions)
        .where(and(...conditions))
        .orderBy(desc(focusSessions.startedAt))
        .limit(limit);

      return c.json(rows);
    } catch (err) {
      logger.error({ err }, "focus-sessions.list failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * GET /focus-sessions/:id?workspaceId=...
   * workspaceId is required to prevent cross-workspace reads.
   */
  app.get("/focus-sessions/:id", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }

    const id = c.req.param("id");
    const workspaceIdParam = c.req.query("workspaceId");
    if (!workspaceIdParam) {
      return c.json({ error: "workspaceId query param is required" }, 400);
    }
    // Membership-validate the workspace + bind the acting user (userId floor) —
    // see the list route above; without it any agent key could read any user's
    // session in any workspace.
    const acting = await resolveActingContext(c, {
      workspaceId: workspaceIdParam,
    });
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);

    try {
      const row = await db.query.focusSessions.findFirst({
        where: and(
          eq(focusSessions.id, id),
          eq(focusSessions.workspaceId, acting.workspaceId),
          eq(focusSessions.userId, acting.userId)
        ),
      });

      if (!row) {
        return c.json({ error: `Focus session ${id} not found` }, 404);
      }

      return c.json(row);
    } catch (err) {
      logger.error({ err, id }, "focus-sessions.get failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /focus-sessions
   * IS creates a session, optionally with correlationId for idempotency.
   * Goes through checkPermissionOrPropose so the governance membrane is honored.
   */
  app.post("/focus-sessions", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }

    const raw = await c.req.json().catch(() => null);
    if (!raw) return c.json({ error: "Invalid JSON in request body" }, 400);

    const parsed = CreateBodySchema.safeParse(raw);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) =>
          i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message
        )
        .join(", ");
      return c.json({ error: message }, 400);
    }

    const body = parsed.data;

    // Bind the acting identity to the authenticated principal and verify
    // workspace membership — mirrors artifacts.ts POST pattern.
    const acting = await resolveActingContext(c, {
      userId: body.userId,
      workspaceId: body.workspaceId,
    });
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    const { userId, workspaceId } = acting;

    try {
      // Idempotency: if a correlationId was given, return the existing session.
      // Floor by the acting user + bound workspace so a guessed/colliding
      // correlationId can't return another user's session (defense-in-depth).
      if (body.correlationId) {
        const existing = await db.query.focusSessions.findFirst({
          where: and(
            eq(focusSessions.correlationId, body.correlationId),
            eq(focusSessions.userId, userId),
            eq(focusSessions.workspaceId, workspaceId)
          ),
        });
        if (existing) return c.json(existing);
      }

      // Governance membrane — focus_session.create goes through checkPermissionOrPropose.
      const ctxAgentUserId = c.get("agentUserId") as string | undefined;

      const perm = await checkPermissionOrPropose({
        userId,
        agentUserId: ctxAgentUserId,
        workspaceId,
        subjectType: "focus_session",
        action: "create",
        source: "intelligence",
        data: {
          goal: body.goal,
          templateId: body.templateId,
        },
      });

      if ("denied" in perm && perm.denied) {
        return c.json({ error: perm.reason }, 403);
      }
      if ("proposalId" in perm) {
        return c.json({
          status: "proposed",
          message: "Focus session creation proposed for review",
          proposalId: perm.proposalId,
          summary: perm.summary,
          reasoning: perm.reasoning,
          reviewPath: perm.reviewPath,
          reviewUrl: perm.reviewUrl,
          session: null,
        });
      }

      const [created] = await db
        .insert(focusSessions)
        .values({
          workspaceId,
          userId,
          goal: body.goal,
          correlationId: body.correlationId ?? null,
          templateId: body.templateId ?? null,
          expectedOutputs: body.expectedOutputs ?? [],
          channelId: body.channelId ?? null,
          agentIds: body.agentIds ?? [],
          status: "active",
        })
        .returning();

      emitHubRealtimeEvent({
        eventType: "focus_session.create.completed",
        subjectId: created.id,
        userId,
        data: {
          id: created.id,
          workspaceId: created.workspaceId,
          status: created.status,
          goal: created.goal,
          progress: created.progress,
        },
      });

      return c.json(created);
    } catch (err) {
      logger.error({ err }, "focus-sessions.create failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * PATCH /focus-sessions/:id
   * IS updates progress / status / correlationId.
   *
   * Write-gate pattern (mirrors artifacts.ts PATCH):
   *   1. Load the row by id alone (never trust a caller-supplied workspaceId for scoping).
   *   2. Verify the caller's membership in the LOADED ROW's workspace via resolveActingContext.
   *   3. Gate through checkPermissionOrPropose — the membrane decides approve vs propose.
   *   4. Execute the raw DB update only after gate approval.
   */
  app.patch("/focus-sessions/:id", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }

    const id = c.req.param("id");
    const raw = await c.req.json().catch(() => null);
    if (!raw) return c.json({ error: "Invalid JSON in request body" }, 400);

    const parsed = UpdateBodySchema.safeParse(raw);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) =>
          i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message
        )
        .join(", ");
      return c.json({ error: message }, 400);
    }

    // workspaceId from the body is accepted for back-compat but NOT used for scoping.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { workspaceId: _ignored, ...patch } = parsed.data;

    try {
      // Step 1: load by id alone — workspaceId comes from the ROW, not the body.
      const existing = await db.query.focusSessions.findFirst({
        where: eq(focusSessions.id, id),
      });

      if (!existing) {
        return c.json({ error: `Focus session ${id} not found` }, 404);
      }

      // Step 2: verify the caller's membership in the row's workspace.
      const acting = await resolveActingContext(c, {
        workspaceId: existing.workspaceId,
      });
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);
      const { userId, workspaceId } = acting;

      // Step 3: governance membrane.
      const ctxAgentUserId = c.get("agentUserId") as string | undefined;
      const agentUserId = patch.agentUserId ?? ctxAgentUserId;

      const perm = await checkPermissionOrPropose({
        userId,
        agentUserId,
        workspaceId,
        subjectType: "focus_session",
        action: "update",
        source: "intelligence",
        reasoning: patch.reasoning,
        data: {
          id,
          status: patch.status,
          progress: patch.progress,
        },
      });

      if ("denied" in perm && perm.denied) {
        return c.json({ error: perm.reason }, 403);
      }
      if ("proposalId" in perm) {
        return c.json({
          status: "proposed",
          message: "Focus session update proposed for review",
          proposalId: perm.proposalId,
          summary: perm.summary,
          reasoning: perm.reasoning,
          reviewPath: perm.reviewPath,
          reviewUrl: perm.reviewUrl,
          session: null,
        });
      }

      // Step 4: execute the update.
      const set: Partial<typeof focusSessions.$inferInsert> = {
        updatedAt: new Date(),
      };

      if (patch.status !== undefined) set.status = patch.status;
      if (patch.progress !== undefined) set.progress = patch.progress;
      if (patch.channelId !== undefined) set.channelId = patch.channelId;
      if (patch.correlationId !== undefined)
        set.correlationId = patch.correlationId;
      if (patch.goal !== undefined) set.goal = patch.goal;
      if (patch.agentIds !== undefined) set.agentIds = patch.agentIds;
      if (patch.expectedOutputs !== undefined)
        set.expectedOutputs = patch.expectedOutputs;
      if (patch.contextReport !== undefined)
        set.contextReport = patch.contextReport;
      if (patch.planReport !== undefined) set.planReport = patch.planReport;
      if (patch.executionLog !== undefined)
        set.executionLog = patch.executionLog;
      if (patch.verificationReport !== undefined)
        set.verificationReport = patch.verificationReport;

      if (patch.status === "closed" && existing.status !== "closed") {
        set.closedAt = new Date();
      }

      const [updated] = await db
        .update(focusSessions)
        .set(set)
        .where(eq(focusSessions.id, id))
        .returning();

      emitHubRealtimeEvent({
        eventType: "focus_session.update.completed",
        subjectId: updated.id,
        userId,
        data: {
          id: updated.id,
          workspaceId: updated.workspaceId,
          status: updated.status,
          goal: updated.goal,
          progress: updated.progress,
        },
      });

      return c.json(updated);
    } catch (err) {
      logger.error({ err, id }, "focus-sessions.update failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /focus-sessions/:id/used — record a capability invocation as
   * `session --used--> {tool|skill|command}`. This is PROVENANCE, written at the
   * moment the agent USES a capability (the IS tool-wrapper fires it), so it is
   * auto (not governance-gated) — it asserts what happened, it doesn't mutate
   * user data. Idempotent via the links unique edge. Powers the session room's
   * "Tools & skills" Frame and promoteSessionToPlaybook's capability re-grant.
   */
  app.post("/focus-sessions/:id/used", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const id = c.req.param("id");
    const raw = await c.req.json().catch(() => null);
    const parsed = UsedCapabilityBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid request body", details: parsed.error.flatten() },
        400
      );
    }
    const { capabilityKind, capabilityId } = parsed.data;
    try {
      // Load by id, bind to the row's workspace (membership check).
      const session = await db.query.focusSessions.findFirst({
        where: eq(focusSessions.id, id),
      });
      if (!session)
        return c.json({ error: `Focus session ${id} not found` }, 404);
      const acting = await resolveActingContext(c, {
        workspaceId: session.workspaceId ?? undefined,
      });
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);

      await createLinks([
        {
          workspaceId: session.workspaceId,
          fromType: "session",
          fromId: session.id,
          toType: capabilityKind,
          toId: capabilityId,
          linkType: "used",
          metadata: { usedAt: new Date().toISOString() },
        },
      ]);
      return c.json({ status: "recorded" as const });
    } catch (err) {
      logger.error({ err, id }, "focus-sessions.used failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /focus-sessions/:sessionId/complete-run
   *
   * Fire-and-forget provenance: when an IS agent finishes working on a
   * session-scoped channel, it calls this to close any running playbook_run
   * for that session. Best-effort — if there's no running run, that's fine.
   */
  app.post("/focus-sessions/:sessionId/complete-run", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }

    const sessionId = c.req.param("sessionId");

    try {
      // Load the session to resolve the acting context (membership check).
      const session = await db.query.focusSessions.findFirst({
        where: eq(focusSessions.id, sessionId),
      });
      if (!session) {
        return c.json({ error: `Focus session ${sessionId} not found` }, 404);
      }

      const acting = await resolveActingContext(c, {
        workspaceId: session.workspaceId,
      });
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);

      // Find the running playbook_run for this session.
      const [run] = await db
        .select()
        .from(playbookRuns)
        .where(
          and(
            eq(playbookRuns.sessionId, sessionId),
            eq(playbookRuns.status, "running")
          )
        )
        .limit(1);

      if (!run) {
        return c.json({ status: "no-running-run" as const });
      }

      // Mark as completed.
      await db
        .update(playbookRuns)
        .set({ status: "completed", completedAt: new Date() })
        .where(eq(playbookRuns.id, run.id));

      return c.json({ status: "completed" as const });
    } catch (err) {
      logger.error({ err, sessionId }, "focus-sessions.complete-run failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
