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
 * DATA-TYPE guidelines (0258): the same route answers "what applies when
 * structuring this kind of input / these kinds of entity?" through the same
 * resolver, returning `{id, version}` so an external agent can record which
 * versions it applied. A `workKind`-only call is byte-for-byte the response it
 * always was (the IS `get_work_guidelines` tool depends on it).
 *
 * Routes:
 *   GET /guidelines?workKind=<BLOCKED_REASONS>&workspaceId=<uuid?>
 *   GET /guidelines?sourceKind=<kind>&entityKind=<slug,slug>&workspaceId=<uuid?>
 *   GET /guidelines/:id/history
 */

import { z } from "@hono/zod-openapi";
import { BLOCKED_REASONS } from "@synap/playbooks";
import {
  db,
  getWorkspaceMembership,
  listGuidelineHistory,
  resolveGuidelines,
} from "@synap/database";

import { findWorkGuidelines } from "../../../services/focus-sessions/block-guidelines.js";
import { isGuidelineSourceKind } from "../../../services/guidelines/source-kind.js";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  hasScope,
  logger,
  resolveActingContext,
  type HubHono,
} from "./_shared.js";

const GuidelinesQuerySchema = z
  .object({
    /** The kind of block — one of `BLOCKED_REASONS`, the rung's closed vocabulary. */
    workKind: z.enum(BLOCKED_REASONS).optional(),
    /** The kind of input being structured (`text|url|image|file|audio|import:<source>`). */
    sourceKind: z
      .string()
      .optional()
      .refine((v) => v === undefined || isGuidelineSourceKind(v), {
        message:
          "sourceKind must be text | url | image | file | audio | import:<source>",
      }),
    /** Comma-separated profile slugs in play. */
    entityKind: z.string().optional(),
    /** The workspace lens. Omitted ⇒ only the caller's own pod-wide guidelines. */
    workspaceId: z.string().uuid().optional(),
  })
  .refine((v) => !!(v.workKind || v.sourceKind || v.entityKind), {
    message: "Pass workKind, sourceKind or entityKind",
  });

const DataTypeGuidelineSchema = z.object({
  id: z.string(),
  version: z.number(),
  text: z.string(),
  scopeKind: z.string(),
  scopeRef: z.string().nullable(),
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
        description:
          "Matching guidelines (possibly none). A workKind-only call returns " +
          "`{workKind, guidelines:[{id,text}]}`; a data-type call returns " +
          "`{guidelines:[{id,version,text,scopeKind,scopeRef}]}` for the " +
          "requested rungs only.",
        schema: z.object({
          workKind: z.enum(BLOCKED_REASONS).optional(),
          guidelines: z.array(
            z.union([
              DataTypeGuidelineSchema,
              z.object({ id: z.string(), text: z.string() }),
            ])
          ),
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
      sourceKind: c.req.query("sourceKind"),
      entityKind: c.req.query("entityKind"),
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

    const { workKind, sourceKind } = parsed.data;
    const entityKinds = (parsed.data.entityKind ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    try {
      // The legacy work-guideline call — response unchanged.
      if (workKind && !sourceKind && entityKinds.length === 0) {
        const guidelines = await findWorkGuidelines({
          userId: acting.userId,
          workspaceId: acting.workspaceId,
          blockedReason: workKind,
        });
        return c.json({ workKind, guidelines });
      }
      const requested = new Set<string>([
        ...(workKind ? ["workKind"] : []),
        ...(sourceKind ? ["sourceKind"] : []),
        ...(entityKinds.length ? ["entityKind"] : []),
      ]);
      const resolved = await resolveGuidelines({
        db,
        userId: acting.userId,
        workspaceId: acting.workspaceId,
        workKind: workKind ?? null,
        sourceKind: sourceKind ?? null,
        entityKinds,
      });
      return c.json({
        ...(workKind ? { workKind } : {}),
        guidelines: resolved
          .filter((g) => requested.has(g.scopeKind))
          .map((g) => ({
            id: g.id,
            version: g.version,
            text: g.text,
            scopeKind: g.scopeKind,
            scopeRef: g.scopeRef,
          })),
      });
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

  registerOpenApi(app, {
    method: "get",
    path: "/guidelines/{id}/history",
    tags: ["Guidelines"],
    summary: "Version history of one guideline",
    description:
      "Every version of the guideline, newest first, revoked versions " +
      "included. Visible to the owner of a pod-wide guideline, or to a member " +
      "of the guideline's workspace.",
    request: { params: z.object({ id: z.string().uuid() }) },
    responses: {
      200: {
        description: "Versions, newest first",
        schema: z.object({
          versions: z.array(
            DataTypeGuidelineSchema.extend({
              supersedesId: z.string().nullable(),
              revokedAt: z.string().nullable(),
              createdAt: z.string(),
            })
          ),
        }),
      },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.get("/guidelines/:id/history", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const acting = await resolveActingContext(c, {});
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) {
      return c.json({ error: "Guideline not found" }, 404);
    }
    try {
      const versions = await listGuidelineHistory({ db, id });
      const asked = versions.find((v) => v.id === id);
      // Same lens as the tRPC door: a pod-wide row only for its owner (404,
      // so existence does not leak), a workspace row for its members.
      if (!asked) return c.json({ error: "Guideline not found" }, 404);
      if (asked.workspaceId) {
        const member = await getWorkspaceMembership(
          db,
          asked.workspaceId,
          acting.userId
        );
        if (!member)
          return c.json({ error: "Access denied to workspace" }, 403);
      } else if (asked.createdBy !== acting.userId) {
        return c.json({ error: "Guideline not found" }, 404);
      }
      return c.json({
        versions: versions.map((v) => ({
          id: v.id,
          version: v.version,
          text: (v.value as { text?: string })?.text ?? "",
          scopeKind: v.scopeKind,
          scopeRef: v.scopeRef,
          supersedesId: v.supersedesId,
          revokedAt: v.revokedAt ? v.revokedAt.toISOString() : null,
          createdAt: v.createdAt.toISOString(),
        })),
      });
    } catch (err) {
      logger.error({ err }, "guidelines.history failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
