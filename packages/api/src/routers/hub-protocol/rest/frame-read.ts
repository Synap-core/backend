/**
 * Hub Protocol REST — THE frame read door (Surfaces P6a).
 *
 * POST /frame/read  { surface: {kind:"cell", typeKey} | {kind:"document", id},
 *                     op, params?, workspaceId? }
 *
 * A host that reads the pod over Hub REST (the desktop, relay, a generated
 * app) forwards each `window.synap.query(op, params)` of a frame here. The
 * same function as tRPC `surfaces.frameRead` (`frameRead`,
 * `services/surfaces/frame-read.ts`), as the caller's own user:
 *
 *   200 the read's answer, exactly what the op's procedure returns
 *   400 an op outside `CELL_BRIDGE_READ_OPS` (`FRAME_READ_UNKNOWN_OP`), a
 *       malformed body, or a refusal of the read itself (a missing param)
 *   403 the surface does not declare this read (`FRAME_READ_UNDECLARED`), or
 *       the caller cannot read the space it names
 *   404 the cell type or html page is not found for this caller
 *   5xx a failed read, never an empty answer
 *
 * A POST that READS (`GRANT_REST_POST_READS`, `access/grant-door-fence.ts`):
 * it writes no pod data, only its own log line (`frame_read_log`).
 */

import { z } from "@hono/zod-openapi";

import {
  FRAME_SURFACE_KINDS,
  frameRead,
  FrameReadError,
} from "../../../services/surfaces/frame-read.js";
import { createHubProtocolCallerContext } from "../utils.js";
import type { Context } from "../../../types/context.js";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  confineWorkspaceOrForbidden,
  hasScope,
  httpStatusForTrpcError,
  logger,
  type HubHono,
} from "./_shared.js";

const FrameReadBodySchema = z.object({
  surface: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("cell"), typeKey: z.string().min(1).max(200) }),
    z.object({ kind: z.literal("document"), id: z.string().uuid() }),
  ]),
  op: z.string().min(1).max(64),
  params: z.record(z.string(), z.unknown()).optional(),
  workspaceId: z.string().uuid().nullable().optional(),
});

/** A refusal: the message, and the machine code of the door's refusals. */
const FrameReadErrorSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
});

export function registerFrameReadRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "post",
    path: "/frame/read",
    tags: ["Surfaces"],
    summary: "A framed surface's read, checked against what it declares",
    description:
      'The one frame read door. A host forwards each `window.synap.query(op, params)` of a frame here with the surface the frame draws (`{kind:"cell", typeKey}` or `{kind:"document", id}` for an html page) and its lens (`workspaceId`, used for a cell; a page reads in its own space). ' +
      "The op must be a frame read (`CELL_BRIDGE_READ_OPS`); a read the surface's declared `reads` do not name is refused (403, `code: FRAME_READ_UNDECLARED`); a surface that declares no reads is answered and logged as undeclared. The read runs as the caller, floored to what they may see. Every call is logged. " +
      `Surface kinds: ${FRAME_SURFACE_KINDS.join(", ")}.`,
    request: { body: FrameReadBodySchema },
    responses: {
      200: {
        description: "The read's answer",
        schema: z.unknown(),
      },
      400: { description: "Bad request", schema: FrameReadErrorSchema },
      403: { description: "Forbidden", schema: FrameReadErrorSchema },
      404: { description: "Not found", schema: FrameReadErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.post("/frame/read", async (c) => {
    const scopes = c.get("scopes") as string[];
    if (!hasScope(scopes, "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "Body must be JSON" }, 400);
    }
    const parsed = FrameReadBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        {
          error: parsed.error.issues
            .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
            .join("; "),
        },
        400
      );
    }
    // A key bound to one space reads in that space only.
    const confined = confineWorkspaceOrForbidden(c, parsed.data.workspaceId);
    if (!confined.ok) return c.json({ error: confined.error }, 403);
    const userId = c.get("userId") as string | undefined;
    if (!userId) return c.json({ error: "Unauthenticated" }, 403);
    try {
      const ctx = await createHubProtocolCallerContext(
        userId,
        scopes,
        confined.workspaceId ?? null,
        null,
        null,
        (c.get("agentUserId") as string | undefined) ?? null
      );
      const answer = await frameRead(ctx as Context, {
        surface: parsed.data.surface,
        op: parsed.data.op,
        params: parsed.data.params,
        workspaceId: confined.workspaceId ?? null,
      });
      return c.json(answer as never);
    } catch (err) {
      if (err instanceof FrameReadError) {
        return c.json({ error: err.message, code: err.code }, err.status);
      }
      logger.error({ err, userId }, "frame read failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  });
}
