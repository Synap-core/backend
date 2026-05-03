/**
 * Hub Protocol REST — users
 */

import { z } from "@hono/zod-openapi";

import { registerOpenApi } from "./_codecs/_register.js";
import type { HubHono } from "./_shared.js";

export function registerUsersRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "get",
    path: "/users/me",
    tags: ["Users"],
    summary: "Echo the authenticated identity",
    description:
      "Used by OpenClaw, CLI, and external agents to verify their API key.",
    responses: {
      200: {
        description: "Identity",
        schema: z.object({ id: z.string(), scopes: z.array(z.string()) }),
      },
      401: { description: "Unauthorized" },
    },
  });

  /**
   * GET /users/me — return the authenticated agent/user identity.
   * Used by OpenClaw, CLI, and external agents to verify their API key.
   */
  app.get("/users/me", async (c) => {
    const userId = c.get("userId") as string | undefined;
    const scopes = c.get("scopes") as string[] | undefined;
    if (!userId) return c.json({ error: "Unauthorized" }, 401);
    return c.json({ id: userId, scopes: scopes ?? [] });
  });
}
