/**
 * API Key Middleware for n8n
 *
 * Validates API keys and adds authentication context to tRPC procedures.
 */

import { middleware } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { apiKeyService } from "../services/api-keys.js";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "api-key-middleware" });

/**
 * Extract API key from Authorization header
 */
function extractApiKey(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * Check if API key has required scope
 */
function hasScope(keyScopes: string[], requiredScope: string): boolean {
  return keyScopes.includes(requiredScope);
}

/**
 * API Key Middleware
 *
 * Validates Bearer token and enriches context with authentication data.
 */
export const apiKeyMiddleware = middleware(async ({ ctx, next, path }) => {
  // Extract Authorization header
  const authHeader = ctx.req?.headers?.get?.("authorization") || null;
  const apiKey = extractApiKey(authHeader);

  if (!apiKey) {
    logger.warn({ path }, "API key middleware: No API key provided");
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "API key required. Provide via Authorization: Bearer <key>",
    });
  }

  // Validate API key
  const keyRecord = await apiKeyService.validateApiKey(apiKey);

  if (!keyRecord) {
    logger.warn(
      { path, keyPrefix: apiKey.substring(0, 15) },
      "Invalid or expired API key"
    );
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Invalid or expired API key",
    });
  }

  // Check rate limiting
  const allowed = apiKeyService.checkRateLimit(keyRecord.id, "request");
  if (!allowed) {
    logger.warn(
      {
        keyId: keyRecord.id,
        keyName: keyRecord.keyName,
        path,
      },
      "Rate limit exceeded"
    );
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Rate limit exceeded. Please try again later.",
    });
  }

  logger.debug(
    {
      userId: keyRecord.userId,
      keyName: keyRecord.keyName,
      scopes: keyRecord.scope,
      path,
    },
    "API key validated successfully"
  );

  // Add authentication context
  return next({
    ctx: {
      ...ctx,
      userId: keyRecord.userId,
      scopes: keyRecord.scope,
      apiKeyId: keyRecord.id,
      apiKeyName: keyRecord.keyName,
      authenticated: true as const,
    },
  });
});

/**
 * Create a procedure that requires specific scopes
 */
export function createScopedProcedure(requiredScopes: string[]) {
  return middleware(async ({ ctx, next, path }) => {
    // Type guard to check if context has scopes
    if (!("scopes" in ctx) || !Array.isArray(ctx.scopes)) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Scoped procedure must be used with apiKeyMiddleware",
      });
    }

    const scopes = ctx.scopes as string[];

    // Check all required scopes
    const missingScopes = requiredScopes.filter(
      (scope) => !hasScope(scopes, scope)
    );

    if (missingScopes.length > 0) {
      logger.warn(
        {
          userId: ctx.userId,
          keyName: "apiKeyName" in ctx ? ctx.apiKeyName : "unknown",
          requiredScopes,
          actualScopes: scopes,
          missingScopes,
          path,
        },
        "Insufficient scopes"
      );

      throw new TRPCError({
        code: "FORBIDDEN",
        message: `Insufficient permissions. Missing scopes: ${missingScopes.join(", ")}`,
      });
    }

    return next();
  });
}

/**
 * Helper: Create procedure with API key auth + scope check
 */
import { publicProcedure } from "../trpc.js";

export const apiKeyProcedure = publicProcedure.use(apiKeyMiddleware);

export function scopedProcedure(scopes: string[]) {
  return apiKeyProcedure.use(createScopedProcedure(scopes));
}
