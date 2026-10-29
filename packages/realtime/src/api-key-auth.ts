/**
 * Realtime API-key authenticator
 *
 * Lightweight, dependency-light validator used by the Socket.IO `/presence`
 * handshake to authenticate non-user observers (e.g. the Eve dashboard) by
 * API key. Mirrors the slow path of `ApiKeyService.validateApiKey` from
 * `@synap/api`, but runs inline in the realtime process so we don't have
 * to import the full HTTP-server's tRPC stack just to check a token.
 *
 * Contract — keep in sync with the canonical implementation:
 *   • Prefix-extract → indexed sha256 lookup (`key_lookup_hash`) → bcrypt
 *     ONLY for legacy rows without a lookup hash
 *   • Returns the row (with scopes) on match, null otherwise
 *   • Caller is responsible for scope enforcement (e.g. requiring
 *     `realtime:observe`) and for joining only the rooms the key is
 *     authorized for.
 *
 * Room contract: `realtime:observe` only lets the key CONNECT. Every room it
 * joins passes `canPrincipalJoinRoom` (room-authz.ts, the access door): the
 * room as its owner may join it, narrowed by the key's bound workspace and its
 * grant.
 */

import { createHash } from "crypto";
import bcrypt from "bcrypt";
import { db, and, eq, or, isNull, gt } from "@synap/database";
import { apiKeys, type ApiKeyRecord } from "@synap/database/schema";

/** All valid prefixes — must stay in sync with `KEY_PREFIXES` in the schema. */
const KEY_PREFIXES = [
  "synap_hub_live_",
  "synap_hub_test_",
  "synap_user_",
] as const;

export interface ValidatedRealtimeKey {
  apiKeyId: string;
  userId: string;
  scopes: string[];
  keyName: string;
  /**
   * Whose data the key reads: the human an agent key acts for, else the key's
   * own user — `effectiveUserId` of `resolveKeyIdentity` (@synap/api).
   */
  ownerUserId: string;
  /** The workspace the key is bound to (`api_keys.workspace_id`); null = pod-wide. */
  workspaceId: string | null;
  /** Optional — the agent slug if this key belongs to an agent user. */
  agentType?: string;
}

function extractPrefix(apiKey: string): string | null {
  for (const prefix of KEY_PREFIXES) {
    if (apiKey.startsWith(prefix)) return prefix;
  }
  return null;
}

/** sha256(plaintext key), hex — `ApiKeyService.verificationCacheKey`. */
function lookupHashOf(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

/** A verified row: the scope check, then the key the socket runs as. */
function accept(candidate: ApiKeyRecord): ValidatedRealtimeKey | null {
  const scopes = (candidate.scope ?? []) as string[];
  if (!scopes.includes("realtime:observe")) {
    // Match found but key lacks the required scope — treat as auth failure.
    return null;
  }

  // Best-effort usage tracking. Fire-and-forget; never block.
  db.update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, candidate.id))
    .catch(() => {
      /* non-fatal */
    });

  return {
    apiKeyId: candidate.id,
    userId: candidate.userId,
    scopes,
    keyName: candidate.keyName,
    ownerUserId: candidate.linkedUserId ?? candidate.userId,
    workspaceId: candidate.workspaceId ?? null,
  };
}

/**
 * Validate an API key for realtime subscription.
 *
 * Returns the validated key record if and only if:
 *   • the format / prefix is recognised,
 *   • a row whose sha256 lookup hash matches (or, for a legacy row with no
 *     lookup hash, whose bcrypt hash matches) is active and not expired,
 *   • the key's scopes include `realtime:observe`.
 *
 * Returns `null` otherwise. Failures are silent by design — the caller logs
 * a single line ("Realtime auth: invalid api key") rather than leaking
 * which check failed (revoked vs expired vs unknown vs wrong-scope).
 */
export async function validateRealtimeApiKey(
  apiKey: string
): Promise<ValidatedRealtimeKey | null> {
  if (!apiKey || typeof apiKey !== "string") return null;

  const prefix = extractPrefix(apiKey);
  if (!prefix) return null;

  // 1. O(1) path: indexed sha256 lookup — the canonical verifier
  // (`ApiKeyService.validateApiKey`, @synap/api). Every key created since
  // migration 0157 carries `key_lookup_hash`, and a legacy key gains one on its
  // first bcrypt verify there. This query does not filter on active/expiry, so
  // both are re-checked here.
  const [lookupMatch]: ApiKeyRecord[] = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.keyLookupHash, lookupHashOf(apiKey)))
    .limit(1);
  if (lookupMatch) {
    if (!lookupMatch.isActive) return null;
    if (lookupMatch.expiresAt && lookupMatch.expiresAt <= new Date()) {
      return null;
    }
    return accept(lookupMatch);
  }

  // 2. Fallback for un-migrated legacy keys ONLY (lookup hash NULL). A row
  // with a lookup hash was already ruled out by the sha256 miss; bcrypt-
  // comparing it again (cost 12, ~0.7 s each) let an unauthenticated
  // handshake with any made-up key burn one bcrypt per same-prefix key.
  const candidates: ApiKeyRecord[] = await db
    .select()
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.keyPrefix, prefix),
        isNull(apiKeys.keyLookupHash),
        eq(apiKeys.isActive, true),
        or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date()))
      )
    );

  for (const candidate of candidates) {
    if (await bcrypt.compare(apiKey, candidate.keyHash)) {
      return accept(candidate);
    }
  }

  return null;
}
