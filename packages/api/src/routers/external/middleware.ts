/**
 * Shared auth middleware for /api/external/* routes.
 *
 * Used by both Option C (skills.invoke) and Option D (chat.stream).
 * Extracts the Bearer token, validates it via apiKeyService, checks the
 * required scope, and injects { userId, scopes } into the Hono context.
 */

import type { Context, Next } from "hono";
import { apiKeyService } from "../../services/api-keys.js";

/** Hono context variables populated by externalApiKeyAuth */
export type ExternalApiVariables = {
  userId: string;
  scopes: string[];
};

function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function hasScope(scopes: string[], required: string): boolean {
  return scopes.includes(required);
}

/**
 * Returns a Hono middleware that:
 * 1. Extracts the Bearer token from the Authorization header.
 * 2. Validates it via apiKeyService.
 * 3. Checks that the key has the required scope.
 * 4. Sets `userId` and `scopes` on the Hono context.
 */
export function externalApiKeyAuth(requiredScope: string) {
  return async (
    c: Context<{ Variables: ExternalApiVariables }>,
    next: Next
  ): Promise<Response | void> => {
    const authHeader = c.req.header("authorization") ?? null;
    const token = extractBearerToken(authHeader);

    if (!token) {
      return c.json(
        { error: "API key required. Use Authorization: Bearer <key>" },
        401
      );
    }

    const keyRecord = await apiKeyService.validateApiKey(token);
    if (!keyRecord) {
      return c.json({ error: "Invalid or expired API key" }, 401);
    }

    const allowed = apiKeyService.checkRateLimit(keyRecord.id, "request");
    if (!allowed) {
      return c.json({ error: "Rate limit exceeded" }, 429);
    }

    if (!hasScope(keyRecord.scope, requiredScope)) {
      return c.json(
        { error: `Insufficient scope. Required: ${requiredScope}` },
        403
      );
    }

    c.set("userId", keyRecord.userId);
    c.set("scopes", keyRecord.scope);
    await next();
  };
}
