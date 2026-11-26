/**
 * Hub Protocol REST — the surface find and the surface writes.
 *
 * GET /surfaces?kind=<anchor kind>&id=<anchor id>[&workspaceId=]
 * GET /surfaces/inspect?kind=cell|document|view&id=|typeKey=[&workspaceId=&days=]
 *                             what one framed surface does (`inspectSurface`)
 * POST /surfaces              make a surface FOR an object (`surface/create`)
 * POST /surfaces/attach       put an existing surface on it (`surface/attach`)
 * DELETE /surfaces/attach     take it off (`surface/detach`)
 *
 * The writes call the one service tRPC and MCP call
 * (`services/surfaces/attach.ts`, `create.ts`): both ends floored for the
 * acting person, governed in the anchor's space; an agent key's write files a
 * proposal (`{status:'proposed', proposalId}`, 202).
 *
 * Every surface ONE object carries: its kind's renderers, its body document,
 * views pinned to it, its home or start page, session outputs and Sites
 * (`services/surfaces/for-object.ts`, the same read as tRPC
 * `surfaces.forObject` and MCP `synap_find_surfaces`).
 *
 *   200 `{ rows: SurfaceRow[], unavailable: {source, error}[] }` — a store that
 *       could not be read is named in `unavailable`, never folded into `rows`.
 *   404 the anchor does not exist or the caller cannot see it.
 *   400 an unknown kind or a malformed workspaceId; 403 without
 *       `hub-protocol.read`. A workspace-bound key is pinned to its space.
 */

import { z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  ANCHOR_KINDS,
  ATTACHABLE_SURFACE_TYPES,
  ATTACHMENT_LABEL_MAX,
  CREATABLE_SURFACE_BODIES,
  SURFACE_BODIES,
  SURFACE_RELATIONS,
} from "@synap-core/types/surfaces";
import {
  attachSurface,
  detachSurface,
  type SurfaceActor,
} from "../../../services/surfaces/attach.js";
import { createSurface } from "../../../services/surfaces/create.js";
import { jsonGoverned } from "../proposal-response.js";
import { resolveVerifiedSessionId } from "../_middleware/session.js";

import { AccessContext } from "../../../access/context.js";
import { surfacesForObject } from "../../../services/surfaces/for-object.js";
import {
  INSPECT_SURFACE_KINDS,
  inspectSurface,
} from "../../../services/surfaces/inspect.js";
import { getConfinedWorkspace } from "../confine-workspace.js";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  hasScope,
  httpStatusForTrpcError,
  logger,
  resolveActingContext,
  resolveActorId,
  type HubHono,
  type HubVariables,
} from "./_shared.js";

const SurfacesQuerySchema = z.object({
  kind: z.enum(ANCHOR_KINDS),
  id: z.string().min(1).max(200),
  workspaceId: z.string().uuid().optional(),
});

const AnchorSchema = z.object({
  kind: z.enum(ANCHOR_KINDS),
  id: z.string(),
});

const SurfaceRowSchema = z.object({
  id: z.string(),
  body: z.enum(SURFACE_BODIES),
  relation: z.enum(SURFACE_RELATIONS),
  anchor: AnchorSchema,
  title: z.string(),
  viewType: z.string().optional(),
  cellKey: z.string().optional(),
  slot: z.string().optional(),
  openUrl: z.string(),
  readOnly: z.boolean(),
  source: z.string(),
});

const SurfacesResponseSchema = z.object({
  rows: z.array(SurfaceRowSchema),
  unavailable: z.array(z.object({ source: z.string(), error: z.string() })),
});

const InspectQuerySchema = z.object({
  kind: z.enum(INSPECT_SURFACE_KINDS),
  id: z.string().uuid().optional(),
  typeKey: z.string().min(1).max(200).optional(),
  workspaceId: z.string().uuid().optional(),
  days: z.coerce.number().int().min(1).max(30).optional(),
});

const InspectSectionSchema = z
  .object({
    status: z.enum(["ok", "unavailable"]),
    reason: z.string().optional(),
  })
  .passthrough();

const InspectResponseSchema = z.object({
  surface: z.object({
    kind: z.enum(INSPECT_SURFACE_KINDS),
    id: z.string().nullable(),
    typeKey: z.string().nullable(),
    title: z.string(),
    workspaceId: z.string().nullable(),
    cellKeys: z.array(z.string()).optional(),
  }),
  reads: InspectSectionSchema,
  tokens: InspectSectionSchema,
  a11y: InspectSectionSchema,
  render: z.object({ status: z.literal("unavailable"), reason: z.string() }),
});

const WriteAnchorSchema = z.object({
  kind: z.enum(ANCHOR_KINDS),
  id: z.string().uuid(),
});
const SurfaceRefSchema = z.object({
  type: z.enum(ATTACHABLE_SURFACE_TYPES),
  id: z.string().uuid(),
});
const WriteCommon = {
  userId: z.string().optional(),
  agentUserId: z.string().uuid().optional(),
  reasoning: z.string().max(2000).optional(),
  sessionId: z.string().optional(),
};

const CreateSurfaceBodySchema = z.object({
  anchor: WriteAnchorSchema,
  body: z.enum(CREATABLE_SURFACE_BODIES),
  title: z.string().min(1).max(200),
  spec: z
    .object({
      viewType: z.string().max(40).optional(),
      config: z.record(z.string(), z.unknown()).optional(),
      content: z.string().optional(),
      url: z.string().url().optional(),
      cellKey: z.string().max(200).optional(),
      props: z.record(z.string(), z.unknown()).optional(),
      // html only: what its frame reads (`readDeclaredFrameIo` checks it).
      reads: z.array(z.unknown()).nullable().optional(),
      workspaceId: z.string().uuid().optional(),
    })
    .optional(),
  slot: z.string().max(40).optional(),
  label: z.string().max(ATTACHMENT_LABEL_MAX).optional(),
  ...WriteCommon,
});

const AttachSurfaceBodySchema = z.object({
  anchor: WriteAnchorSchema,
  surface: SurfaceRefSchema,
  slot: z.string().max(40).optional(),
  label: z.string().max(ATTACHMENT_LABEL_MAX).optional(),
  position: z.number().int().min(0).optional(),
  ...WriteCommon,
});

const DetachSurfaceBodySchema = z.object({
  anchor: WriteAnchorSchema,
  surface: SurfaceRefSchema,
  ...WriteCommon,
});

const WriteResponseSchema = z.object({ status: z.string() }).passthrough();

type HubContext = Context<{ Variables: HubVariables }>;

/**
 * Who acts: the authenticated person, governed as the key's agent when there
 * is one (`body.agentUserId ?? c.get("agentUserId")`), filed under the
 * caller's verified session.
 */
async function surfaceActor(
  c: HubContext,
  body: {
    userId?: string;
    agentUserId?: string;
    reasoning?: string;
    sessionId?: string;
  },
  door: string
): Promise<
  | { ok: true; actor: SurfaceActor }
  | { ok: false; status: 400 | 403; error: string }
> {
  const acting = await resolveActingContext(c, { userId: body.userId });
  if (!acting.ok) return acting;
  const agentUserId =
    body.agentUserId ?? (c.get("agentUserId") as string | undefined);
  const resolved = await resolveActorId(agentUserId, acting.userId);
  if ("error" in resolved)
    return { ok: false, status: 400, error: resolved.error };
  const sessionId =
    (await resolveVerifiedSessionId(
      acting.userId,
      c.get("sessionId") as string | undefined,
      body.sessionId
    )) ?? null;
  return {
    ok: true,
    actor: {
      userId: acting.userId,
      agentUserId: resolved.actorId !== acting.userId ? resolved.actorId : null,
      sessionId,
      ...(body.reasoning?.trim() ? { reasoning: body.reasoning.trim() } : {}),
      door,
    },
  };
}

/** One answer shape for every write: refused/denied → error, proposed → 202. */
function answer(c: HubContext, result: { status: string }) {
  const outcome = result as unknown as Record<string, unknown>;
  switch (outcome.status) {
    case "refused":
      return c.json(
        { error: outcome.error as string },
        outcome.httpStatus as 400 | 403 | 404
      );
    case "denied":
      return c.json({ error: outcome.reason as string }, 403);
    case "proposed":
      return jsonGoverned(c, {
        status: "proposed",
        proposalId: outcome.proposalId as string,
        reviewPath: outcome.reviewPath as string | undefined,
        reviewUrl: outcome.reviewUrl as string | undefined,
      });
    default:
      return c.json(outcome);
  }
}

const WRITE_RESPONSES = {
  200: { description: "Written", schema: WriteResponseSchema },
  202: { description: "Proposed for review", schema: WriteResponseSchema },
  400: { description: "Bad request", schema: ErrorSchema },
  403: { description: "Forbidden", schema: ErrorSchema },
  404: { description: "No such object or surface", schema: ErrorSchema },
  500: { description: "Internal error", schema: ErrorSchema },
} as const;

export function registerSurfacesRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "get",
    path: "/surfaces",
    tags: ["Surfaces"],
    summary: "Every surface one object carries",
    description:
      "Find every Surface an object carries before you make one: its kind's " +
      "renderers (renders), its body document, views pinned to it, its home " +
      "or start page, session outputs and Sites. Pass the anchor `kind` " +
      "(entity, profile, workspace, project, track, playbook, session) and " +
      "`id` (a profile also by its slug). A store that could not be read is " +
      "listed under `unavailable`: that is not 'nothing there'. 404 when the " +
      "anchor does not exist or you cannot see it.",
    request: { query: SurfacesQuerySchema },
    responses: {
      200: { description: "The surfaces", schema: SurfacesResponseSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "No such anchor", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.get("/surfaces", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const parsed = SurfacesQuerySchema.safeParse({
      kind: c.req.query("kind") || undefined,
      id: c.req.query("id") || undefined,
      workspaceId: c.req.query("workspaceId") || undefined,
    });
    if (!parsed.success) {
      return c.json(
        { error: "Invalid query", details: parsed.error.flatten() },
        400
      );
    }
    const { kind, id, workspaceId } = parsed.data;
    try {
      const found = await surfacesForObject(
        {
          userId: c.get("userId") as string,
          access: AccessContext.agent({
            userId: c.get("userId") as string,
            agentUserId: c.get("agentUserId") as string | undefined,
          }),
        },
        // A workspace-bound key reads its own space only.
        { kind, id, workspaceId: getConfinedWorkspace(c, workspaceId) ?? null }
      );
      return c.json(found);
    } catch (err) {
      const status = httpStatusForTrpcError(err);
      if (status >= 500) logger.error({ err }, "surfaces.forObject failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        status
      );
    }
  });

  registerOpenApi(app, {
    method: "get",
    path: "/surfaces/inspect",
    tags: ["Surfaces"],
    summary: "Inspect one framed surface",
    description:
      "Before you hand a surface over, read what it does: `kind` cell (by " +
      "`typeKey`, or a cell instance `id`), document (an HTML page `id`) or " +
      "view (`id`: the cells it places). Four sections, each " +
      "`{status:'ok', …}` or `{status:'unavailable', reason}`: `reads` (what " +
      "the frame read door logged in the last `days` days, at most 30: ops " +
      "used, refused, declared but unused, asked but undeclared), `tokens` " +
      "(hard-coded colours and fonts, each with its line and the token to " +
      "use), `a11y` (static HTML accessibility lint) and `render` (always " +
      "unavailable on the pod: no browser). 404 when the surface does not " +
      "exist or you cannot see it.",
    request: { query: InspectQuerySchema },
    responses: {
      200: { description: "The inspection", schema: InspectResponseSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "No such surface", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.get("/surfaces/inspect", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const parsed = InspectQuerySchema.safeParse({
      kind: c.req.query("kind") || undefined,
      id: c.req.query("id") || undefined,
      typeKey: c.req.query("typeKey") || undefined,
      workspaceId: c.req.query("workspaceId") || undefined,
      days: c.req.query("days") || undefined,
    });
    if (!parsed.success) {
      return c.json(
        { error: "Invalid query", details: parsed.error.flatten() },
        400
      );
    }
    const { kind, id, typeKey, workspaceId, days } = parsed.data;
    if (!id && !(kind === "cell" && typeKey)) {
      return c.json(
        { error: "Pass the surface's id (or a cell's typeKey)." },
        400
      );
    }
    const userId = c.get("userId") as string;
    const agentUserId = c.get("agentUserId") as string | undefined;
    try {
      const inspection = await inspectSurface(
        {
          userId,
          access: AccessContext.agent({ userId, agentUserId }),
          agentUserId,
          // A bound key inspects a surface of its own space only.
          keyWorkspaceId:
            (c.get("keyWorkspaceId") as string | null | undefined) ?? null,
        },
        {
          surface: { kind, id, typeKey },
          // A workspace-bound key reads its own space only.
          workspaceId: getConfinedWorkspace(c, workspaceId) ?? null,
          days,
        }
      );
      return c.json(inspection);
    } catch (err) {
      const status = httpStatusForTrpcError(err);
      if (status >= 500) logger.error({ err }, "surfaces.inspect failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        status
      );
    }
  });

  registerOpenApi(app, {
    method: "post",
    path: "/surfaces",
    tags: ["Surfaces"],
    summary: "Make a surface for one object",
    description:
      "Create UI for ONE object, anchored to it: the body (view, bento, " +
      "whiteboard, document, html, cell) and its `attaches` link, in one " +
      "governed act. Find first (GET /surfaces); never twin. An agent's " +
      "create is a proposal. Returns `{status:'created', surface, openUrl}` " +
      "(`/open/<kind>/<id>?surface=<id>`) or `{status:'proposed', proposalId}`.",
    request: { body: CreateSurfaceBodySchema },
    responses: WRITE_RESPONSES,
  });
  app.post("/surfaces", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = CreateSurfaceBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: `Invalid surface: ${parsed.error.message}` }, 400);
    }
    const who = await surfaceActor(c, parsed.data, "POST /surfaces");
    if (!who.ok) return c.json({ error: who.error }, who.status);
    try {
      return answer(c, await createSurface(who.actor, parsed.data));
    } catch (err) {
      // A refusal the caller can act on (not found, forbidden, conflict)
      // keeps its status and words; only an unknown error is a 500.
      const status = httpStatusForTrpcError(err);
      if (status >= 500) logger.error({ err }, "POST /surfaces failed");
      return c.json(
        {
          error:
            status >= 500 || !(err instanceof Error)
              ? "Could not make the surface"
              : err.message,
        },
        status
      );
    }
  });

  registerOpenApi(app, {
    method: "post",
    path: "/surfaces/attach",
    tags: ["Surfaces"],
    summary: "Put an existing surface on one object",
    description:
      "Attach a view, bento, whiteboard, document, HTML artifact or cell " +
      "instance to one more object (an `attaches` link; metadata " +
      "{position, slot?, label?}). Both must be visible to you. An agent's " +
      "attach is a proposal.",
    request: { body: AttachSurfaceBodySchema },
    responses: WRITE_RESPONSES,
  });
  app.post("/surfaces/attach", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = AttachSurfaceBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: `Invalid attachment: ${parsed.error.message}` },
        400
      );
    }
    const who = await surfaceActor(c, parsed.data, "POST /surfaces/attach");
    if (!who.ok) return c.json({ error: who.error }, who.status);
    try {
      return answer(c, await attachSurface(who.actor, parsed.data));
    } catch (err) {
      // A refusal the caller can act on (not found, forbidden, conflict)
      // keeps its status and words; only an unknown error is a 500.
      const status = httpStatusForTrpcError(err);
      if (status >= 500) logger.error({ err }, "POST /surfaces/attach failed");
      return c.json(
        {
          error:
            status >= 500 || !(err instanceof Error)
              ? "Could not attach the surface"
              : err.message,
        },
        status
      );
    }
  });

  registerOpenApi(app, {
    method: "delete",
    path: "/surfaces/attach",
    tags: ["Surfaces"],
    summary: "Take a surface off one object",
    description:
      "Remove the `attaches` link between an object and a surface; the " +
      "surface itself stays. `absent` when nothing was attached there. An " +
      "agent's detach is a proposal.",
    request: { body: DetachSurfaceBodySchema },
    responses: WRITE_RESPONSES,
  });
  app.delete("/surfaces/attach", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = DetachSurfaceBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: `Invalid detach: ${parsed.error.message}` }, 400);
    }
    const who = await surfaceActor(c, parsed.data, "DELETE /surfaces/attach");
    if (!who.ok) return c.json({ error: who.error }, who.status);
    try {
      return answer(c, await detachSurface(who.actor, parsed.data));
    } catch (err) {
      // A refusal the caller can act on (not found, forbidden, conflict)
      // keeps its status and words; only an unknown error is a 500.
      const status = httpStatusForTrpcError(err);
      if (status >= 500)
        logger.error({ err }, "DELETE /surfaces/attach failed");
      return c.json(
        {
          error:
            status >= 500 || !(err instanceof Error)
              ? "Could not detach the surface"
              : err.message,
        },
        status
      );
    }
  });
}
