/**
 * Hub Protocol REST — a frame's context (frame contract v3).
 *
 * GET /surfaces/context?kind=&id=[&projectId][&theme][&locale]
 *
 * What a frame anchored to `{kind, id}` is about — the anchor, its space,
 * project and goal — and the project's brand as frame CSS, for a host that
 * reads the pod over Hub REST (the desktop, a generated app). The same
 * function as tRPC `surfaces.context` (`resolveSurfaceContext`), as the
 * caller's own user.
 *
 *   200 the `SurfaceContext` (`brand: null` when the anchor has no project or
 *       its project no brand: not a failure)
 *   404 the anchor does not exist, or the caller cannot read it
 *   5xx a failed read, never an empty context
 *
 * A scoped (fenced) key passes only when one of its scopes reads every
 * subject the route reads, unpinned (`GRANT_REST_GET_READS`,
 * `access/grant-door-fence.ts`).
 */

import { z } from "@hono/zod-openapi";

import {
  resolveSurfaceContext,
  SURFACE_CONTEXT_ANCHOR_KINDS,
} from "../../../services/surfaces/surface-context.js";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  hasScope,
  httpStatusForTrpcError,
  logger,
  resolveActingContext,
  type HubHono,
} from "./_shared.js";

const SurfaceContextQuerySchema = z.object({
  kind: z.enum(SURFACE_CONTEXT_ANCHOR_KINDS),
  id: z.string().uuid(),
  projectId: z.string().uuid().optional(),
  theme: z.enum(["light", "dark"]).optional(),
  locale: z
    .string()
    .regex(/^[a-z]{2}(-[A-Za-z]{2})?$/)
    .optional(),
});

const SurfaceContextResponseSchema = z.object({
  anchor: z.object({ kind: z.string(), id: z.string() }).nullable(),
  workspaceId: z.string().nullable(),
  projectId: z.string().nullable(),
  goalId: z.string().nullable(),
  filters: z.record(z.string(), z.unknown()),
  brand: z
    .object({ id: z.string(), hash: z.string(), css: z.string() })
    .nullable(),
  locale: z.string(),
  theme: z.enum(["light", "dark"]),
});

export function registerSurfaceContextRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "get",
    path: "/surfaces/context",
    tags: ["Surfaces"],
    summary: "What a frame anchored to an object is about, and its brand",
    description:
      "The context a host hands a frame (frame contract v3, " +
      "`window.synap.context()`): the anchor, its space, project and goal, " +
      "and the project's brand as `--synap-*` CSS to write after the host's " +
      "tokens. `brand` is null when the anchor has no project or its project " +
      "no brand. 404 when the caller cannot read the anchor; a failed read is " +
      "a 5xx, never an empty context.",
    request: { query: SurfaceContextQuerySchema },
    responses: {
      200: { description: "The context", schema: SurfaceContextResponseSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.get("/surfaces/context", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const parsed = SurfaceContextQuerySchema.safeParse({
      kind: c.req.query("kind") || undefined,
      id: c.req.query("id") || undefined,
      projectId: c.req.query("projectId") || undefined,
      theme: c.req.query("theme") || undefined,
      locale: c.req.query("locale") || undefined,
    });
    if (!parsed.success) {
      return c.json(
        { error: "Invalid query", details: parsed.error.flatten() },
        400
      );
    }
    const acting = await resolveActingContext(c, {});
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);

    const { kind, id, projectId, theme, locale } = parsed.data;
    try {
      const result = await resolveSurfaceContext({
        userId: acting.userId,
        agentUserId: c.get("agentUserId") ?? null,
        anchor: { kind, id },
        projectId,
        theme,
        locale,
      });
      if (!result.ok) {
        return c.json(
          { error: "Nothing to show here: this object was not found." },
          404
        );
      }
      return c.json(result.context);
    } catch (err) {
      logger.error({ err }, "surfaces.context failed");
      const status = httpStatusForTrpcError(err);
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        // A failed read must never look like "not found".
        status === 404 ? 500 : status
      );
    }
  });
}
