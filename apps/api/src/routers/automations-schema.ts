/**
 * Automations Schema REST router — serves a static reference document
 * describing all trigger types, node types, template syntax, and CLI
 * quick-create flags for the pod automation engine.
 *
 * GET /api/hub/automations/schema (cookie-auth, browser)
 *   Returns the full automation schema (no DB queries — static document).
 *
 * The schema document itself now lives in @synap/api
 * (packages/api/src/routers/hub-protocol/rest/automation-schema-doc.ts) so the
 * Bearer/agent-facing hub-protocol route can serve the SAME document. This
 * cookie-authed mount is kept for the browser (Studio) surface.
 */

import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { authMiddleware } from "@synap/auth";
import { AUTOMATION_SCHEMA, apiKeyService } from "@synap/api";

const automationsSchemaRouter = new Hono();

// This mount registers BEFORE the hub-protocol REST app on the same path
// (/api/hub/automations/schema), so it shadows the Bearer route — Hono
// dispatches the first registration. Accept BOTH principals here: a valid
// pod API key (agents/CLI) or the browser session cookie.
const cookieOrApiKeyAuth: MiddlewareHandler = async (c, next) => {
  const auth = c.req.header("authorization");
  const bearer = auth?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer) {
    const record = await apiKeyService.validateApiKey(bearer);
    if (record) return next();
    return c.json({ error: "Invalid API key" }, 401);
  }
  return authMiddleware(c, next);
};

automationsSchemaRouter.get("/", cookieOrApiKeyAuth, (c) =>
  c.json(AUTOMATION_SCHEMA)
);

export { automationsSchemaRouter };
