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
import { readUsageForCaller } from "../../../services/usage/read-usage.js";
import { API_USAGE_GROUP_BY } from "@synap/database";
import { ErrorSchema, uuidQueryParam } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  hasScope,
  logger,
  type HubHono,
  errCode,
  httpStatusForTrpcError,
  readJsonBody,
} from "./_shared.js";

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
      "usage",
    ])
    .optional(),
  workspaceId: uuidQueryParam.nullable().optional(),
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
  // type "usage" (0364)
  since: z.string().optional(),
  groupBy: z.array(z.string()).optional(),
  apiKeyId: z.string().optional(),
  client: z.string().optional(),
});

const UsageQuerySchema = z.object({
  since: z
    .string()
    .optional()
    .describe(
      "Window start: ISO time or a span back from now (30m, 24h, 7d; default 24h)."
    ),
  until: z
    .string()
    .optional()
    .describe("Window end: ISO time or a span (default now)."),
  groupBy: z
    .string()
    .optional()
    .describe(
      `Comma-separated dimensions: ${API_USAGE_GROUP_BY.join(", ")} (default client,rlClass,outcome).`
    ),
  apiKeyId: uuidQueryParam.optional().describe("Narrow to one API key."),
  client: z
    .string()
    .optional()
    .describe(
      "Narrow to one client (X-Synap-Client, e.g. synap-bridge/0.6.0)."
    ),
  limit: z
    .string()
    .optional()
    .describe("Max groups, largest first (default 200, max 1000)."),
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

    const jsonRead = await readJsonBody(c);
    if (!jsonRead.ok) return jsonRead.res;
    const raw = jsonRead.body;
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
        since: body.since,
        groupBy: body.groupBy,
        apiKeyId: body.apiKeyId,
        client: body.client,
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err, userId }, "diagnose failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  });

  registerOpenApi(app, {
    method: "get",
    path: "/usage",
    tags: ["Runs"],
    summary: "API usage — calls per key, client, conversation, class, outcome",
    description:
      "Counts from `api_usage_buckets` (5-minute buckets, 30 days): calls, " +
      "summed wall time and distinct conversations, grouped by the asked " +
      "dimensions, largest first. Pod owner or admin only. Same read as " +
      "`synap_diagnose` type `usage`.",
    request: { query: UsageQuerySchema },
    responses: {
      200: { description: "Usage groups", schema: z.any() },
      400: { description: "Bad query", schema: ErrorSchema },
      403: { description: "Not a pod admin", schema: ErrorSchema },
    },
  });

  app.get("/usage", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const userId = c.get("userId") as string | undefined;
    if (!userId) return c.json({ error: "Unauthorized" }, 401);

    const parsed = UsageQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(
        { error: "Invalid query", details: parsed.error.flatten() },
        400
      );
    }
    const q = parsed.data;
    try {
      const usage = await readUsageForCaller(userId, q);
      return c.json(usage);
    } catch (err) {
      const code = errCode(err);
      const refused = code === "FORBIDDEN" || code === "BAD_REQUEST";
      if (!refused) {
        logger.error({ err, userId }, "usage read failed");
      }
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  });
}
