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
 *   • Prefix-extract → bcrypt-compare against active, unexpired rows
 *   • Returns the row (with scopes) on match, null otherwise
 *   • Caller is responsible for scope enforcement (e.g. requiring
 *     `realtime:observe`) and for joining only the rooms the key is
 *     authorized for.
 *
 * Phase 3A scope contract: a key with `realtime:observe` is allowed to
 * subscribe to ANY workspace room — the assumption is that this is a local
 * observer running on the operator's own pod. Per-workspace ACL is a Phase 4+
 * concern (see `eve-os-vision.mdx` §9).
 */

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
  /** Optional — the agent slug if this key belongs to an agent user. */
  agentType?: string;
}

function extractPrefix(apiKey: string): string | null {
  for (const prefix of KEY_PREFIXES) {
    if (apiKey.startsWith(prefix)) return prefix;
  }
  return null;
}

/**
 * Validate an API key for realtime subscription.
 *
 * Returns the validated key record if and only if:
 *   • the format / prefix is recognised,
 *   • a row with that prefix exists, is active, not expired,
 *   • bcrypt compare matches the row's hash,
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

  const candidates: ApiKeyRecord[] = await db
    .select()
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.keyPrefix, prefix),
        eq(apiKeys.isActive, true),
        or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date()))
      )
    );

  for (const candidate of candidates) {
    const isMatch = await bcrypt.compare(apiKey, candidate.keyHash);
    if (!isMatch) continue;

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
    };
  }

  return null;
}
