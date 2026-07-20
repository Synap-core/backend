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
        schema: z.object({
          id: z.string(),
          scopes: z.array(z.string()),
          /** Server-derived credential posture; never accepted from the caller. */
          isAgent: z.boolean(),
        }),
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
    // `agentUserId` is established only by Hub auth middleware after it resolves
    // the bearer key. It is deliberately not a query/body field, so an external
    // client cannot forge agent posture to unlock AI-write surfaces.
    return c.json({
      id: userId,
      scopes: scopes ?? [],
      isAgent: Boolean(c.get("agentUserId")),
    });
  });
}
