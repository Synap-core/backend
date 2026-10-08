/**
 * Hub Protocol REST — playbook runs (capture-back)
 *
 * The BYOA / IS capture-back surface for the executor spine (Phase 3). An
 * external agent (or the IS) reports a run's outcome back into Synap:
 *
 *   POST /runs/:runId/capture  — update a run's status/summary and record the
 *                                entities it produced (`session → produced → entity`).
 *
 * Requires hub-protocol.write scope. The acting principal's workspace MUST match
 * the run's workspace (cross-tenant guard). Writes go through
 * `checkPermissionOrPropose` so the governance membrane is honored — on
 * "proposed" the run is NOT mutated (the proposal is the record).
 *
 * Design doc: team/platform/playbooks-capability-substrate.mdx (§4.4,
 * external-agent capture-back; BYOA acts only through the Hub Protocol).
 */

import { z } from "zod";
import { db, eq, playbookRuns } from "@synap/database";
import { checkPermissionOrPropose } from "../../../utils/permission-check.js";
import { applyRunCapture } from "../../../services/runs/apply-run-capture.js";
import { cancelRun } from "../../../services/agent-dispatch/cancel-run.js";
import { listRuns, getRun } from "../../../services/runs/index.js";
import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  hasScope,
  logger,
  resolveActingContext,
  type HubHono,
  httpStatusForTrpcError,
  requireUuidParam,
} from "./_shared.js";

// ── Unified-run read schemas (the cross-flow diagnose door) ──────────────────

const FlowTypeSchema = z.enum([
  "automation",
  "playbook",
  "capture",
  "capability",
  "session",
  "chat",
]);
const RunStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "proposed",
  "cancelled",
  "skipped",
  "blocked_by_policy",
  "waiting_on_you",
]);

// ── Wire schemas ─────────────────────────────────────────────────────────────

const CaptureRequestSchema = z.object({
  summary: z.string().max(10_000).optional(),
  status: z.enum(["running", "completed", "failed", "proposed"]).optional(),
  error: z.string().max(10_000).optional(),
  producedEntityIds: z.array(z.string()).optional(),
  /** Capabilities the run actually invoked → `session → used → {tool|skill|command}` provenance. */
  usedCapabilities: z
    .array(
      z.object({ kind: z.enum(["tool", "skill", "command"]), id: z.string() })
    )
    .optional(),
  agentUserId: z.string().optional(),
});

const CaptureResponseSchema = z.object({
  id: z.string(),
  status: z.string(),
  proposalId: z.string().nullable(),
});

export function registerRunsRoutes(app: HubHono): void {
  // ── GET /runs — the unified cross-flow run feed (read door) ────────────────
  // Lets the operating AI / CLI ask "what did I do?" across automation, playbook,
  // capture, and session runs — the same UnifiedRun the browser Runs view reads.
  // USER-floored: the acting user comes from the auth middleware, NEVER a query
  // param (mirrors /observability's read-path asymmetry — no cross-user IDOR).
  registerOpenApi(app, {
    method: "get",
    path: "/runs",
    tags: ["Runs"],
    summary: "List runs across flows (unified feed)",
    description:
      "Newest-first run feed across automation / playbook / capture / capability / session / chat. " +
      "Filter to one ledger with flowType, or one flow with flowId. This is the " +
      "AI/CLI diagnose door: a capture run's activity (via GET /runs/{id}) is its " +
      "correlationId-keyed decision + trace events — what happened and why.",
    responses: {
      200: {
        description: "Run feed",
        schema: z.object({ runs: z.array(z.any()) }),
      },
      403: { description: "Forbidden", schema: ErrorSchema },
    },
  });

  app.get("/runs", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const userId = c.get("userId") as string | undefined;
    if (!userId) return c.json({ error: "Unauthorized" }, 401);

    const ft = c.req.query("flowType");
    const parsedFt = ft ? FlowTypeSchema.safeParse(ft) : null;
    const flowId = c.req.query("flowId") || undefined;
    const st = c.req.query("status");
    const parsedSt = st ? RunStatusSchema.safeParse(st) : null;
    const limitRaw = Number(c.req.query("limit"));
    const limit = Number.isFinite(limitRaw) ? limitRaw : undefined;

    // The same lens the tRPC `runs.list` `scope` takes — a filter WITHIN the
    // user floor above, never an authorization boundary. A malformed id is a
    // 400, not a silently unfiltered feed.
    const scope: Record<string, string> = {};
    for (const key of [
      "workspaceId",
      "projectId",
      "subjectEntityId",
      // SESSION lens — see `RunScope.sessionId`. Listed here because the
      // scope keys are hand-enumerated at this door: a field added to
      // `RunScope` and not to this array is reachable by NOBODY, which is how
      // this lens shipped unreachable in the first place.
      "sessionId",
    ] as const) {
      const value = c.req.query(key);
      if (!value) continue;
      if (!z.string().uuid().safeParse(value).success) {
        return c.json({ error: `${key} must be a UUID` }, 400);
      }
      scope[key] = value;
    }

    // INCOHERENT SCOPE is a CALLER error — a 400, never the 500 a bare service
    // throw would produce. `listRuns` refuses `sessionId` + `projectId`
    // because `events` has no project column, so the pair would return the
    // proposal-backed runs and silently drop every direct one. Caught here so
    // the caller is told what to change instead of reading "internal error".
    if (scope.sessionId && scope.projectId) {
      return c.json(
        {
          error:
            "sessionId and projectId cannot be combined — a session already pins its project, and the pair would silently drop every direct capability run. Pass one or the other.",
        },
        400
      );
    }

    const runs = await listRuns({
      userId,
      flowType: parsedFt?.success ? parsedFt.data : undefined,
      flowId,
      status: parsedSt?.success ? parsedSt.data : undefined,
      ...(Object.keys(scope).length > 0 ? { scope } : {}),
      limit,
    });
    return c.json({ runs });
  });

  // ── GET /runs/{id} — one run + its activity timeline ───────────────────────
  registerOpenApi(app, {
    method: "get",
    path: "/runs/{id}",
    tags: ["Runs"],
    summary: "Get one run + its activity timeline",
    description:
      "Returns the run and its flow-agnostic activity: automation steps, or a " +
      "capture's decision/trace events (component/reason/fixHint — the diagnose " +
      "story). Requires flowType (the id space differs per ledger).",
    request: {
      params: z.object({ id: z.string() }),
      query: z.object({ flowType: FlowTypeSchema }),
    },
    responses: {
      200: { description: "Run detail", schema: z.any() },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Run not found", schema: ErrorSchema },
    },
  });

  app.get("/runs/:id", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const userId = c.get("userId") as string | undefined;
    if (!userId) return c.json({ error: "Unauthorized" }, 401);

    const parsedFt = FlowTypeSchema.safeParse(c.req.query("flowType"));
    if (!parsedFt.success) {
      return c.json({ error: "flowType query param is required" }, 400);
    }
    const id = requireUuidParam(c, "id");
    if (id instanceof Response) return id;
    const detail = await getRun({
      userId,
      flowType: parsedFt.data,
      id,
    });
    if (!detail) return c.json({ error: "Run not found" }, 404);
    return c.json(detail);
  });

  registerOpenApi(app, {
    method: "post",
    path: "/runs/{runId}/cancel",
    tags: ["Playbooks"],
    summary: "Cancel a live playbook run (and its external agent task)",
    description:
      "Marks a running run cancelled. When the run was handed to an external agent whose binding supports cancel, the binding's cancel verb runs first and must succeed; otherwise the run is cancelled and the response says the agent could not be stopped from Synap. Human-only: an agent key gets 403.",
    request: { params: z.object({ runId: z.string() }) },
    responses: {
      200: {
        description: "Cancelled",
        schema: z
          .object({
            id: z.string(),
            status: z.string(),
            externalCancelled: z.boolean().nullable().optional(),
            note: z.string().optional(),
          })
          .passthrough(),
      },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Run not found", schema: ErrorSchema },
      409: { description: "Run is not live", schema: ErrorSchema },
      502: { description: "The agent's cancel failed", schema: ErrorSchema },
    },
  });

  app.post("/runs/:runId/cancel", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const runId = requireUuidParam(c, "runId");
    if (runId instanceof Response) return runId;
    // HUMAN-ONLY (v1): stopping work is the person's call. A governed agent
    // cancel would file a `playbook_run/update` proposal whose approval
    // replays a CAPTURE — it could never reach the binding's cancel verb.
    // An internal / pod-wide key (the IS's `is_internal`, a `system` key) can
    // act as any user — it is never "the person" either.
    const keyType = c.get("keyType") as string | undefined;
    if (
      c.get("agentUserId") ||
      keyType === "is_internal" ||
      keyType === "system"
    ) {
      return c.json(
        { error: "Only a person can cancel a run — an agent key cannot." },
        403
      );
    }
    try {
      const run = await db.query.playbookRuns.findFirst({
        where: eq(playbookRuns.id, runId),
      });
      if (!run) return c.json({ error: "Run not found" }, 404);
      const acting = await resolveActingContext(c, {
        workspaceId: run.workspaceId ?? undefined,
      });
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);
      if (run.workspaceId && run.workspaceId !== acting.workspaceId) {
        return c.json({ error: "Run not found" }, 404);
      }
      const out = await cancelRun({ runId, userId: acting.userId });
      if (out.status === "not_found")
        return c.json({ error: "Run not found" }, 404);
      if (out.status === "not_live") {
        return c.json(
          { error: `Run is ${out.runStatus}, not running — nothing to cancel` },
          409
        );
      }
      if (out.status === "cancel_failed") {
        return c.json(
          { error: `The agent's task could not be cancelled: ${out.message}` },
          502
        );
      }
      return c.json({
        id: runId,
        status: "cancelled",
        externalCancelled: out.externalCancelled,
        ...(out.note ? { note: out.note } : {}),
      });
    } catch (err) {
      logger.error({ err, runId }, "runs.cancel failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  });

  registerOpenApi(app, {
    method: "post",
    path: "/runs/{runId}/capture",
    tags: ["Playbooks"],
    summary: "Capture a playbook run's outcome",
    description:
      "Reports a run's status/summary back into Synap and records the entities it produced (session → produced → entity links). Governance-gated; on 'proposed' the run is not mutated.",
    request: {
      params: z.object({ runId: z.string() }),
      body: CaptureRequestSchema,
    },
    responses: {
      200: { description: "Capture recorded", schema: CaptureResponseSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Run not found", schema: ErrorSchema },
      409: {
        description:
          "The run already reached a verdict (terminal capture refused)",
        schema: ErrorSchema,
      },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.post("/runs/:runId/capture", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }

    const runId = requireUuidParam(c, "runId");
    if (runId instanceof Response) return runId;
    const raw = await c.req.json().catch(() => null);
    const parsed = CaptureRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid request body", details: parsed.error.flatten() },
        400
      );
    }
    const body = parsed.data;

    try {
      // Load the run by id ONLY, then bind the acting identity to its workspace.
      const run = await db.query.playbookRuns.findFirst({
        where: eq(playbookRuns.id, runId),
      });
      if (!run) return c.json({ error: "Run not found" }, 404);

      // Resolve acting context within the run's OWN workspace — this both
      // verifies membership and closes the cross-tenant write (an agent can only
      // capture into a run whose workspace it belongs to).
      const acting = await resolveActingContext(c, {
        userId: body.agentUserId,
        workspaceId: run.workspaceId ?? undefined,
      });
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);
      if (run.workspaceId && run.workspaceId !== acting.workspaceId) {
        // No cross-tenant capture — same 404 as a missing run (no oracle).
        return c.json({ error: "Run not found" }, 404);
      }

      const agentUserId =
        body.agentUserId ??
        (c.get("agentUserId") as string | undefined) ??
        acting.userId;

      // Governance membrane decides approve vs propose.
      const perm = await checkPermissionOrPropose({
        userId: acting.userId,
        agentUserId: agentUserId !== acting.userId ? agentUserId : undefined,
        workspaceId: run.workspaceId,
        subjectType: "playbook_run",
        action: "update",
        // "agent" is NOT a valid EventSource — on the propose branch it reached
        // the event append inside a TX that rolls back + re-throws, turning
        // every agent playbook-run status update that needs approval into a
        // hard 500. Agent identity is carried by agentUserId above; the valid,
        // closest source is "intelligence".
        source: "intelligence",
        // Widened (gate-payload sufficiency): the payload omitted `error` and
        // `producedEntityIds`, so approving a failed-run capture lost the failure
        // reason AND every provenance edge the direct path writes below. Carry
        // both. `producedEntityIds` are ids only — they are re-validated against
        // the run's own workspace at apply time, so storing them grants nothing.
        data: {
          runId,
          status: body.status,
          summary: body.summary,
          error: body.error,
          producedEntityIds: body.producedEntityIds,
        },
      });
      if ("denied" in perm && perm.denied) {
        return c.json({ error: perm.reason }, 403);
      }
      if ("proposalId" in perm) {
        return c.json({
          id: runId,
          status: run.status,
          proposalId: perm.proposalId,
        });
      }

      // Approved → the ONE capture write (shared with the external-agent
      // status poll): status/summary/error, terminal stamp, parent settle,
      // produced + used provenance.
      const updated = await applyRunCapture({
        run,
        status: body.status,
        summary: body.summary,
        error: body.error,
        producedEntityIds: body.producedEntityIds,
        usedCapabilities: body.usedCapabilities,
      });
      if (!updated) {
        // The run reached a verdict in between (cancelled / finished): no
        // capture — terminal or `running` — overwrites or revives it.
        const [now] = await db
          .select({ status: playbookRuns.status })
          .from(playbookRuns)
          .where(eq(playbookRuns.id, runId));
        return c.json(
          {
            error: `Run is ${now?.status ?? "gone"} — a finished run's outcome is not overwritten`,
          },
          409
        );
      }

      return c.json({
        id: updated.id,
        status: updated.status,
        proposalId: null,
      });
    } catch (err) {
      logger.error({ err, runId }, "runs.capture failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  });
}
