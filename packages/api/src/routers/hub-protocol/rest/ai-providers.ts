/**
 * Hub Protocol REST — AI providers
 *
 * Full CRUD for AI provider configs accessible via hub-protocol Bearer auth.
 * Each mutation syncs the full provider list to the active IS so it hot-reloads.
 *
 * GET    /ai-providers            — list all providers (no API keys)
 * POST   /ai-providers            — upsert (create or update) a provider
 * POST   /ai-providers/:id/enable — enable a provider
 * POST   /ai-providers/:id/disable — disable a provider
 * DELETE /ai-providers/:id        — remove a provider
 * POST   /ai-providers/sync       — re-push all providers to IS
 */

import { z } from "zod";
import { db, eq } from "@synap/database";
import { aiProviders } from "@synap/database/schema";
import {
  encryptServiceKey,
  decryptServiceKey,
  isEncryptedServiceKey,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { hasScope, type HubHono } from "./_shared.js";

const logger = createLogger({ module: "hub-ai-providers" });

// ── IS sync ───────────────────────────────────────────────────────────────────

const IS_URL = process.env.INTELLIGENCE_HUB_URL;
const IS_ADMIN_KEY =
  process.env.INTELLIGENCE_HUB_INTERNAL_KEY ?? process.env.ADMIN_API_KEY;

async function syncToIS(): Promise<void> {
  if (!IS_URL || !IS_ADMIN_KEY) {
    logger.warn("IS_URL or IS_ADMIN_KEY not set — skipping provider sync");
    return;
  }
  const rows = await db.query.aiProviders.findMany({
    orderBy: (t, { asc }) => [asc(t.priority)],
  });
  const providers = rows.map((p) => {
    const decryptedKey =
      p.encryptedApiKey && isEncryptedServiceKey(p.encryptedApiKey)
        ? decryptServiceKey(p.encryptedApiKey)
        : (p.encryptedApiKey ?? undefined);
    return {
      id: p.providerId,
      name: p.name,
      baseUrl: p.baseUrl,
      apiKeyEnvVar: p.apiKeyEnvVar,
      ...(decryptedKey ? { apiKey: decryptedKey } : {}),
      enabled: p.enabled,
      priority: p.priority,
      tags: (p.tags as string[]) ?? [],
      models: (p.models as object[]) ?? [],
    };
  });
  const enabledIds = rows
    .filter((p) => p.enabled)
    .sort((a, b) => a.priority - b.priority)
    .map((p) => p.providerId);

  try {
    const res = await fetch(`${IS_URL}/admin/providers`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Key": IS_ADMIN_KEY,
      },
      body: JSON.stringify({
        providers,
        routing: {
          default: enabledIds[0] ?? "",
          fallbackChain: enabledIds,
          perRoute: {},
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.warn(
        { status: res.status, body: text },
        "IS provider sync failed"
      );
    }
  } catch (err) {
    logger.warn({ err }, "IS provider sync request failed");
  }
}

// ── Upsert schema ─────────────────────────────────────────────────────────────

const UpsertBody = z.object({
  providerId: z.string().min(1),
  name: z.string().min(1),
  baseUrl: z.string().url(),
  apiKeyEnvVar: z.string().default("PROVIDER_API_KEY"),
  apiKey: z.string().optional(),
  enabled: z.boolean().default(true),
  priority: z.number().int().default(10),
  tags: z.array(z.string()).default([]),
  models: z
    .array(
      z.object({
        id: z.string(),
        tier: z.enum(["free", "balanced", "advanced", "complex"]).optional(),
        contextWindow: z.number().optional(),
      })
    )
    .default([]),
});

// ── Route registration ────────────────────────────────────────────────────────

export function registerAiProvidersRoutes(app: HubHono): void {
  // GET /ai-providers
  app.get("/ai-providers", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
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

  // POST /ai-providers — upsert
  app.post("/ai-providers", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    let body: z.infer<typeof UpsertBody>;
    try {
      body = UpsertBody.parse(await c.req.json());
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }

    const { apiKey, ...rest } = body;
    const existing = await db.query.aiProviders.findFirst({
      where: eq(aiProviders.providerId, rest.providerId),
    });

    const encryptedApiKey = apiKey
      ? encryptServiceKey(apiKey)
      : (existing?.encryptedApiKey ?? null);

    const now = new Date();
    if (existing) {
      await db
        .update(aiProviders)
        .set({ ...rest, encryptedApiKey, updatedAt: now })
        .where(eq(aiProviders.providerId, rest.providerId));
    } else {
      await db
        .insert(aiProviders)
        .values({ ...rest, encryptedApiKey, createdAt: now, updatedAt: now });
    }

    await syncToIS();

    const row = await db.query.aiProviders.findFirst({
      where: eq(aiProviders.providerId, rest.providerId),
    });
    const { encryptedApiKey: _k, ...safe } = row!;
    return c.json({
      ...safe,
      hasApiKey: !!_k,
      createdAt: safe.createdAt.toISOString(),
      updatedAt: safe.updatedAt.toISOString(),
    });
  });

  // POST /ai-providers/sync — re-push all to IS (must be before /:id routes)
  app.post("/ai-providers/sync", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const count = await db.query.aiProviders.findMany().then((r) => r.length);
    await syncToIS();
    return c.json({ ok: true, count });
  });

  // POST /ai-providers/:id/enable
  app.post("/ai-providers/:id/enable", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const providerId = c.req.param("id");
    await db
      .update(aiProviders)
      .set({ enabled: true, updatedAt: new Date() })
      .where(eq(aiProviders.providerId, providerId));
    await syncToIS();
    return c.json({ ok: true });
  });

  // POST /ai-providers/:id/disable
  app.post("/ai-providers/:id/disable", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const providerId = c.req.param("id");
    await db
      .update(aiProviders)
      .set({ enabled: false, updatedAt: new Date() })
      .where(eq(aiProviders.providerId, providerId));
    await syncToIS();
    return c.json({ ok: true });
  });

  // POST /ai-providers/:id/probe — live connectivity test via IS admin
  app.post("/ai-providers/:id/probe", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const providerId = c.req.param("id");
    if (!IS_URL || !IS_ADMIN_KEY) {
      return c.json({ error: "IS not configured" }, 503);
    }
    try {
      const res = await fetch(`${IS_URL}/admin/providers/${providerId}/test`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Admin-Key": IS_ADMIN_KEY,
        },
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json()) as {
        ok?: boolean;
        models?: string[];
        latencyMs?: number;
        error?: string;
      };
      return c.json(body);
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 502);
    }
  });

  // DELETE /ai-providers/:id
  app.delete("/ai-providers/:id", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const providerId = c.req.param("id");
    await db.delete(aiProviders).where(eq(aiProviders.providerId, providerId));
    await syncToIS();
    return c.json({ ok: true });
  });
}
