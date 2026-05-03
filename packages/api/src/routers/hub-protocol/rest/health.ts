/**
 * Hub Protocol REST — health
 *
 * Public, no-auth health endpoint. The auth middleware in hub-protocol-rest.ts
 * skip-lists "/health" so this works without credentials.
 */

import { z } from "@hono/zod-openapi";

import { registerOpenApi } from "./_codecs/_register.js";
import type { HubHono } from "./_shared.js";

export function registerHealthRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "get",
    path: "/health",
    tags: ["System"],
    summary: "Liveness probe",
    description: "Public, no-auth health endpoint.",
    security: [],
    responses: {
      200: {
        description: "OK",
        schema: z.object({ status: z.string(), service: z.string() }),
      },
    },
  });

  /**
   * GET /health (no auth)
   */
  app.get("/health", (c) => c.json({ status: "ok", service: "hub-protocol" }));
}
