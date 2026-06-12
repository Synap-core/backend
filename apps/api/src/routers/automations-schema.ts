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
import { authMiddleware } from "@synap/auth";
import { AUTOMATION_SCHEMA } from "@synap/api";

const automationsSchemaRouter = new Hono();

automationsSchemaRouter.get("/", authMiddleware, (c) =>
  c.json(AUTOMATION_SCHEMA)
);

export { automationsSchemaRouter };
