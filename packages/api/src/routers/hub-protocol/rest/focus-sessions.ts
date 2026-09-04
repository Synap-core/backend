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
 *   POST   /focus-sessions/:id/complete — lifecycle close + proposal pack
 *   POST   /focus-sessions/:id/used — record capability usage link
 *   POST   /focus-sessions/:sessionId/complete-run — close running playbook_run
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
import {
  checkPermissionOrPropose,
  proposedMessageFor,
} from "../../../utils/permission-check.js";
import { createLinks } from "../../../services/links/links-service.js";
import { emitHubRealtimeEvent } from "../../../utils/domain-event-bridge.js";
import { emitSideEffects } from "@synap/events";
import { createFocusSession } from "../../../services/focus-sessions/create-session.js";
import { completeFocusSession } from "../../../services/focus-sessions/complete-session.js";
import {
  isTerminalSessionStatus,
  SESSION_STATUSES,
} from "../../../services/focus-sessions/session-statuses.js";
import {
  attachTriage,
  notTriagePendingWhere,
  triagePendingWhere,
} from "../../../services/focus-sessions/triage.js";
import { resolveCaptureActorUserId } from "../../../services/capture-agent/resolve-capture-actor.js";
import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  hasScope,
  httpStatusForTrpcError,
  logger,
  resolveActingContext,
  type HubHono,
} from "./_shared.js";
import { getConfinedWorkspace } from "../confine-workspace.js";

// ── Wire schemas ───────────────────────────────────────────────────────────

const ExpectedOutputItemSchema = z.object({
  kind: z.string(),
  label: z.string(),
  icon: z.string().optional(),
  // Per-item lifecycle (defaults to "pending" when omitted). Shape-within-jsonb.
  status: z.enum(["pending", "done"]).optional(),
});

const FocusSessionWireSchema = z.object({
  id: z.string(),
  workspaceId: z.string().nullable(),
  projectId: z.string().nullable(),
  userId: z.string(),
  correlationId: z.string().nullable(),
  goal: z.string(),
  status: z.string(),
  templateId: z.string().nullable(),
  expectedOutputs: z.unknown(),
  channelId: z.string().nullable(),
  progress: z.number().nullable(),
  currentStage: z.string().nullable(),
  agentIds: z.array(z.string()),
  closedAt: z.string().nullable(),
  verificationReport: z.unknown().nullable(),
  metadata: z.unknown(),
  startedAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const CreateBodySchema = z
  .object({
    // workspaceId OR projectId — a session may be scoped to either (or both).
    workspaceId: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
    userId: z.string().min(1),
    goal: z.string().min(1).max(2000),
    correlationId: z.string().optional(),
    templateId: z.string().optional(),
    expectedOutputs: z.array(ExpectedOutputItemSchema).optional(),
    channelId: z.string().uuid().optional(),
    agentIds: z.array(z.string()).optional(),
    /**
     * The session this one was PUSHED FROM (a detour). Recorded as
     * `session --spawned_from--> session`; owner-floored server-side, so an
     * unowned/unknown parent drops the edge rather than failing the create.
     * Never a column, never a governance inherit.
     */
    parentSessionId: z.string().uuid().optional(),
    /** One line describing what the PARENT was about to do, at push time. */
    suspendedIntent: z.string().min(1).max(2000).optional(),
  })
  .refine((b) => !!b.workspaceId || !!b.projectId, {
    message: "Provide a workspaceId or a projectId",
    path: ["workspaceId"],
  });

// workspaceId is accepted for back-compat with CLI callers that still send it,
// but the authoritative workspace comes from the LOADED ROW (write-gate rule:
// never trust a caller-supplied workspaceId for scoping a mutation).
const UpdateBodySchema = z.object({
  workspaceId: z.string().min(1).optional(),
  status: z
    .enum([
      "active",
      "paused",
      "closed",
      "forming",
      "scheduled",
      "failed",
      "cancelled",
    ])
    .optional(),
  progress: z.number().int().min(0).max(100).optional(),
  channelId: z.string().uuid().optional(),
  correlationId: z.string().optional(),
  goal: z.string().min(1).max(2000).optional(),
  agentIds: z.array(z.string()).optional(),
  expectedOutputs: z.array(ExpectedOutputItemSchema).optional(),
  verificationReport: z.unknown().optional(),
  // First-class stages: advance the active playbook stage (PlaybookStage.key).
  currentStage: z.string().min(1).optional(),
  // Free-form metadata bag — SHALLOW-MERGED into the existing row metadata.
  metadata: z.record(z.string(), z.unknown()).optional(),
  agentUserId: z.string().uuid().optional(),
  reasoning: z.string().optional(),
});

const UsedCapabilityBodySchema = z.object({
  capabilityKind: z.enum(["tool", "skill", "command"]),
  capabilityId: z.string().min(1),
});

const CompleteBodySchema = z.object({
  summary: z.string().optional(),
  verificationReport: z.record(z.string(), z.unknown()).optional(),
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
        status: z.enum([...SESSION_STATUSES, "all"]).optional(),
        // Triage lens. Default here is `all` (agent-facing door); `default`
        // hides agent/automation-originated sessions not yet accepted by a
        // human, `triage` returns only those. Rows carry `triage.pending`.
        lens: z.enum(["default", "triage", "all"]).optional(),
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
      // workspaceId optional: when omitted, floor on owner/user (project-scoped OK).
      query: z.object({ workspaceId: z.string().optional() }),
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
    path: "/focus-sessions/:id/complete",
    tags: ["FocusSessions"],
    summary: "Complete (close) a focus session and return the proposal pack",
    description:
      "Lifecycle close via completeFocusSession — stamps closed, finishes any " +
      "running playbook_run, returns pendingProposals + counts + warnings. " +
      "Distinct from POST .../complete-run (playbook run only).",
    request: {
      params: z.object({ id: z.string().uuid() }),
      body: CompleteBodySchema,
    },
    responses: {
      200: {
        description: "Closed session + proposal pack",
        schema: z.object({}).passthrough(),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden or proposed", schema: ErrorSchema },
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
      404: { description: "Not found", schema: ErrorSchema },
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
    // ONE status vocabulary (session-statuses.ts) — this door used to carry a
    // hand-mirrored copy that would silently reject any status the schema
    // later learned.
    const validStatuses = [...SESSION_STATUSES, "all"] as const;
    const status = validStatuses.includes(
      statusRaw as (typeof validStatuses)[number]
    )
      ? (statusRaw as (typeof validStatuses)[number])
      : "all";

    // Triage lens, same vocabulary as tRPC `focusSessions.list`. This is the
    // AGENT-facing door (IS + CLI), so the default is `all`: an agent listing
    // sessions is usually looking for the one it just opened, which is exactly
    // the row the human default lens hides. Rows still carry the projection so
    // a human overview riding this door can group Drafted itself.
    const lensRaw = c.req.query("lens") ?? "all";
    const lens: "default" | "triage" | "all" =
      lensRaw === "default" || lensRaw === "triage" ? lensRaw : "all";

    // Optional: narrow to sessions ABOUT a specific subject entity (the
    // subject-spine anchor). Lets a caller fetch "the sessions linked to this
    // client/person/deal" — the session half of an entity's neighborhood.
    const subjectEntityId = c.req.query("subjectEntityId");

    try {
      const conditions = [
        eq(focusSessions.workspaceId, workspaceIdParam),
        eq(focusSessions.userId, acting.userId),
      ];
      if (status !== "all") {
        conditions.push(eq(focusSessions.status, status));
      }
      if (subjectEntityId) {
        conditions.push(eq(focusSessions.subjectEntityId, subjectEntityId));
      }
      if (lens === "triage") conditions.push(triagePendingWhere());
      else if (lens === "default") conditions.push(notTriagePendingWhere());

      const rows = await db
        .select()
        .from(focusSessions)
        .where(and(...conditions))
        .orderBy(desc(focusSessions.startedAt))
        .limit(limit);

      return c.json(attachTriage(rows));
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
   *
   * workspaceId is optional. When provided: membership check + workspace floor
   * (legacy callers). When omitted: owner/user floor only — same as MCP
   * synap_get_session — so project-scoped sessions (workspaceId NULL) resolve.
   */
  app.get("/focus-sessions/:id", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }

    const id = c.req.param("id");
    const workspaceIdParam = c.req.query("workspaceId");
    // Bind acting user; optional workspace membership when a lens is supplied.
    const acting = await resolveActingContext(c, {
      workspaceId: workspaceIdParam || undefined,
    });
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);

    try {
      const conditions = [
        eq(focusSessions.id, id),
        eq(focusSessions.userId, acting.userId),
      ];
      if (workspaceIdParam) {
        conditions.push(eq(focusSessions.workspaceId, workspaceIdParam));
      }

      const row = await db.query.focusSessions.findFirst({
        where: and(...conditions),
      });

      if (!row) {
        return c.json({ error: `Focus session ${id} not found` }, 404);
      }

      return c.json(row);
    } catch (err) {
      logger.error({ err, id }, "focus-sessions.get failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
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
    // workspace membership — mirrors artifacts.ts POST pattern. For a
    // project-scoped session (no workspaceId) we still bind the user but keep
    // the session's workspace null — we do NOT stamp the membership fallback.
    const acting = await resolveActingContext(c, {
      userId: body.userId,
      workspaceId: body.workspaceId,
    });
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    const { userId } = acting;
    // Item 3 Part 3: positively pin a bound service key to its workspace. A
    // project-scoped session (no workspaceId) from a bound key still pins.
    // A mismatching bound key throws FORBIDDEN → surface 403, not a blanket 500.
    let workspaceId: string | null;
    try {
      workspaceId =
        getConfinedWorkspace(c, body.workspaceId ? acting.workspaceId : null) ??
        null;
    } catch (err) {
      if ((err as { code?: unknown })?.code === "FORBIDDEN")
        return c.json(
          { error: err instanceof Error ? err.message : "Forbidden" },
          403
        );
      throw err;
    }

    try {
      // Delegate to the shared service (used by both Hub REST and MCP adapter).
      // On the capture path (X-Capture: 1) attribute the write to the seeded
      // Capture agent so focus_session.create auto-approves; otherwise keep the
      // caller's own agent identity (normal governance).
      const ctxAgentUserId = c.get("agentUserId") as string | undefined;
      const agentUserId = await resolveCaptureActorUserId(c, ctxAgentUserId, {
        workspaceId,
      });
      const result = await createFocusSession({
        userId,
        workspaceId,
        projectId: body.projectId ?? null,
        goal: body.goal,
        agentUserId,
        correlationId: body.correlationId,
        channelId: body.channelId ?? null,
        agentIds: body.agentIds,
        templateId: body.templateId ?? null,
        expectedOutputs: body.expectedOutputs,
        parentSessionId: body.parentSessionId ?? null,
        suspendedIntent: body.suspendedIntent ?? null,
      });

      if (result.status === "proposed") {
        return c.json({
          status: "proposed",
          message: result.message,
          proposalId: result.proposalId,
          summary: result.summary,
          reviewPath: result.reviewPath,
          reviewUrl: result.reviewUrl,
          session: null,
        });
      }

      return c.json(result.session);
    } catch (err) {
      logger.error({ err }, "focus-sessions.create failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
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
      // workspaceId is nullable since Phase 4 (project-scoped sessions). Pass
      // undefined when null so resolveActingContext falls back to pod-level auth.
      const acting = await resolveActingContext(c, {
        workspaceId: existing.workspaceId ?? undefined,
      });
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);
      const { userId, workspaceId } = acting;

      // Step 3: governance membrane. On the capture path (X-Capture: 1) attribute
      // the write to the seeded Capture agent so focus_session.update auto-approves;
      // a body-supplied agentUserId still wins, and a non-capture caller keeps its
      // own agent identity (normal governance).
      const ctxAgentUserId = c.get("agentUserId") as string | undefined;
      const agentUserId =
        patch.agentUserId ??
        (await resolveCaptureActorUserId(c, ctxAgentUserId, { workspaceId }));

      // Gate data: always include goal from the row (proposal summary label) plus
      // every field being patched so focus_session/update can materialize on approve.
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
          goal: patch.goal !== undefined ? patch.goal : existing.goal,
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.progress !== undefined ? { progress: patch.progress } : {}),
          ...(patch.channelId !== undefined
            ? { channelId: patch.channelId }
            : {}),
          ...(patch.correlationId !== undefined
            ? { correlationId: patch.correlationId }
            : {}),
          ...(patch.agentIds !== undefined ? { agentIds: patch.agentIds } : {}),
          ...(patch.expectedOutputs !== undefined
            ? { expectedOutputs: patch.expectedOutputs }
            : {}),
          ...(patch.verificationReport !== undefined
            ? { verificationReport: patch.verificationReport }
            : {}),
          ...(patch.currentStage !== undefined
            ? { currentStage: patch.currentStage }
            : {}),
          ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
        },
      });

      if ("denied" in perm && perm.denied) {
        return c.json({ error: perm.reason }, 403);
      }
      if ("proposalId" in perm) {
        return c.json({
          status: "proposed",
          message: proposedMessageFor(
            perm.proposalType,
            "Focus session update proposed for review"
          ),
          proposalId: perm.proposalId,
          summary: perm.summary,
          reasoning: perm.reasoning,
          reviewPath: perm.reviewPath,
          reviewUrl: perm.reviewUrl,
          session: null,
        });
      }

      // Step 4a: a TERMINAL status funnels through the ONE close door first
      // (pack + run close + ephemeral expiry + close event). This PATCH used to
      // stamp `closed` directly — the "known dual path" — and a `cancelled`
      // write skipped every close side-effect.
      if (
        isTerminalSessionStatus(patch.status) &&
        !isTerminalSessionStatus(existing.status)
      ) {
        try {
          const closed = await completeFocusSession({
            sessionId: id,
            userId,
            agentUserId,
            terminalStatus: patch.status,
          });
          if (!closed) {
            return c.json({ error: `Focus session ${id} not found` }, 404);
          }
        } catch (err) {
          const code = (err as { code?: string }).code;
          const message = err instanceof Error ? err.message : String(err);
          return c.json({ error: message }, code === "FORBIDDEN" ? 403 : 409);
        }
        // The row is now terminal; apply the rest of the patch below.
        delete (patch as { status?: string }).status;
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
      // Shallow-merge, exactly like the `metadata` bag below — `verificationReport`
      // is the SAME shape of thing: an open JSONB bag written by SEVERAL
      // independent producers at different moments in a session's life.
      //
      // `completeFocusSession` writes `{ summary }` at close; a verify step writes
      // `{ codeQuality }`. Under the previous full REPLACE, whichever landed second
      // silently destroyed the other — verify-then-close threw away the code-quality
      // result, close-then-verify threw away the session narrative. Nothing warned,
      // and the loss is invisible because the surface only ever renders one key.
      //
      // Merging makes the column additive, which is what every producer already
      // assumes. To CLEAR a key a caller must now send it explicitly as null —
      // acceptable, because no caller does, and silent destruction is the worse
      // default by a wide margin.
      if (patch.verificationReport !== undefined) {
        const existingReport =
          (existing.verificationReport as Record<string, unknown> | null) ?? {};
        set.verificationReport = {
          ...existingReport,
          ...patch.verificationReport,
        };
      }
      if (patch.currentStage !== undefined)
        set.currentStage = patch.currentStage;
      // Shallow-merge the metadata bag into the existing row metadata (additive).
      if (patch.metadata !== undefined) {
        const existingMeta =
          (existing.metadata as Record<string, unknown> | null) ?? {};
        set.metadata = { ...existingMeta, ...patch.metadata };
      }

      const [updated] = await db
        .update(focusSessions)
        .set(set)
        .where(eq(focusSessions.id, id))
        .returning();

      // Stage transition side-effect: when the active stage actually changes,
      // emit `focus_session.stage_changed` so automations can react (and filter
      // on toStage). No-op for stageless playbooks / unchanged stages.
      if (
        patch.currentStage !== undefined &&
        patch.currentStage !== existing.currentStage
      ) {
        emitSideEffects({
          subjectType: "focus_session",
          action: "stage_changed",
          subjectId: updated.id,
          userId,
          workspaceId: existing.workspaceId,
          data: {
            sessionId: updated.id,
            subjectId: existing.subjectEntityId,
            playbookId: existing.playbookId,
            fromStage: existing.currentStage,
            toStage: updated.currentStage,
            workspaceId: existing.workspaceId,
            userId,
          },
        });
      }

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
   * POST /focus-sessions/:id/complete
   *
   * Lifecycle close via completeFocusSession (same service as MCP
   * synap_complete_session). Returns the proposal pack (pendingProposals,
   * counts, warnings). Does not reimplement close — leave complete-run alone.
   */
  app.post("/focus-sessions/:id/complete", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }

    const id = c.req.param("id");
    const raw = await c.req.json().catch(() => ({}));
    const parsed = CompleteBodySchema.safeParse(raw ?? {});
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) =>
          i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message
        )
        .join(", ");
      return c.json({ error: message }, 400);
    }

    try {
      // Load by id alone — workspace from the ROW (write-gate: never trust body).
      const existing = await db.query.focusSessions.findFirst({
        where: eq(focusSessions.id, id),
      });
      if (!existing) {
        return c.json({ error: `Focus session ${id} not found` }, 404);
      }

      // Project-scoped sessions have null workspaceId — resolveActingContext
      // falls back to pod-level owner floor (same as PATCH).
      const acting = await resolveActingContext(c, {
        workspaceId: existing.workspaceId ?? undefined,
      });
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);
      const { userId, workspaceId } = acting;

      const ctxAgentUserId = c.get("agentUserId") as string | undefined;
      const agentUserId = await resolveCaptureActorUserId(c, ctxAgentUserId, {
        workspaceId,
      });

      const result = await completeFocusSession({
        sessionId: id,
        userId,
        agentUserId,
        summary: parsed.data.summary,
        verificationReport: parsed.data.verificationReport,
      });

      if (!result) {
        return c.json({ error: `Focus session ${id} not found` }, 404);
      }

      return c.json({
        status: "closed" as const,
        session: result.session,
        pendingProposals: result.pendingProposals,
        counts: result.counts,
        warnings: result.warnings,
      });
    } catch (err) {
      const code = (err as { code?: unknown })?.code;
      if (code === "FORBIDDEN") {
        const e = err as {
          message?: string;
          proposalId?: string;
          summary?: string;
          reasoning?: string;
          reviewPath?: string;
          reviewUrl?: string;
        };
        // Proposed shape (consistent with PATCH/create) — 403 when governance
        // still forced a proposal (lifecycle escape should normally prevent this).
        if (e.proposalId) {
          return c.json(
            {
              status: "proposed" as const,
              message:
                e.message ??
                "Session completion proposed for review — approval required",
              proposalId: e.proposalId,
              summary: e.summary,
              reasoning: e.reasoning,
              reviewPath: e.reviewPath,
              reviewUrl: e.reviewUrl,
              session: null,
            },
            403
          );
        }
        return c.json(
          { error: err instanceof Error ? err.message : "Forbidden" },
          403
        );
      }
      logger.error({ err, id }, "focus-sessions.complete failed");
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
        workspaceId: session.workspaceId ?? undefined,
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
