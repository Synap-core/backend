/**
 * Hub Protocol REST — the design door for an APP (plan 0fc746f4 §2.6, W5).
 *
 *   GET  /designs/catalog  the catalog snapshot (design.catalog), `?appId=`
 *                          for an app's designs (its own kit, W6)
 *   GET  /designs/kit      one code file of an app's kit (`?appId=&part=js|css`)
 *                          as JSON text, checked against the hash its catalog
 *                          pins (W6)
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
  KitBytesMismatchError,
  readKitPart,
} from "../../../services/designs/app-kit.js";
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
    appId: z.string().optional(),
    /** The app's own kit (W6): how the Design app loads and draws it. */
    kit: z
      .object({
        kitId: z.string(),
        hash: z.string(),
        react: z.string(),
        files: z.record(z.string(), z.unknown()),
        canvas: z.unknown(),
      })
      .optional(),
  })
  .openapi("DesignCatalog");

const DesignCatalogQuerySchema = z.object({
  appId: z.string().uuid().optional().openapi({
    description:
      "The app (devplane_app) whose designs to check: its own kit when it names one (`design-kit`), else Synap's.",
  }),
});

/** One code file of an app's kit, as JSON (the Hub's one answer shape): its text and the hash it was checked against. */
const DesignKitFileSchema = z
  .object({
    kitId: z.string(),
    hash: z.string(),
    part: z.enum(["js", "css"]),
    sha256: z.string(),
    bytes: z.number().int(),
    content: z.string(),
  })
  .openapi("DesignKitFile");

const DesignKitQuerySchema = z.object({
  appId: z.string().uuid(),
  part: z.enum(["js", "css"]),
});

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
      "the frame presets. With `appId`, the catalog of that app's designs: " +
      "when the app names its own kit (`design-kit`), the kit's components " +
      "with Synap's canvas blocks, a hash naming both, and `kit` (React " +
      "major, the two code files' sha256, how a dropped block starts). 412 " +
      "when no catalog is installed or the app's kit cannot be read (never " +
      "an empty catalog, never Synap's in place of the app's).",
    request: { query: DesignCatalogQuerySchema },
    responses: {
      200: { description: "The catalog", schema: DesignCatalogSchema },
      400: { description: "Not an app", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "No such app", schema: ErrorSchema },
      412: {
        description: "No catalog installed, or the app's kit cannot be read",
        schema: ErrorSchema,
      },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });
  app.get("/designs/catalog", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read"))
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    const query = DesignCatalogQuerySchema.safeParse({
      appId: c.req.query("appId") || undefined,
    });
    if (!query.success)
      return c.json({ error: "`appId` is not an app id (uuid)." }, 400);
    const acting = await resolveActingContext(c, {});
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    try {
      return c.json(
        await designCatalog(acting.userId, query.data.appId ?? null),
        200
      );
    } catch (err) {
      const f = failure(err);
      if (f.status === 500) logger.error({ err }, "GET /designs/catalog");
      return c.json(f.body, f.status);
    }
  });

  registerOpenApi(app, {
    method: "get",
    path: "/designs/kit",
    tags: ["Designs"],
    summary: "One code file of an app's component kit",
    description:
      "The bytes of an app's kit.js (`part=js`) or kit.css (`part=css`), as " +
      "its catalog (the app's `design-kit` file) names them, for the Design " +
      "app to load on its own origin through its Hub proxy. Read through the " +
      "caller's read floor (the app, then each file). The bytes are checked " +
      "against the sha256 the catalog pins: other bytes are refused (422 " +
      "`DESIGN_KIT_BYTES_MISMATCH`), never served. Answered as JSON " +
      "(`content` is the file's text, `sha256` its pinned hash), never as " +
      "served code, so the pod's origin never runs or applies it; the Design " +
      "app checks the hash again before it loads it. 404 when the app has " +
      "no kit.",
    request: { query: DesignKitQuerySchema },
    responses: {
      200: {
        description: "The file's text and its hash",
        schema: DesignKitFileSchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "No such app, or no kit", schema: ErrorSchema },
      412: { description: "The kit cannot be read", schema: ErrorSchema },
      422: {
        description:
          "The bytes are not the pinned ones (DESIGN_KIT_BYTES_MISMATCH)",
        schema: ErrorSchema,
      },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });
  app.get("/designs/kit", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read"))
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    const query = DesignKitQuerySchema.safeParse({
      appId: c.req.query("appId"),
      part: c.req.query("part"),
    });
    if (!query.success)
      return c.json(
        { error: "`appId` (an app id) and `part` (js or css) are required." },
        400
      );
    const acting = await resolveActingContext(c, {});
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    try {
      const file = await readKitPart(
        acting.userId,
        query.data.appId,
        query.data.part
      );
      // JSON, never the file as served code: the pod's origin cannot run or
      // apply it, and the Design app checks the hash again before it loads it.
      return c.json(
        {
          kitId: file.kitId,
          hash: file.hash,
          part: file.part,
          sha256: file.sha256,
          bytes: file.bytes.length,
          content: file.bytes.toString("utf8"),
        },
        200
      );
    } catch (err) {
      if (err instanceof KitBytesMismatchError)
        return c.json({ error: err.message, code: err.reasonCode }, 422);
      const f = failure(err);
      if (f.status === 500) logger.error({ err }, "GET /designs/kit");
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
