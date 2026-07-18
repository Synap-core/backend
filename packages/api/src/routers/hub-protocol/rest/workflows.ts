/**
 * Hub Protocol REST — workflow place (WORKFLOW-AS-PLACE, D1)
 *
 * The agent/CLI mirror of the tRPC `workflows.place` / `workflows.placeFeed`
 * doors — one DERIVED aggregate per workflow (automation OR playbook):
 *
 *   GET /workflows/:kind/:id/place  — definition + runs + sessions + channels +
 *                                     produced results + attributed proposals.
 *   GET /workflows/:kind/:id/feed   — the per-workflow event feed (cursor-paged).
 *
 * Requires hub-protocol.read scope. The acting user comes from the auth
 * middleware (`c.get("userId")`), NEVER a ?userId query param — same read-path
 * asymmetry as /runs and /observability (no cross-user IDOR).
 */

import { z } from "zod";
import {
  getWorkflowPlace,
  getWorkflowPlaceFeed,
} from "../../../services/workflow-place/index.js";
import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import { hasScope, type HubHono } from "./_shared.js";

const WorkflowKindSchema = z.enum(["automation", "playbook"]);

export function registerWorkflowsRoutes(app: HubHono): void {
  // ── GET /workflows/:kind/:id/place ─────────────────────────────────────────
  registerOpenApi(app, {
    method: "get",
    path: "/workflows/{kind}/{id}/place",
    tags: ["Workflows"],
    summary: "Get a workflow's place (derived aggregate)",
    description:
      "One workflow's runs + sessions + channels + produced results + attributed " +
      "proposals, derived from runtime keys. USER-floored; 404 when the workflow " +
      "is not visible.",
    request: {
      params: z.object({ kind: WorkflowKindSchema, id: z.string() }),
    },
    responses: {
      200: { description: "Workflow place", schema: z.any() },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Workflow not found", schema: ErrorSchema },
    },
  });

  app.get("/workflows/:kind/:id/place", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const userId = c.get("userId") as string | undefined;
    if (!userId) return c.json({ error: "Unauthorized" }, 401);

    const parsedKind = WorkflowKindSchema.safeParse(c.req.param("kind"));
    if (!parsedKind.success) {
      return c.json({ error: "kind must be 'automation' or 'playbook'" }, 400);
    }
    const place = await getWorkflowPlace({
      kind: parsedKind.data,
      id: c.req.param("id"),
      userId,
    });
    if (!place) return c.json({ error: "Workflow not found" }, 404);
    return c.json(place);
  });

  // ── GET /workflows/:kind/:id/feed ──────────────────────────────────────────
  registerOpenApi(app, {
    method: "get",
    path: "/workflows/{kind}/{id}/feed",
    tags: ["Workflows"],
    summary: "Get a workflow's event feed",
    description:
      "The per-workflow focus-session event feed, newest-first, cursor-paginated. " +
      "USER-floored via the session-visibility derivation (events carry no " +
      "workspace column, so the visible-session set is the security floor).",
    request: {
      params: z.object({ kind: WorkflowKindSchema, id: z.string() }),
      query: z.object({
        cursor: z.string().optional(),
        limit: z.coerce.number().min(1).max(100).optional(),
      }),
    },
    responses: {
      200: { description: "Workflow event feed", schema: z.any() },
      403: { description: "Forbidden", schema: ErrorSchema },
    },
  });

  app.get("/workflows/:kind/:id/feed", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const userId = c.get("userId") as string | undefined;
    if (!userId) return c.json({ error: "Unauthorized" }, 401);

    const parsedKind = WorkflowKindSchema.safeParse(c.req.param("kind"));
    if (!parsedKind.success) {
      return c.json({ error: "kind must be 'automation' or 'playbook'" }, 400);
    }
    const limitRaw = Number(c.req.query("limit"));
    const feed = await getWorkflowPlaceFeed({
      kind: parsedKind.data,
      id: c.req.param("id"),
      userId,
      cursor: c.req.query("cursor") || undefined,
      limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
    });
    return c.json(feed);
  });
}
