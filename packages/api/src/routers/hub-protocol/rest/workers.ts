/**
 * Hub REST — a GOAL's WORKERS (goals that run, R2). The same shared door the
 * MCP tools call (`../worker-doors.ts`):
 *
 *   GET   /workers?trackId=…            the workers enabled on a goal (strict),
 *                                       each a GoalWorkerView (or ?projectId=…,
 *                                       or ?playbookId=… for every enablement
 *                                       of one playbook); a scoped key's
 *                                       left-out workers come back counted in
 *                                       `withheld` (grant-door-fence
 *                                       LIST_WORKERS)
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
import { z as zo } from "@hono/zod-openapi";
import type { Context } from "hono";
import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
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
    /** The workers a session started (not the caller's attribution). */
    scopeSessionId: z.string().uuid().optional(),
    /**
     * One playbook's workers: every enablement of it, the space-wide one
     * included (a space-scoped worker has no goal or project to list it by).
     */
    playbookId: z.string().uuid().optional(),
  })
  .refine(
    (q) => !!q.trackId || !!q.projectId || !!q.scopeSessionId || !!q.playbookId,
    {
      message:
        "trackId (the goal), projectId, scopeSessionId or playbookId is required",
    }
  );

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
    /**
     * A session the caller owns: its worker's runs are that session's
     * children. Not `sessionId`, the caller's attribution elsewhere.
     */
    scopeSessionId: z.string().uuid().optional(),
    agentUserId: z.string().optional(),
  })
  .refine((b) => !!b.trackId || !!b.projectId || !!b.scopeSessionId, {
    message:
      "Enable a worker for a goal (trackId), a project (projectId) or a session (scopeSessionId).",
  })
  .refine((b) => !b.scopeSessionId || (!b.trackId && !b.projectId), {
    message:
      "A session's worker is filed where the session is: give scopeSessionId alone.",
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

function isDenied(
  result: unknown
): result is { status: "denied"; reason: string } {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { status?: unknown }).status === "denied"
  );
}

function render<T>(c: HubContext, outcome: WorkerDoorOutcome<T>) {
  switch (outcome.kind) {
    case "result":
      // A write the gate refused (the key's grant, the person's role) is a
      // 403, so the Hub's denial middleware adds `code: GRANT_DENIED`, the
      // refused action and, for a pod app that may ask for it, `ask`.
      if (isDenied(outcome.result)) {
        return c.json(
          { error: outcome.result.reason, status: "denied" as const },
          403
        );
      }
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
    case "refused":
      return c.json(
        { error: outcome.error, reasonCode: outcome.reasonCode },
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

/**
 * The wire shape of one worker (`GoalWorkerView`, `@synap-core/types/workers/
 * health`), documented for the clients that read it (a pod app's "Runs on its
 * own"). Passthrough: the type is the contract, this names its fields.
 */
const WorkerViewSchema = zo
  .object({
    ruleId: zo.string(),
    playbookId: zo.string(),
    playbookName: zo.string(),
    activatorKey: zo.string(),
    scope: zo.enum(["space", "project", "session"]),
    mode: zo.string(),
    state: zo.enum(["running", "paused", "stopped"]),
    projectId: zo.string().nullable(),
    trackId: zo.string().nullable(),
    automationId: zo.string().nullable(),
    pendingApprovals: zo.number(),
    maxPendingApprovals: zo.number(),
    trigger: zo.object({
      kind: zo.string(),
      words: zo.string().nullable(),
    }),
    lastRunAt: zo.string().nullable(),
    nextRunAt: zo.string().nullable(),
    health: zo.object({ state: zo.string() }).passthrough(),
  })
  .passthrough()
  .openapi("GoalWorkerView");

const ListWorkersResponseSchema = zo
  .object({
    items: zo.array(WorkerViewSchema),
    withheld: zo
      .object({
        workers: zo.number(),
        needs: zo.array(zo.string()),
      })
      .optional()
      .openapi({
        description:
          "A scoped key's left-out workers: their playbook is one it reads, not their automation and approvals in its space.",
      }),
  })
  .openapi("ListWorkersResponse");

export function registerWorkersRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "get",
    path: "/workers",
    tags: ["Playbooks"],
    summary: "List workers (a goal's, a project's or a playbook's)",
    description:
      "The workers enabled on a goal (trackId, strict), over a project (projectId), " +
      "or of one playbook (playbookId: every enablement, the space-wide one included). " +
      "A scoped key (a pod app) needs playbook.read; it gets a worker only where it also " +
      "reads automation and proposal in the playbook's space, the rest counted in `withheld`.",
    request: {
      query: zo.object({
        trackId: zo.string().uuid().optional(),
        projectId: zo.string().uuid().optional(),
        playbookId: zo.string().uuid().optional(),
      }),
    },
    responses: {
      200: { description: "The workers", schema: ListWorkersResponseSchema },
      400: {
        description: "No filter, or a malformed id",
        schema: ErrorSchema,
      },
      403: {
        description: "Refused by the key's scope or grant",
        schema: ErrorSchema,
      },
      404: {
        description: "The goal is not one you can see",
        schema: ErrorSchema,
      },
    },
  });

  app.get("/workers", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const query = ListQuery.safeParse({
      trackId: c.req.query("trackId") || undefined,
      projectId: c.req.query("projectId") || undefined,
      playbookId: c.req.query("playbookId") || undefined,
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
          ...(parsed.data.scopeSessionId
            ? { scopeSessionId: parsed.data.scopeSessionId }
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
