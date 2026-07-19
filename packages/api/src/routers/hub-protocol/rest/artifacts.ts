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
 * Writes go through checkPermissionOrPropose so the governance membrane is honored.
 */

import { z } from "@hono/zod-openapi";
import { db, eq, and, desc, artifacts } from "@synap/database";
import { checkPermissionOrPropose } from "../../../utils/permission-check.js";
import { emitHubRealtimeEvent } from "../../../utils/domain-event-bridge.js";
import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  hasScope,
  logger,
  resolveActingContext,
  type HubHono,
} from "./_shared.js";
import { getConfinedWorkspace } from "../confine-workspace.js";

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
  agentUserId: z.string().uuid().optional(),
  reasoning: z.string().optional(),
});

// workspaceId is intentionally excluded from the PATCH body — the authoritative
// workspace comes from the LOADED ROW (write-gate rule: never trust a caller-
// supplied workspaceId for scoping a mutation).
const UpdateBodySchema = z.object({
  state: z.enum(["working", "kept", "swept"]).optional(),
  placement: z.enum(["desk", "home", "sidebar", "library"]).optional(),
  agentUserId: z.string().uuid().optional(),
  reasoning: z.string().optional(),
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
      "IS/agent creates an artifact. originKind defaults to 'agent' for hub-authenticated requests. Goes through the governance membrane — may return { status: 'proposed', proposalId } for agent callers.",
    request: { body: CreateBodySchema },
    responses: {
      200: {
        description: "Created artifact or proposal",
        schema: z.object({}).passthrough(),
      },
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
    description:
      "Loads the row by id, verifies the caller's workspace membership against the row's workspace, then gates through the governance membrane.",
    request: {
      params: z.object({ id: z.string().uuid() }),
      body: UpdateBodySchema,
    },
    responses: {
      200: {
        description: "Updated artifact or proposal",
        schema: z.object({}).passthrough(),
      },
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
   * IS/agent creates an artifact — goes through checkPermissionOrPropose.
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

    // Bind the acting identity to the authenticated principal and verify
    // workspace membership — mirrors entities.ts POST pattern.
    const acting = await resolveActingContext(c, {
      userId: body.userId,
      workspaceId: body.workspaceId,
    });
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    const { userId } = acting;
    // Item 3 Part 3: positively pin a bound service key to its workspace.
    // CreateBodySchema requires workspaceId (z.string().min(1)), so acting.workspaceId
    // is a non-null string here. Both the governance gate AND the db.insert below
    // route through this clamped value (previously line 301 used raw body.workspaceId).
    // A mismatching bound key throws FORBIDDEN → surface 403, not a blanket 500.
    let workspaceId: string;
    try {
      workspaceId = getConfinedWorkspace(c, acting.workspaceId) as string;
    } catch (err) {
      if ((err as { code?: unknown })?.code === "FORBIDDEN")
        return c.json(
          { error: err instanceof Error ? err.message : "Forbidden" },
          403
        );
      throw err;
    }

    // Governance membrane — artifact.create goes through checkPermissionOrPropose.
    // If it's in DEFAULT_AUTO_APPROVE the membrane approves inline; otherwise it
    // returns a proposalId for the agent to surface to the user.
    const ctxAgentUserId = c.get("agentUserId") as string | undefined;
    const agentUserId = body.agentUserId ?? ctxAgentUserId;

    try {
      const perm = await checkPermissionOrPropose({
        userId,
        agentUserId,
        workspaceId,
        subjectType: "artifact",
        action: "create",
        source: "intelligence",
        reasoning: body.reasoning,
        data: {
          kind: body.kind,
          title: body.title,
          placement: body.placement ?? "desk",
          refId: body.refId,
        },
      });

      if ("denied" in perm && perm.denied) {
        return c.json({ error: perm.reason }, 403);
      }
      if ("proposalId" in perm) {
        return c.json({
          status: "proposed",
          message: "Artifact creation proposed for review",
          proposalId: perm.proposalId,
          summary: perm.summary,
          reasoning: perm.reasoning,
          reviewPath: perm.reviewPath,
          reviewUrl: perm.reviewUrl,
          artifact: null,
        });
      }

      const [created] = await db
        .insert(artifacts)
        .values({
          // CreateBodySchema requires workspaceId (z.string().min(1)); artifacts
          // are workspace-scoped (artifacts.workspaceId is NOT NULL). Confined value.
          workspaceId,
          userId,
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
        eventType: "artifact.changed.completed",
        subjectId: created.id,
        userId,
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
   *
   * Write-gate pattern (mirrors entities.ts PATCH):
   *   1. Load the row by id alone (never trust a caller-supplied workspaceId for scoping).
   *   2. Verify the caller's membership in the LOADED ROW's workspace via resolveActingContext.
   *   3. Gate through checkPermissionOrPropose — the membrane decides approve vs propose.
   *   4. Execute the raw DB update only after gate approval.
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

    const patch = parsed.data;

    try {
      // Step 1: load by id alone — workspaceId comes from the ROW, not the body.
      const existing = await db.query.artifacts.findFirst({
        where: eq(artifacts.id, id),
      });

      if (!existing) {
        return c.json({ error: `Artifact ${id} not found` }, 404);
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
        subjectType: "artifact",
        action: "setState",
        source: "intelligence",
        reasoning: patch.reasoning,
        data: {
          id,
          state: patch.state,
          placement: patch.placement,
        },
      });

      if ("denied" in perm && perm.denied) {
        return c.json({ error: perm.reason }, 403);
      }
      if ("proposalId" in perm) {
        return c.json({
          status: "proposed",
          message: "Artifact update proposed for review",
          proposalId: perm.proposalId,
          summary: perm.summary,
          reasoning: perm.reasoning,
          reviewPath: perm.reviewPath,
          reviewUrl: perm.reviewUrl,
          artifact: null,
        });
      }

      // Step 4: execute the update.
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
        eventType: "artifact.changed.completed",
        subjectId: updated.id,
        userId,
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
