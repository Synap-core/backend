/**
 * Hub Protocol REST — the design door for an APP (plan 0fc746f4 §2.6, W5).
 *
 *   GET  /designs/catalog  the installed catalog snapshot (design.catalog)
 *   GET  /designs/:id      one design, its board and outline (design.read)
 *   POST /designs/apply    typed ops on a design, or a new one (design.apply)
 *
 * The SAME service as the three capability verbs (`services/designs/
 * design-door.ts`); a second door onto it for the Design app, which signs the
 * PERSON in (`app_person`) with a grant of entity permissions and holds no
 * `capability … run`. Through this door the write is judged where every entity
 * write is: `entities.create` / `entities.update` → `checkPermissionOrPropose`,
 * whose rung 0 checks the key's grant (`entity.ui-design.create` /
 * `.update` in the design's space; a grant without it is a 403 naming it),
 * then the caller's own rung: the person's token applies as the person may, an
 * agent's key is governed as that agent (its posture, its proposals). The
 * capability gate is not in front of it, so nothing here forces a review the
 * entity door would not (`mustPropose` is never set): an agent that wants the
 * capability gate's governance runs the verb.
 *
 * Replies: `applied` / `created` / `revised` / `proposed` 200 (the body's
 * `status` says which), a refused batch 422 `code: DESIGN_OP_REFUSED` and a
 * design changed since it was read 409 `code: DESIGN_CHANGED`, each with the
 * door's reply as the body (the op index, the reasons, the catalog hash; the
 * design's current `updatedAt`). 4xx on purpose: the error egress redacts a
 * 5xx body, and these are answers the caller acts on. No catalog installed is
 * a 412 that says how to install it, never an empty catalog.
 */
import { z } from "@hono/zod-openapi";

import {
  applyDesign,
  designCatalog,
  readDesign,
} from "../../../services/designs/design-door.js";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  errCode,
  hasScope,
  httpStatusForTrpcError,
  logger,
  resolveActingContext,
  type HubHono,
} from "./_shared.js";

const ApplyDesignRequestSchema = z
  .object({
    designId: z.string().uuid().optional(),
    baseUpdatedAt: z.string().min(1).optional(),
    ops: z.array(z.record(z.string(), z.unknown())).min(1).max(200),
    acceptDrops: z.boolean().optional(),
  })
  .strict()
  .openapi("ApplyDesignRequest");

/** The door's reply, as the verb returns it (`ApplyDesignReply`). */
const ApplyDesignReplySchema = z
  .object({
    status: z.enum([
      "applied",
      "created",
      "revised",
      "proposed",
      "refused",
      "conflict",
    ]),
  })
  .passthrough()
  .openapi("ApplyDesignReply");

const DesignCatalogSchema = z
  .object({
    kitId: z.string(),
    hash: z.string(),
    components: z.record(z.string(), z.unknown()),
    layout: z.record(z.string(), z.unknown()),
    grid: z.record(z.string(), z.unknown()),
    frames: z.unknown(),
    generatedAt: z.string().optional(),
  })
  .openapi("DesignCatalog");

const DesignReadSchema = z
  .object({
    design: z.record(z.string(), z.unknown()),
    board: z.unknown(),
    frames: z.array(z.unknown()),
    migrated: z.boolean(),
    dropped: z.array(z.unknown()),
    droppedText: z.array(z.string()),
    catalog: z.record(z.string(), z.unknown()),
  })
  .openapi("DesignRead");

/** A refusal of the design door (or the entity door behind it), as HTTP. */
function failure(err: unknown) {
  const status =
    errCode(err) === "UNPROCESSABLE_CONTENT"
      ? (422 as const)
      : httpStatusForTrpcError(err);
  return {
    status,
    body: {
      error: err instanceof Error ? err.message : "Unknown error",
      ...(errCode(err) ? { code: errCode(err) } : {}),
    },
  };
}

export function registerDesignsRoutes(app: HubHono): void {
  // Static paths before `/designs/:id` (Hono matches in order).
  registerOpenApi(app, {
    method: "get",
    path: "/designs/catalog",
    tags: ["Designs"],
    summary: "The design catalog the pod checks designs against",
    description:
      "The installed `design` capability's catalog snapshot: the kit " +
      "(`kitId`, `hash`), its components and their props, the canvas blocks " +
      "(`layout`), the grid (12 / 8 / 4 columns, breakpoints 600 / 1024) and " +
      "the frame presets. 412 when no catalog is installed (never an empty " +
      "catalog).",
    responses: {
      200: { description: "The catalog", schema: DesignCatalogSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      412: { description: "No catalog installed", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });
  app.get("/designs/catalog", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read"))
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    try {
      return c.json(await designCatalog(), 200);
    } catch (err) {
      const f = failure(err);
      if (f.status === 500) logger.error({ err }, "GET /designs/catalog");
      return c.json(f.body, f.status);
    }
  });

  registerOpenApi(app, {
    method: "post",
    path: "/designs/apply",
    tags: ["Designs"],
    summary: "Change a design (or create one) through typed ops",
    description:
      "The ops of design.apply, applied in order, all or nothing, checked " +
      "against the installed catalog. `designId` + `baseUpdatedAt` (the " +
      "`updatedAt` GET /designs/:id returned) change a design; no `designId` " +
      "and a first op `create_design` make one. The write goes through the " +
      "entity door with the caller's own governance and the key's grant " +
      "(`entity.ui-design.update` / `.create`). 200 applied / created / " +
      "revised (a design past its review becomes a new draft revision) / " +
      "proposed (`status` says which), 409 `DESIGN_CHANGED` changed since it " +
      "was read (`updatedAt` is its time now), 422 `DESIGN_OP_REFUSED` " +
      "(`opIndex`, `reasons`, `catalogHash`), 403 the grant does not allow " +
      "it, 412 no catalog installed.",
    request: { body: ApplyDesignRequestSchema },
    responses: {
      200: {
        description: "Applied, created, revised or proposed",
        schema: ApplyDesignReplySchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "No such design", schema: ErrorSchema },
      409: {
        description: "Changed since read",
        schema: ApplyDesignReplySchema,
      },
      412: { description: "No catalog installed", schema: ErrorSchema },
      422: { description: "Refused", schema: ApplyDesignReplySchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });
  app.post("/designs/apply", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write"))
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = ApplyDesignRequestSchema.safeParse(raw);
    if (!parsed.success)
      return c.json(
        {
          error: "Invalid request",
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        },
        400
      );
    const acting = await resolveActingContext(c, {});
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    try {
      const reply = await applyDesign(
        {
          userId: acting.userId,
          workspaceId: null,
          agentUserId: (c.get("agentUserId") as string | undefined) ?? null,
        },
        parsed.data
      );
      if (reply.status === "refused")
        return c.json({ code: "DESIGN_OP_REFUSED", ...reply }, 422);
      if (reply.status === "conflict")
        return c.json({ code: "DESIGN_CHANGED", ...reply }, 409);
      return c.json(reply, 200);
    } catch (err) {
      const f = failure(err);
      if (f.status === 500) logger.error({ err }, "POST /designs/apply");
      return c.json(f.body, f.status);
    }
  });

  registerOpenApi(app, {
    method: "get",
    path: "/designs/{id}",
    tags: ["Designs"],
    summary: "Read one design",
    description:
      "design.read: the design (status, `updatedAt` to send back as " +
      "`baseUpdatedAt`, appId, whether it may be edited), its board, an " +
      "outline per frame (width class, columns, block ids and types) and what " +
      "the installed catalog cannot place (`dropped`). Read through the " +
      "key's grant: a design it does not reach is a 404.",
    request: { params: z.object({ id: z.string().uuid() }) },
    responses: {
      200: { description: "The design", schema: DesignReadSchema },
      400: { description: "Not a design", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "No such design", schema: ErrorSchema },
      412: { description: "Not a canvas yet", schema: ErrorSchema },
      422: { description: "Unreadable board", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });
  app.get("/designs/:id", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read"))
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success)
      return c.json({ error: "`id` is not a design id (uuid)." }, 400);
    const acting = await resolveActingContext(c, {});
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    try {
      return c.json(
        await readDesign({ userId: acting.userId, workspaceId: null }, id),
        200
      );
    } catch (err) {
      const f = failure(err);
      if (f.status === 500) logger.error({ err }, "GET /designs/:id");
      return c.json(f.body, f.status);
    }
  });
}
