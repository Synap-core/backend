/**
 * Hub Protocol REST — /orient
 *
 * The canonical lens-map endpoint for agent session bootstrap: workspaces +
 * projects + a profile sample + identity. A thin wrapper over the shared
 * `discover()` service (the ONE place that shapes orient output). The CLI
 * `synap orient` renders this DTO verbatim; the MCP `synap_orient` tool calls
 * the same service in-process.
 *
 *   ?detail=full   — workspace descriptions + full onboarding + per-ws profiles
 *   ?scope=a,b,c   — restrict to workspaces|projects|profiles
 *   ?workspaceId=  — pin to one workspace
 *   ?projectId=    — pin to one project
 */

import { z } from "@hono/zod-openapi";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import { getCaller, hasScope, logger, type HubHono } from "./_shared.js";
import {
  discover,
  type DiscoverScope,
} from "../../../services/discover/discover.js";

export function registerOrientRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "get",
    path: "/orient",
    tags: ["System"],
    summary: "Lens map — workspaces, projects, profile sample, identity",
    description:
      "Canonical session-bootstrap orientation. Returns the user's workspaces " +
      "(operational domains), projects (cross-cutting initiatives), a profile " +
      "sample, and identity. Pass ?detail=full for descriptions + full " +
      "onboarding + per-workspace profiles.",
    responses: {
      200: {
        description: "Lens map",
        schema: z.record(z.string(), z.unknown()),
      },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.get("/orient", async (c) => {
    const scopes = c.get("scopes") as string[];
    if (!hasScope(scopes, "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }

    const userId = c.get("userId") as string;
    const detail = c.req.query("detail") === "full" ? "full" : "light";
    const workspaceId = c.req.query("workspaceId") || undefined;
    const projectId = c.req.query("projectId") || undefined;
    const scopeParam = c.req.query("scope");
    const scope = scopeParam
      ? (scopeParam
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean) as DiscoverScope[])
      : undefined;

    try {
      const caller = await getCaller(c);
      const result = await discover({
        caller,
        userId,
        scopes,
        detail,
        scope,
        workspaceId,
        projectId,
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err, userId }, "GET /orient failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
