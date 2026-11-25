/**
 * Hub Protocol REST — the surface find (Surfaces wave P1).
 *
 * GET /surfaces?kind=<anchor kind>&id=<anchor id>[&workspaceId=]
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
import {
  ANCHOR_KINDS,
  SURFACE_BODIES,
  SURFACE_RELATIONS,
} from "@synap-core/types/surfaces";

import { AccessContext } from "../../../access/context.js";
import { surfacesForObject } from "../../../services/surfaces/for-object.js";
import { getConfinedWorkspace } from "../confine-workspace.js";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  hasScope,
  httpStatusForTrpcError,
  logger,
  type HubHono,
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
}
