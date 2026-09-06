/**
 * Hub Protocol REST — diagnose (the THIRD door, alongside ask + capture)
 *
 * Exposes `diagnoseRouter` (services/diagnose/index.ts) over Hub REST so any
 * hub client (Raycast, CLI, a BYOA agent) can call it — today it was reachable
 * ONLY via the MCP adapter (`synap_diagnose`, routers/mcp/adapter.ts). Mode is
 * derived from payload shape, exactly like `capture`: {} → whole-pod health ·
 * {type} → a class surface · {id} → auto-detect the object · {agentId} →
 * agent scorecard · {runId,flowType} / {flowType,flowId} → today's run-feed
 * grammar (back-compat).
 */

import { z } from "zod";
import { diagnoseRouter } from "../../../services/diagnose/index.js";
import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import { hasScope, logger, type HubHono } from "./_shared.js";

const DiagnoseRequestSchema = z.object({
  agentId: z.string().optional(),
  id: z.string().optional(),
  type: z
    .enum([
      "proposal",
      "session",
      "capability",
      "agent",
      "entity",
      "run",
      "workspace",
    ])
    .optional(),
  workspaceId: z.string().nullable().optional(),
  stuckThresholdHours: z.number().optional(),
  flowType: z
    .enum([
      "automation",
      "playbook",
      "capture",
      "capability",
      "session",
      "chat",
    ])
    .optional(),
  flowId: z.string().optional(),
  runId: z.string().optional(),
  limit: z.number().optional(),
});

export function registerDiagnoseRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "post",
    path: "/diagnose",
    tags: ["Runs"],
    summary:
      "Diagnose — whole-pod health, a class surface, an object, or an agent",
    description:
      "The THIRD door (alongside ask + capture): mode is derived from payload " +
      "shape, not a caller-chosen endpoint. {} → whole-pod health · {type} → a " +
      "diagnosable class as a surface · {id} → auto-detect the object's kind and " +
      "explain its state + why · {agentId} → agent behavioural scorecard · " +
      "{runId,flowType} / {flowType,flowId} → today's run-detail/run-feed grammar.",
    request: { body: DiagnoseRequestSchema },
    responses: {
      200: { description: "Diagnose result", schema: z.any() },
      403: { description: "Forbidden", schema: ErrorSchema },
    },
  });

  app.post("/diagnose", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const userId = c.get("userId") as string | undefined;
    if (!userId) return c.json({ error: "Unauthorized" }, 401);

    const raw = await c.req.json().catch(() => ({}));
    const parsed = DiagnoseRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid request body", details: parsed.error.flatten() },
        400
      );
    }
    const body = parsed.data;

    try {
      const result = await diagnoseRouter({
        userId,
        agentId: body.agentId,
        id: body.id,
        type: body.type,
        workspaceId: body.workspaceId,
        stuckThresholdHours: body.stuckThresholdHours,
        flowType: body.flowType,
        flowId: body.flowId,
        runId: body.runId,
        limit: body.limit,
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err, userId }, "diagnose failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
