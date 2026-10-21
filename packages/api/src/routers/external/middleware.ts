/**
 * Shared auth middleware for /api/external/* routes.
 *
 * Used by Option C (skills.invoke), Option D (chat.stream) and the
 * OpenAI-compatible surface. Extracts the Bearer token, validates it via
 * apiKeyService, checks the required scope, resolves the key's identity through
 * the ONE door (`resolveKeyIdentity`, access/key-identity.ts), and runs the rest
 * of the request inside the same request write facts the other key doors enter
 * (tRPC `api-key-auth.ts`, Hub REST `_middleware/auth.ts`, MCP `http-handler.ts`).
 *
 * Until 2026-10-13 this door set `userId = keyRecord.userId` and entered no
 * scope: an AGENT key reached the pod as its own principal with no acting agent
 * attributed and no grant, so nothing downstream could govern it.
 */

import type { Context, Next } from "hono";
import {
  runWithProbeWrites,
  runWithActingAgent,
  runWithCallingKey,
  runWithGrant,
  isProbeApiKey,
} from "@synap/database";
import { apiKeyService } from "../../services/api-keys.js";
import { resolveKeyIdentity } from "../../access/key-identity.js";
import {
  GRANT_DOOR_UNSUPPORTED,
  isFencedGrant,
} from "../../access/grant-door-fence.js";
import {
  GUEST_REFUSED_BODY,
  isGuestPrincipal,
} from "../../access/guest-containment.js";

/** Hono context variables populated by externalApiKeyAuth */
export type ExternalApiVariables = {
  /** The identity that OWNS/SEES the data: the linked human, else the key owner. */
  userId: string;
  /** The acting agent principal — set only when the key principal is an agent. */
  agentUserId: string | undefined;
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
 * 2. Validates it via apiKeyService (an inactive — pending or revoked — or
 *    expired key does not validate).
 * 3. Checks that the key has the required scope.
 * 4. Resolves identity via `resolveKeyIdentity` and refuses a guest principal.
 * 5. Refuses a scoped (fenced) grant: no external route reads through the grant
 *    seams, and a chat turn / skill run reads through the IS, which no grant
 *    bounds — so, like every unlisted door, it fails closed.
 * 6. Sets `userId` (effective), `agentUserId` and `scopes`, and runs the route
 *    inside the probe / acting-agent / grant request scope.
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

    // The ONE identity door — same derivation as every other key door.
    const { effectiveUserId, agentUserId, grant } =
      await resolveKeyIdentity(keyRecord);

    // Guest containment on the final principal (the data floor), as the Hub
    // and MCP doors do.
    if (await isGuestPrincipal(effectiveUserId, c.req.raw)) {
      return c.json(GUEST_REFUSED_BODY, 403);
    }

    // W1 fence: fail closed for a scoped key (see step 5 above).
    if (isFencedGrant(grant)) {
      return c.json(
        { error: GRANT_DOOR_UNSUPPORTED, code: "GRANT_DOOR_UNSUPPORTED" },
        403
      );
    }

    c.set("userId", effectiveUserId);
    c.set("agentUserId", agentUserId);
    c.set("scopes", keyRecord.scope);
    // Request write facts: D8 probe key, D6 acting agent, W1 grant.
    await runWithProbeWrites(isProbeApiKey(keyRecord), () =>
      runWithActingAgent(agentUserId, () =>
        // B7: the calling key, recorded on every proposal this request files.
        runWithCallingKey(keyRecord.id, () => runWithGrant(grant, () => next()))
      )
    );
  };
}
