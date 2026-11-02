/**
 * Hub REST — a GOAL's WORKERS (goals that run, R2). The same shared door the
 * MCP tools call (`../worker-doors.ts`):
 *
 *   GET   /workers?trackId=…            the workers enabled on a goal (strict),
 *                                       each a GoalWorkerView (or ?projectId=…)
 *   POST  /workers                      enable { playbookId, activatorKey |
 *                                       schedule, mode?, trackId | projectId,
 *                                       agentUserId? }
 *   POST  /workers/:ruleId/paused       { paused, agentUserId? } — pause / resume
 *   POST  /workers/:ruleId/run          { reasoning?, agentUserId? } — run now,
 *                                       filed in its goal
 *
 * Governance is the services' own (the one rule door; the playbook run door):
 * an agent's write answers 202 `status: 'proposed'` (`jsonGoverned`).
 */
import { z } from "zod";
import type { Context } from "hono";
import {
  enableWorkerDoor,
  listWorkersDoor,
  runWorkerDoor,
  setWorkerPausedDoor,
  type WorkerDoorOutcome,
} from "../worker-doors.js";
import type { PlaybookDoorIdentity } from "../playbook-doors.js";
import {
  workerModeSchema,
  workerScheduleSchema,
} from "../../../schemas/worker-enable.js";
import { jsonGoverned } from "../proposal-response.js";
import {
  errCode,
  hasScope,
  httpStatusForTrpcError,
  logger,
  readJsonBody,
  requireUuidParam,
  resolveActorId,
  type HubHono,
  type HubVariables,
} from "./_shared.js";

type HubContext = Context<{ Variables: HubVariables }>;

const ListQuery = z
  .object({
    trackId: z.string().uuid().optional(),
    projectId: z.string().uuid().optional(),
  })
  .refine((q) => !!q.trackId || !!q.projectId, {
    message: "trackId (the goal) or projectId is required",
  });

const EnableBody = z
  .object({
    playbookId: z.string().uuid(),
    activatorKey: z.string().trim().min(1).max(500).optional(),
    /** The "How often?" clock instead of a key (`howOftenEnable`). */
    schedule: workerScheduleSchema.optional(),
    /** A chosen clock's mode (default `propose`). */
    mode: workerModeSchema.optional(),
    trackId: z.string().uuid().optional(),
    projectId: z.string().uuid().optional(),
    agentUserId: z.string().optional(),
  })
  .refine((b) => !!b.trackId || !!b.projectId, {
    message: "Enable a worker for a goal (trackId) or a project (projectId).",
  })
  .refine((b) => !b.activatorKey !== !b.schedule, {
    message: "Name the worker: its activatorKey or a schedule.",
  });

const PausedBody = z.object({
  paused: z.boolean(),
  agentUserId: z.string().optional(),
});

const RunBody = z.object({
  reasoning: z.string().max(2000).optional(),
  agentUserId: z.string().optional(),
});

function zodError(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
    .join("; ");
}

function doorIdentity(
  c: HubContext,
  agentUserId: string | undefined
): PlaybookDoorIdentity {
  return {
    userId: c.get("userId"),
    scopes: c.get("scopes"),
    agentUserId,
    sessionId: c.get("sessionId"),
    keyType: c.get("keyType"),
    keyWorkspaceId: c.get("keyWorkspaceId"),
  };
}

/** The agent a write acts as: one the caller may act as, else the key's own. */
async function resolveWriteAgent(
  c: HubContext,
  bodyAgentUserId: string | undefined
): Promise<{ ok: true; agentUserId?: string } | { ok: false; error: string }> {
  const agentUserId = bodyAgentUserId ?? c.get("agentUserId");
  const resolved = await resolveActorId(agentUserId, c.get("userId"));
  if ("error" in resolved) return { ok: false, error: resolved.error };
  return { ok: true, agentUserId };
}

function render<T>(c: HubContext, outcome: WorkerDoorOutcome<T>) {
  switch (outcome.kind) {
    case "result":
      return jsonGoverned(c, outcome.result);
    case "invalid":
      return c.json({ error: outcome.error }, 400);
    case "not_found":
      return c.json({ error: outcome.error }, 404);
    case "missing_workspace":
      return c.json(
        { error: "No workspace resolved for this run — pass workspaceId." },
        400
      );
    case "conflict":
      return c.json(
        {
          error: outcome.error,
          reasonCode: outcome.reasonCode,
          holder: outcome.holder,
        },
        409
      );
  }
}

function errorResponse(c: HubContext, err: unknown, label: string) {
  if (errCode(err) === "PRECONDITION_FAILED") {
    return c.json(
      { error: err instanceof Error ? err.message : "Precondition failed" },
      412
    );
  }
  const status = httpStatusForTrpcError(err);
  if (status === 500) logger.error({ err }, label);
  return c.json(
    { error: err instanceof Error ? err.message : "Unknown error" },
    status
  );
}

export function registerWorkersRoutes(app: HubHono): void {
  app.get("/workers", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const query = ListQuery.safeParse({
      trackId: c.req.query("trackId") || undefined,
      projectId: c.req.query("projectId") || undefined,
    });
    if (!query.success) return c.json({ error: zodError(query.error) }, 400);
    try {
      return render(
        c,
        await listWorkersDoor(doorIdentity(c, c.get("agentUserId")), query.data)
      );
    } catch (err) {
      return errorResponse(c, err, "workers.list failed");
    }
  });

  app.post("/workers", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const read = await readJsonBody(c);
    if (!read.ok) return read.res;
    const parsed = EnableBody.safeParse(read.body);
    if (!parsed.success) return c.json({ error: zodError(parsed.error) }, 400);
    const agent = await resolveWriteAgent(c, parsed.data.agentUserId);
    if (!agent.ok) return c.json({ error: agent.error }, 400);
    try {
      return render(
        c,
        await enableWorkerDoor(doorIdentity(c, agent.agentUserId), {
          playbookId: parsed.data.playbookId,
          ...(parsed.data.activatorKey
            ? { activatorKey: parsed.data.activatorKey }
            : {}),
          ...(parsed.data.schedule ? { schedule: parsed.data.schedule } : {}),
          ...(parsed.data.mode ? { mode: parsed.data.mode } : {}),
          ...(parsed.data.trackId ? { trackId: parsed.data.trackId } : {}),
          ...(parsed.data.projectId
            ? { projectId: parsed.data.projectId }
            : {}),
        })
      );
    } catch (err) {
      return errorResponse(c, err, "workers.enable failed");
    }
  });

  app.post("/workers/:ruleId/paused", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const ruleId = requireUuidParam(c, "ruleId");
    if (ruleId instanceof Response) return ruleId;
    const read = await readJsonBody(c);
    if (!read.ok) return read.res;
    const parsed = PausedBody.safeParse(read.body);
    if (!parsed.success) return c.json({ error: zodError(parsed.error) }, 400);
    const agent = await resolveWriteAgent(c, parsed.data.agentUserId);
    if (!agent.ok) return c.json({ error: agent.error }, 400);
    try {
      return render(
        c,
        await setWorkerPausedDoor(doorIdentity(c, agent.agentUserId), {
          ruleId,
          paused: parsed.data.paused,
        })
      );
    } catch (err) {
      return errorResponse(c, err, "workers.setPaused failed");
    }
  });

  app.post("/workers/:ruleId/run", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const ruleId = requireUuidParam(c, "ruleId");
    if (ruleId instanceof Response) return ruleId;
    const read = await readJsonBody(c);
    if (!read.ok) return read.res;
    const parsed = RunBody.safeParse(read.body);
    if (!parsed.success) return c.json({ error: zodError(parsed.error) }, 400);
    const agent = await resolveWriteAgent(c, parsed.data.agentUserId);
    if (!agent.ok) return c.json({ error: agent.error }, 400);
    try {
      return render(
        c,
        await runWorkerDoor(doorIdentity(c, agent.agentUserId), {
          ruleId,
          ...(parsed.data.reasoning
            ? { reasoning: parsed.data.reasoning }
            : {}),
          source: "hub-rest",
        })
      );
    } catch (err) {
      return errorResponse(c, err, "workers.run failed");
    }
  });
}
