/**
 * Hub Protocol REST — artifacts
 *
 * IS/agent-facing REST surface for the artifact ledger.
 * All routes require hub-protocol.write (or .read) scope.
 *
 * Routes (static before dynamic — Hono is first-match):
 *   GET    /artifacts          — list artifacts for a workspace
 *   POST   /artifacts          — create an artifact (agent writes get originKind='agent')
 *   PATCH  /artifacts/:id      — update state / placement
 *
 * Uses Drizzle directly — artifacts lives on coreRouter, not hubProtocolRouter,
 * so getCaller() (which creates a hubProtocolRouter caller) cannot reach it.
 */

import { z } from "@hono/zod-openapi";
import { db, eq, and, desc, artifacts } from "@synap/database";
import { emitHubRealtimeEvent } from "../../../utils/domain-event-bridge.js";
import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import { hasScope, logger, type HubHono } from "./_shared.js";

// ── Wire schemas ───────────────────────────────────────────────────────────

const ArtifactWireSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  userId: z.string(),
  kind: z.string(),
  refId: z.string().nullable(),
  cellKey: z.string().nullable(),
  props: z.unknown().nullable(),
  title: z.string(),
  originKind: z.string(),
  actorId: z.string().nullable(),
  sessionId: z.string().nullable(),
  state: z.string(),
  placement: z.string(),
  keptAt: z.string().nullable(),
  sweptAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const CreateBodySchema = z.object({
  workspaceId: z.string().min(1),
  userId: z.string().min(1),
  kind: z.enum(["view", "cell", "document", "entity", "url"]),
  refId: z.string().optional(),
  cellKey: z.string().optional(),
  props: z.unknown().optional(),
  title: z.string().min(1).max(500),
  /** Defaults to 'agent' for hub-authenticated requests. */
  originKind: z
    .enum(["user", "agent", "deeplink", "system"])
    .optional()
    .default("agent"),
  actorId: z.string().optional(),
  sessionId: z.string().uuid().optional(),
  placement: z.enum(["desk", "home", "sidebar", "library"]).optional(),
});

const UpdateBodySchema = z.object({
  workspaceId: z.string().min(1),
  state: z.enum(["working", "kept", "swept"]).optional(),
  placement: z.enum(["desk", "home", "sidebar", "library"]).optional(),
});

// ── Registration ───────────────────────────────────────────────────────────

export function registerArtifactsRoutes(app: HubHono): void {
  // ── OpenAPI metadata ─────────────────────────────────────────────────────

  registerOpenApi(app, {
    method: "get",
    path: "/artifacts",
    tags: ["Artifacts"],
    summary: "List artifacts for a workspace",
    request: {
      query: z.object({
        workspaceId: z.string(),
        state: z.enum(["working", "kept", "swept", "all"]).optional(),
        placement: z
          .enum(["desk", "home", "sidebar", "library", "all"])
          .optional(),
        sessionId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      }),
    },
    responses: {
      200: { description: "Artifacts", schema: z.array(ArtifactWireSchema) },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/artifacts",
    tags: ["Artifacts"],
    summary: "Create an artifact",
    description:
      "IS/agent creates an artifact. originKind defaults to 'agent' for hub-authenticated requests.",
    request: { body: CreateBodySchema },
    responses: {
      200: { description: "Created artifact", schema: ArtifactWireSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "patch",
    path: "/artifacts/:id",
    tags: ["Artifacts"],
    summary: "Update artifact state / placement",
    request: {
      params: z.object({ id: z.string().uuid() }),
      body: UpdateBodySchema,
    },
    responses: {
      200: { description: "Updated artifact", schema: ArtifactWireSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  // ── Handlers ─────────────────────────────────────────────────────────────
  // Static route (/artifacts) BEFORE dynamic (/artifacts/:id) — Hono is first-match.

  /**
   * GET /artifacts?workspaceId=...&state=...&placement=...&sessionId=...&limit=...
   */
  app.get("/artifacts", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }

    const workspaceId = c.req.query("workspaceId");
    if (!workspaceId) {
      return c.json({ error: "workspaceId is required" }, 400);
    }

    const stateRaw = c.req.query("state") ?? "all";
    const placementRaw = c.req.query("placement") ?? "all";
    const sessionId = c.req.query("sessionId");
    const limitRaw = parseInt(c.req.query("limit") ?? "50", 10);
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(limitRaw, 1), 100)
      : 50;

    const validStates = ["working", "kept", "swept", "all"] as const;
    const validPlacements = [
      "desk",
      "home",
      "sidebar",
      "library",
      "all",
    ] as const;

    const state = validStates.includes(stateRaw as (typeof validStates)[number])
      ? (stateRaw as (typeof validStates)[number])
      : "all";
    const placement = validPlacements.includes(
      placementRaw as (typeof validPlacements)[number]
    )
      ? (placementRaw as (typeof validPlacements)[number])
      : "all";

    try {
      const conditions = [eq(artifacts.workspaceId, workspaceId)];
      if (state !== "all") {
        conditions.push(eq(artifacts.state, state));
      }
      if (placement !== "all") {
        conditions.push(eq(artifacts.placement, placement));
      }
      if (sessionId) {
        conditions.push(eq(artifacts.sessionId, sessionId));
      }

      const rows = await db
        .select()
        .from(artifacts)
        .where(and(...conditions))
        .orderBy(desc(artifacts.createdAt))
        .limit(limit);

      return c.json(rows);
    } catch (err) {
      logger.error({ err }, "artifacts.list failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /artifacts
   * IS/agent creates an artifact — originKind defaults to 'agent'.
   */
  app.post("/artifacts", async (c) => {
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

    try {
      const [created] = await db
        .insert(artifacts)
        .values({
          workspaceId: body.workspaceId,
          userId: body.userId,
          kind: body.kind,
          refId: body.refId ?? null,
          cellKey: body.cellKey ?? null,
          props: body.props ?? null,
          title: body.title,
          // Hub-authenticated requests are from agents — default originKind='agent'
          originKind: body.originKind,
          actorId: body.actorId ?? null,
          sessionId: body.sessionId ?? null,
          state: "working",
          placement: body.placement ?? "desk",
        })
        .returning();

      emitHubRealtimeEvent({
        eventType: "artifact:changed",
        subjectId: created.id,
        userId: body.userId,
        data: {
          id: created.id,
          workspaceId: created.workspaceId,
          state: created.state,
          placement: created.placement,
          kind: created.kind,
          title: created.title,
        },
      });

      return c.json(created);
    } catch (err) {
      logger.error({ err }, "artifacts.create failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * PATCH /artifacts/:id
   * IS/agent transitions state and/or placement.
   */
  app.patch("/artifacts/:id", async (c) => {
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

    try {
      const existing = await db.query.artifacts.findFirst({
        where: and(
          eq(artifacts.id, id),
          eq(artifacts.workspaceId, parsed.data.workspaceId)
        ),
      });

      if (!existing) {
        return c.json({ error: `Artifact ${id} not found` }, 404);
      }

      const { workspaceId: _ws, ...patch } = parsed.data;
      const now = new Date();
      const set: Partial<typeof artifacts.$inferInsert> = {
        updatedAt: now,
      };

      if (patch.state !== undefined) {
        set.state = patch.state;
        if (patch.state === "kept" && existing.state !== "kept") {
          set.keptAt = now;
        }
        if (patch.state === "swept" && existing.state !== "swept") {
          set.sweptAt = now;
        }
      }
      if (patch.placement !== undefined) {
        set.placement = patch.placement;
      }

      const [updated] = await db
        .update(artifacts)
        .set(set)
        .where(eq(artifacts.id, id))
        .returning();

      emitHubRealtimeEvent({
        eventType: "artifact:changed",
        subjectId: updated.id,
        userId: updated.userId,
        data: {
          id: updated.id,
          workspaceId: updated.workspaceId,
          state: updated.state,
          placement: updated.placement,
          kind: updated.kind,
          title: updated.title,
        },
      });

      return c.json(updated);
    } catch (err) {
      logger.error({ err, id }, "artifacts.update failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
