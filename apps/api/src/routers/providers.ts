/**
 * Providers REST router — used by the synap CLI to discover and fetch
 * AI provider configs from the pod vault.
 *
 * GET /api/hub/providers/models
 *   Returns enabled providers with model IDs. No keys. Safe for listing.
 *
 * GET /api/hub/providers/credentials
 *   Returns enabled providers with decrypted API keys so the CLI can write
 *   them directly to local tool configs (opencode, aider, Claude Code, etc.).
 *   The pod acts as a credential vault — external tools get real keys at
 *   connect time and talk directly to providers, no IS proxy required.
 *   Resolution order per provider: user-level override > workspace > pod-wide.
 */

import { Hono } from "hono";
import { authMiddleware } from "@synap/auth";
import { db, isEncryptedServiceKey, decryptServiceKey } from "@synap/database";
import {
  aiProviders,
  aiProviderCredentials,
  workspaceMembers,
} from "@synap/database/schema";
import { asc, eq, and, isNull } from "drizzle-orm";

const providersRouter = new Hono();

providersRouter.get("/models", authMiddleware, async (c) => {
  const rows = await db
    .select({
      providerId: aiProviders.providerId,
      name: aiProviders.name,
      baseUrl: aiProviders.baseUrl,
      enabled: aiProviders.enabled,
      priority: aiProviders.priority,
      models: aiProviders.models,
      tags: aiProviders.tags,
    })
    .from(aiProviders)
    .where(eq(aiProviders.enabled, true))
    .orderBy(asc(aiProviders.priority));

  return c.json({ providers: rows });
});

providersRouter.get("/credentials", authMiddleware, async (c) => {
  const userId = (c as unknown as { get(k: string): string | undefined }).get(
    "userId"
  );
  const workspaceId = c.req.query("workspaceId");

  // If a workspaceId is given, verify the caller is a member before returning
  // workspace-scoped or user-scoped credentials for that workspace.
  if (workspaceId && userId) {
    const membership = await db.query.workspaceMembers.findFirst({
      where: and(
        eq(workspaceMembers.workspaceId, workspaceId as any),
        eq(workspaceMembers.userId, userId)
      ),
    });
    if (!membership) {
      return c.json({ error: "Forbidden" }, 403);
    }
  }

  const rows = await db
    .select()
    .from(aiProviders)
    .where(eq(aiProviders.enabled, true))
    .orderBy(asc(aiProviders.priority));

  const result = await Promise.all(
    rows.map(async (p) => {
      // Resolution order: user-level > workspace > pod-wide
      let apiKey: string | null = null;

      if (userId) {
        const userCred = await db
          .select({ encryptedApiKey: aiProviderCredentials.encryptedApiKey })
          .from(aiProviderCredentials)
          .where(
            and(
              eq(aiProviderCredentials.providerId, p.providerId),
              eq(aiProviderCredentials.userId, userId),
              eq(aiProviderCredentials.enabled, true)
            )
          )
          .limit(1);
        if (userCred[0]) {
          const raw = userCred[0].encryptedApiKey;
          apiKey = isEncryptedServiceKey(raw) ? decryptServiceKey(raw) : raw;
        }
      }

      if (!apiKey && workspaceId) {
        const wsCred = await db
          .select({ encryptedApiKey: aiProviderCredentials.encryptedApiKey })
          .from(aiProviderCredentials)
          .where(
            and(
              eq(aiProviderCredentials.providerId, p.providerId),
              eq(aiProviderCredentials.workspaceId, workspaceId as any),
              isNull(aiProviderCredentials.userId),
              eq(aiProviderCredentials.enabled, true)
            )
          )
          .limit(1);
        if (wsCred[0]) {
          const raw = wsCred[0].encryptedApiKey;
          apiKey = isEncryptedServiceKey(raw) ? decryptServiceKey(raw) : raw;
        }
      }

      if (!apiKey && p.encryptedApiKey) {
        apiKey = isEncryptedServiceKey(p.encryptedApiKey)
          ? decryptServiceKey(p.encryptedApiKey)
          : p.encryptedApiKey;
      }

      return {
        providerId: p.providerId,
        name: p.name,
        baseUrl: p.baseUrl,
        models: p.models,
        tags: p.tags,
        priority: p.priority,
        apiKey: apiKey ?? null,
      };
    })
  );

  return c.json({ providers: result });
});

export { providersRouter };
