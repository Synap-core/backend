/**
 * Hub Protocol REST — playbooks (list, create, run, session → playbook
 * promotion, definition update)
 *
 * Thin REST seam over the governed playbook procedures so IS / CLI / Raycast /
 * MCP share ONE governed path. List / create / run go through the shared doors
 * in `../playbook-doors.ts` — the same functions MCP `synap_list_playbooks` /
 * `synap_create_playbook` / `synap_run_playbook` call. Every write is gated by
 * `checkPermissionOrPropose` inside the regular procedure — agent callers get
 * `status: 'proposed'`, operators get the executed result.
 */

import { z } from "@hono/zod-openapi";
import type { Context } from "hono";

import type { PlaybookStageInput } from "../../../schemas/playbook-stage.js";
import {
  createPlaybookDoor,
  listPlaybooksDoor,
  runPlaybookDoor,
  type PlaybookDoorIdentity,
  type PlaybookDoorOutcome,
} from "../playbook-doors.js";
import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  confineWorkspaceOrForbidden,
  errCode,
  getCaller,
  hasScope,
  httpStatusForTrpcError,
  isUuid,
  logger,
  resolveActorId,
  type HubHono,
  type HubVariables,
} from "./_shared.js";
import { jsonGoverned } from "../proposal-response.js";

type HubContext = Context<{ Variables: HubVariables }>;

const PlaybookStatusSchema = z.enum(["draft", "active", "paused", "archived"]);

const ListPlaybooksQuerySchema = z.object({
  workspaceId: z
    .string()
    .uuid()
    .optional()
    .describe("Narrows to this workspace (pod-wide playbooks still included)."),
  status: PlaybookStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).optional(),
});

const CreatePlaybookBodySchema = z.object({
  workspaceId: z.string().uuid().describe("The playbook's home workspace."),
  name: z.string().min(1).max(500),
  goalTemplate: z
    .string()
    .min(1)
    .describe("May contain {{param}} placeholders."),
  description: z.string().optional(),
  stages: z.array(z.record(z.string(), z.unknown())).optional(),
  status: PlaybookStatusSchema.optional().describe("Defaults to active."),
  subjectProfile: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "The kind this playbook runs ON, e.g. { profileSlug: 'crm-lead' }. A profileSlug that resolves to no profile is refused."
    ),
  forceCreate: z
    .boolean()
    .optional()
    .describe(
      "Only after a CONFLICT naming an overlapping playbook. Creates anyway."
    ),
  scope: z
    .enum(["session", "project"])
    .optional()
    .describe(
      "session (default) = a template for one focus session; project = a METHOD a project runs as a track."
    ),
  agentUserId: z.string().optional(),
});

const RunPlaybookBodySchema = z.object({
  workspaceId: z
    .string()
    .uuid()
    .optional()
    .describe(
      "Write home for the run. Omit to use the playbook's own workspace (then the subject's)."
    ),
  subjectId: z.string().uuid().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  agentIds: z.array(z.string()).optional(),
  reasoning: z.string().optional(),
  agentUserId: z.string().optional(),
  projectId: z
    .string()
    .uuid()
    .optional()
    .describe("File the run into this project (must be visible to you)."),
  trackId: z
    .string()
    .uuid()
    .optional()
    .describe(
      "File the run inside this track (a method running in a project). Implies its project."
    ),
  trackStage: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe(
      "The stage of that track the run is filed at. Omit for its current stage. Needs trackId."
    ),
});

const PlaybookResultSchema = z.record(z.string(), z.unknown());

function zodError(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
    .join("; ");
}

/** The acting identity, from the verified auth context — never the body. */
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

/**
 * The agent principal for a write: the body may name one, but only an agent the
 * authenticated user can act as (`resolveActorId`). Falls back to the agent key
 * the auth middleware resolved.
 */
async function resolveWriteAgent(
  c: HubContext,
  bodyAgentUserId: string | undefined
): Promise<{ ok: true; agentUserId?: string } | { ok: false; error: string }> {
  const agentUserId = bodyAgentUserId ?? c.get("agentUserId");
  const resolved = await resolveActorId(agentUserId, c.get("userId"));
  if ("error" in resolved) return { ok: false, error: resolved.error };
  return { ok: true, agentUserId };
}

/** REST rendering of a shared playbook-door outcome. */
function renderOutcome<T>(c: HubContext, outcome: PlaybookDoorOutcome<T>) {
  switch (outcome.kind) {
    // The 202-on-proposed rule lives in `jsonGoverned`, not here — this door
    // had the only correct copy of it, and a second copy is how the doors
    // diverged in the first place.
    case "result":
      return jsonGoverned(c, outcome.result);
    case "invalid":
      return c.json(
        {
          error: outcome.error,
          ...(outcome.candidates ? { candidates: outcome.candidates } : {}),
        },
        400
      );
    case "not_found":
      return c.json({ error: outcome.error }, 404);
    case "missing_workspace":
      return c.json(
        {
          error:
            "No workspace resolved for this write — pass workspaceId. A pod-wide playbook has no home of its own.",
        },
        400
      );
  }
}

function errorResponse(c: HubContext, err: unknown, label: string) {
  // A human run of a playbook whose skills are not enabled — the message names
  // them and the Settings pointer; it is a precondition, not a server fault.
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

export function registerPlaybooksRoutes(app: HubHono): void {
  // ── OpenAPI metadata ─────────────────────────────────────────────────────
  registerOpenApi(app, {
    method: "get",
    path: "/playbooks",
    tags: ["Playbooks"],
    summary: "List playbooks",
    description:
      "Playbooks visible to the caller across the pod — every member workspace plus pod-wide templates. Cursor-paginated. Same door as MCP synap_list_playbooks.",
    request: { query: ListPlaybooksQuerySchema },
    responses: {
      200: {
        description: "{ playbooks, nextCursor }",
        schema: z.object({
          playbooks: z.array(PlaybookResultSchema),
          nextCursor: z.string().nullable(),
        }),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/playbooks",
    tags: ["Playbooks"],
    summary: "Create a playbook",
    description:
      "Creates a reusable playbook (staged process template). Governed: an agent caller gets 202 `status: 'proposed'` with a `reviewUrl` — that is success, not an error. Same door as MCP synap_create_playbook.",
    request: { body: CreatePlaybookBodySchema },
    responses: {
      200: {
        description: "Created (or existing by name)",
        schema: PlaybookResultSchema,
      },
      202: { description: "Proposed for review", schema: PlaybookResultSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/playbooks/{id}/run",
    tags: ["Playbooks"],
    summary: "Run a playbook",
    description:
      "Launches a playbook via its executor. Governed: an agent launch gets 202 `status: 'proposed'`. A playbook that depends on skills not enabled yet returns `status: 'blocked'` with `unenabledSkills` and `enableProposals` — nothing ran. Same door as MCP synap_run_playbook.",
    request: {
      params: z.object({ id: z.string().uuid() }),
      body: RunPlaybookBodySchema,
    },
    responses: {
      200: { description: "Running, or blocked", schema: PlaybookResultSchema },
      202: { description: "Proposed for review", schema: PlaybookResultSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Playbook not found", schema: ErrorSchema },
      412: {
        description: "Skills not enabled (human caller)",
        schema: ErrorSchema,
      },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  /**
   * GET /playbooks?workspaceId=&status=&limit=&cursor=
   */
  app.get("/playbooks", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Missing scope: hub-protocol.read required" },
        403
      );
    }
    const parsed = ListPlaybooksQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: zodError(parsed.error) }, 400);
    const confined = confineWorkspaceOrForbidden(c, parsed.data.workspaceId);
    if (!confined.ok) return c.json({ error: confined.error }, 403);
    try {
      const result = await listPlaybooksDoor(
        doorIdentity(c, c.get("agentUserId")),
        {
          workspaceId: confined.workspaceId ?? null,
          status: parsed.data.status,
          limit: parsed.data.limit,
          cursor: parsed.data.cursor,
        }
      );
      return c.json(result);
    } catch (err) {
      return errorResponse(c, err, "playbooks.list failed");
    }
  });

  /**
   * POST /playbooks
   * Body: { workspaceId, name, goalTemplate, description?, stages?, status?,
   *         subjectProfile?, forceCreate?, scope?, agentUserId? }
   */
  app.post("/playbooks", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const parsed = CreatePlaybookBodySchema.safeParse(
      await c.req.json().catch(() => null)
    );
    if (!parsed.success) return c.json({ error: zodError(parsed.error) }, 400);
    const body = parsed.data;
    const confined = confineWorkspaceOrForbidden(c, body.workspaceId);
    if (!confined.ok) return c.json({ error: confined.error }, 403);
    const agent = await resolveWriteAgent(c, body.agentUserId);
    if (!agent.ok) return c.json({ error: agent.error }, 400);
    try {
      const outcome = await createPlaybookDoor(
        doorIdentity(c, agent.agentUserId),
        {
          workspaceId: confined.workspaceId ?? undefined,
          name: body.name,
          goalTemplate: body.goalTemplate,
          description: body.description,
          // Validated for real by `playbooks.create`'s `playbookStagesSchema`.
          stages: body.stages as PlaybookStageInput[] | undefined,
          status: body.status,
          ...(body.subjectProfile
            ? { subjectProfile: body.subjectProfile }
            : {}),
          ...(body.forceCreate ? { forceCreate: true } : {}),
          ...(body.scope ? { scope: body.scope } : {}),
        }
      );
      return renderOutcome(c, outcome);
    } catch (err) {
      return errorResponse(c, err, "playbooks.create failed");
    }
  });

  /**
   * PATCH /playbooks/:id
   * Body: { agentUserId?, source?, reasoning?, name?, description?, goalTemplate?,
   *         params?, inputStrategy?, channelSpec?, expectedOutputs?, stages?,
   *         subjectProfile?, schedule?, executor?, status?, scope? }
   *
   * Governed mirror of `playbooks.update` — the door the
   * analyzer persona uses to submit an evidence-backed definition diff. Never
   * auto-applied for an agent caller: `checkPermissionOrPropose` decides
   * approve-vs-propose from the LOADED playbook's workspace, exactly as the
   * in-app editor's save path does.
   */
  app.patch("/playbooks/:id", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const body = (await c.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body) return c.json({ error: "Invalid JSON in request body" }, 400);
    try {
      const agentUserId =
        (body.agentUserId as string | undefined) ??
        (c.get("agentUserId") as string | undefined);
      const caller = await getCaller(c);
      const result = await caller.playbooks.update({
        // The resolved owner — the acting identity the auth middleware set.
        // Mirrors `promote`; the hub `update` needs it (ctx.userId is not typed
        // on scopedProcedure).
        userId: c.get("userId") as string,
        id: c.req.param("id"),
        agentUserId,
        source: body.source as string | undefined,
        reasoning: body.reasoning as string | undefined,
        name: body.name as string | undefined,
        description: body.description as string | undefined,
        goalTemplate: body.goalTemplate as string | undefined,
        params: body.params as Record<string, unknown>[] | undefined,
        inputStrategy: body.inputStrategy as
          Record<string, unknown> | undefined,
        channelSpec: body.channelSpec as Record<string, unknown> | undefined,
        expectedOutputs: body.expectedOutputs as
          Record<string, unknown>[] | undefined,
        // Validated for real by `playbooks.update`'s `playbookStagesSchema`
        // (category required, keys unique) — this only types the untyped body.
        stages: body.stages as PlaybookStageInput[] | undefined,
        subjectProfile: body.subjectProfile as
          Record<string, unknown> | undefined,
        schedule: body.schedule as string | number | boolean | null | undefined,
        executor: body.executor as
          "is-agent" | "external-agent" | "hybrid" | undefined,
        status: body.status as
          "draft" | "active" | "paused" | "archived" | undefined,
        // `session` | `project` (a METHOD a project runs as a track). Validated
        // for real by `playbooks.update`'s zod enum; this only types the body.
        // It was dropped here, so no Hub caller could make a playbook a method.
        scope: body.scope as "session" | "project" | undefined,
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "playbooks.update failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  });

  /**
   * POST /playbooks/promote-from-session
   * Body: { sessionId }
   */
  app.post("/playbooks/promote-from-session", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const body = (await c.req.json().catch(() => null)) as {
      sessionId?: string;
      name?: string;
      description?: string;
      reasoning?: string;
      sourceMessageId?: string;
    } | null;
    if (!body) return c.json({ error: "Invalid JSON in request body" }, 400);
    if (!body.sessionId) {
      return c.json({ error: "sessionId is required" }, 400);
    }
    try {
      const userId = c.get("userId") as string;
      const agentUserId = c.get("agentUserId") as string | undefined;
      const caller = await getCaller(c, {
        sourceMessageId: body.sourceMessageId,
      });
      const result = await caller.playbooks.promote({
        userId,
        sessionId: body.sessionId,
        name: body.name,
        description: body.description,
        agentUserId,
        reasoning: body.reasoning,
      });
      return jsonGoverned(c, result);
    } catch (err) {
      logger.error({ err }, "playbooks.promote failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  });

  /**
   * POST /playbooks/:id/run
   * Body: { workspaceId?, subjectId?, params?, agentIds?, reasoning?, agentUserId?, projectId?, trackId? }
   */
  app.post("/playbooks/:id/run", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const playbookId = c.req.param("id");
    if (!isUuid(playbookId)) {
      return c.json({ error: `Not a playbook id: ${playbookId}` }, 400);
    }
    const parsed = RunPlaybookBodySchema.safeParse(
      (await c.req.json().catch(() => null)) ?? {}
    );
    if (!parsed.success) return c.json({ error: zodError(parsed.error) }, 400);
    const body = parsed.data;
    const confined = confineWorkspaceOrForbidden(c, body.workspaceId);
    if (!confined.ok) return c.json({ error: confined.error }, 403);
    const agent = await resolveWriteAgent(c, body.agentUserId);
    if (!agent.ok) return c.json({ error: agent.error }, 400);
    try {
      const outcome = await runPlaybookDoor(
        doorIdentity(c, agent.agentUserId),
        {
          workspaceId: confined.workspaceId ?? undefined,
          playbookId,
          subjectId: body.subjectId,
          params: body.params,
          agentIds: body.agentIds,
          reasoning: body.reasoning,
          projectId: body.projectId,
          trackId: body.trackId,
          trackStage: body.trackStage,
          source: "hub-rest",
        }
      );
      return renderOutcome(c, outcome);
    } catch (err) {
      return errorResponse(c, err, "playbooks.run failed");
    }
  });
}
