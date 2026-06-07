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
import { aiProviders, workspaceMembers } from "@synap/database/schema";
import { asc, eq, and } from "drizzle-orm";
import { resolveProviderCredentialsBatch } from "@synap/api";

const providersRouter = new Hono();

/** Decrypt a stored service key, passing through plaintext legacy values. */
function decrypt(encrypted: string): string {
  return isEncryptedServiceKey(encrypted)
    ? decryptServiceKey(encrypted)
    : encrypted;
}

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

  const overrides = await resolveProviderCredentialsBatch(
    rows.map((p) => p.providerId),
    workspaceId ?? undefined,
    userId ?? undefined
  );

  const result = rows.map((p) => {
    const override = overrides.get(p.providerId) ?? null;
    const apiKey =
      override ?? (p.encryptedApiKey ? decrypt(p.encryptedApiKey) : null);
    return {
      providerId: p.providerId,
      name: p.name,
      baseUrl: p.baseUrl,
      models: p.models,
      tags: p.tags,
      priority: p.priority,
      apiKey,
    };
  });

  return c.json({ providers: result });
});

export { providersRouter };
