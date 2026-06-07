/**
 * Hub Protocol REST — AI providers
 *
 * GET /ai-providers  → list all AI providers (no API keys, hasApiKey flag only)
 *
 * Mirrors aiProvidersRouter.list but accessible via hub-protocol Bearer auth
 * so eve-dashboard and CLI tools can read the pod's provider config.
 */

import { db } from "@synap/database";
import type { HubHono } from "./_shared.js";

export function registerAiProvidersRoutes(app: HubHono): void {
  app.get("/ai-providers", async (c) => {
    const rows = await db.query.aiProviders.findMany({
      orderBy: (t, { asc }) => [asc(t.priority)],
    });
    const providers = rows.map(({ encryptedApiKey: _k, ...p }) => ({
      ...p,
      hasApiKey: !!_k,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    }));
    return c.json({ providers });
  });
}
