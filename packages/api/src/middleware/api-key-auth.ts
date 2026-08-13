/**
 * API Key Middleware for n8n
 *
 * Validates API keys and adds authentication context to tRPC procedures.
 */

import { t } from "../init-trpc.js";
import { TRPCError } from "@trpc/server";
import { apiKeyService } from "../services/api-keys.js";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "api-key-middleware" });

/** Context shape after API key middleware has already enriched it. */
interface ApiKeyEnrichedContext {
  scopes: string[];
  apiKeyId: string;
  apiKeyName?: string;
  isHubProtocol?: boolean;
  [key: string]: unknown;
}

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
export const apiKeyMiddleware = t.middleware(async ({ ctx, next, path }) => {
  // Short-circuit: if context is already authenticated with scopes (hub protocol server-side call),
  // skip Bearer token extraction — auth already done at the Hono middleware layer.
  if (ctx.authenticated && "scopes" in ctx && "apiKeyId" in ctx) {
    const enriched = ctx as unknown as ApiKeyEnrichedContext;
    if (
      Array.isArray(enriched.scopes) &&
      enriched.scopes.length > 0 &&
      enriched.apiKeyId
    ) {
      const existingScopes = enriched.scopes;
      const isHubProtocolKey = existingScopes.some((s: string) =>
        s.startsWith("hub-protocol.")
      );
      return next({
        ctx: {
          ...ctx,
          scopes: existingScopes,
          apiKeyId: enriched.apiKeyId,
          apiKeyName: enriched.apiKeyName ?? "hub-protocol",
          authenticated: true as const,
          // Preserve hub-protocol branding from createHubProtocolCallerContext
          ...(isHubProtocolKey || enriched.isHubProtocol
            ? { source: "intelligence", isHubProtocol: true }
            : {}),
        },
      });
    }
  }

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

  // Workspace isolation: a key scoped to a specific workspace cannot be used
  // with a different workspace's X-Workspace-Id header.
  if (keyRecord.workspaceId !== null) {
    const requestedWorkspaceId =
      ctx.req?.headers?.get?.("x-workspace-id") ?? null;
    if (
      requestedWorkspaceId !== null &&
      requestedWorkspaceId !== keyRecord.workspaceId
    ) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "API key is not authorized for this workspace",
      });
    }
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
    // Include a machine-parseable Retry-After so bulk clients (Superwhisper
    // store-first) can sleep the window instead of spinning. Window = 60s.
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Rate limit exceeded. Retry after 60s.",
      cause: { retryAfterSec: 60 },
    });
  }

  // Auto-brand hub-protocol requests at the authentication boundary.
  // Any API key with hub-protocol.* scope cannot masquerade as a human request.
  const isHubProtocolKey = keyRecord.scope.some((s: string) =>
    s.startsWith("hub-protocol.")
  );

  logger.debug(
    {
      userId: keyRecord.userId,
      keyName: keyRecord.keyName,
      scopes: keyRecord.scope,
      path,
      isHubProtocol: isHubProtocolKey,
    },
    "API key validated successfully"
  );

  // Agent-key identity remap — mirrors the Hub REST auth middleware
  // (hub-protocol-rest.ts) and the MCP HTTP handler (http-handler.ts) EXACTLY:
  // when the key carries a `linkedUserId` (= the human the agent acts for), the
  // effective identity is the HUMAN (who OWNS the entities) while the agent (the
  // raw key owner) is tracked as `agentUserId` so WRITES still route through the
  // governance membrane (checkPermissionOrPropose → propose, never auto-apply as
  // the operator). Without this remap the tRPC hub-protocol door left
  // `ctx.userId` = the agent principal, so `assertMayActAs(ctx, input.userId)`
  // 403'd every CLI/BYOA call (the human id it sends never equalled the agent id)
  // and reads/attribution scoped to the wrong identity. For NON-agent keys
  // (`linkedUserId` null → user PATs) `userId` stays `keyRecord.userId` and
  // `agentUserId` stays undefined — byte-identical to the prior behavior.
  const effectiveUserId = keyRecord.linkedUserId ?? keyRecord.userId;
  const agentUserId = keyRecord.linkedUserId ? keyRecord.userId : undefined;

  // Add authentication context
  return next({
    ctx: {
      ...ctx,
      userId: effectiveUserId,
      agentUserId,
      scopes: keyRecord.scope,
      apiKeyId: keyRecord.id,
      apiKeyName: keyRecord.keyName,
      // The key's type + workspace binding — consumed by the hub-protocol
      // service-key workspace confinement (resolveConfinedWorkspace). NOT an
      // impersonation grant: identity is always floored to keyRecord.userId.
      keyType: keyRecord.keyType,
      keyWorkspaceId: keyRecord.workspaceId,
      authenticated: true as const,
      // Architecturally enforce: hub-protocol keys are always AI-sourced.
      ...(isHubProtocolKey
        ? { source: "intelligence", isHubProtocol: true }
        : {}),
    },
  });
});

/**
 * Create a procedure that requires specific scopes
 */
export function createScopedProcedure(requiredScopes: string[]) {
  return t.middleware(async ({ ctx, next, path }) => {
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
