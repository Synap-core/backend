/**
 * Hub Protocol REST — guidelines (the agent READ door for work guidelines)
 *
 * An approved `governance.work_guideline` stores a `config_settings` guideline
 * scoped `workKind = <blockedReason>`. This is where an agent consults it —
 * BEFORE handing a slot to the human — instead of having it injected. The
 * `focus-sessions` skill teaches the call; the block doors carry the same
 * lookup as a safety net (`services/focus-sessions/block-guidelines.ts`).
 *
 * ONE lookup: `findWorkGuidelines` → `resolveGuidelines({ workKind })`. No
 * second matcher lives here.
 *
 * Read-only and informational: a guideline never votes in governance and never
 * retires a slot.
 *
 * Routes:
 *   GET /guidelines?workKind=<BLOCKED_REASONS>&workspaceId=<uuid?>
 */

import { z } from "@hono/zod-openapi";
import { BLOCKED_REASONS } from "@synap/playbooks";

import { findWorkGuidelines } from "../../../services/focus-sessions/block-guidelines.js";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  hasScope,
  logger,
  resolveActingContext,
  type HubHono,
} from "./_shared.js";

const GuidelinesQuerySchema = z.object({
  /** The kind of block — one of `BLOCKED_REASONS`, the rung's closed vocabulary. */
  workKind: z.enum(BLOCKED_REASONS),
  /** The workspace lens. Omitted ⇒ only the caller's own pod-wide guidelines. */
  workspaceId: z.string().uuid().optional(),
});

export function registerGuidelinesRoutes(app: HubHono) {
  registerOpenApi(app, {
    method: "get",
    path: "/guidelines",
    tags: ["Guidelines"],
    summary: "Standing guidelines for a kind of blocked work",
    description:
      "Returns the approved guidelines scoped to one `workKind` (a " +
      "BLOCKED_REASONS token) in the caller's lens. Call it BEFORE handing a " +
      "slot to the human: a guideline may say how to proceed without one. " +
      "Informational only — it never changes governance and never retires a slot.",
    request: { query: GuidelinesQuerySchema },
    responses: {
      200: {
        description: "Matching guidelines (possibly none)",
        schema: z.object({
          workKind: z.enum(BLOCKED_REASONS),
          guidelines: z.array(z.object({ id: z.string(), text: z.string() })),
        }),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.get("/guidelines", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const parsed = GuidelinesQuerySchema.safeParse({
      workKind: c.req.query("workKind"),
      workspaceId: c.req.query("workspaceId"),
    });
    if (!parsed.success) {
      return c.json(
        { error: "Invalid query", details: parsed.error.flatten() },
        400
      );
    }
    const acting = await resolveActingContext(c, {
      workspaceId: parsed.data.workspaceId,
    });
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);

    try {
      const guidelines = await findWorkGuidelines({
        userId: acting.userId,
        workspaceId: acting.workspaceId,
        blockedReason: parsed.data.workKind,
      });
      return c.json({ workKind: parsed.data.workKind, guidelines });
    } catch (err) {
      // A failed read is an ERROR, never an empty list: "no guideline" would
      // tell the agent to block when a guideline may say otherwise.
      logger.error({ err }, "guidelines.list failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
