/**
 * API-key revocation — the ONE door for "these keys stop working".
 *
 * Every revoke is `UPDATE api_keys SET is_active=false, revoked_at=now()…`
 * followed by dropping the verification cache the API process keeps
 * (`ApiKeyService`, 30s TTL, read by `/mcp` and the Hub). Before this door the
 * two halves lived at a dozen call sites and most forgot the second: a key
 * disconnected, rotated, replaced or bulk-revoked kept validating for up to
 * 30s from the cache while the UI said "immediately".
 *
 * The cache lives in `@synap/api` (it must not be imported here), so the API
 * process REGISTERS its invalidator at load (`onApiKeysRevoked`). A process
 * with no cache (a CLI script, a worker) registers nothing and loses nothing.
 * Tripwire: `packages/api/src/__tripwires__/api-key-revoke-one-door.test.ts`.
 */
import type { SQL } from "drizzle-orm";
import { apiKeys } from "../schema/index.js";

type Invalidator = () => void;
const invalidators = new Set<Invalidator>();

/** Register a cache to drop after every revoke. Returns the unregister function. */
export function onApiKeysRevoked(fn: Invalidator): () => void {
  invalidators.add(fn);
  return () => invalidators.delete(fn);
}

/** Anything that can run the UPDATE — the pool, or a transaction. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Executor = { update: (...args: any[]) => any };

export interface RevokeApiKeysParams {
  /** Which keys. Never omitted: an unfiltered revoke is not a thing this door does. */
  where: SQL | undefined;
  /** Who revoked them (a user id), when known. */
  revokedBy?: string | null;
  /** Why — shown in audit and key history. */
  reason: string;
}

/**
 * Revoke the keys `where` selects, then drop every registered verification
 * cache. Returns the revoked ids.
 *
 * Inside a transaction, the cache is dropped BEFORE commit: a request that
 * validates between the drop and the commit can re-cache the still-valid row
 * for one TTL. Call from outside a transaction when that window matters.
 */
export async function revokeApiKeys(
  executor: Executor,
  params: RevokeApiKeysParams
): Promise<Array<{ id: string }>> {
  if (!params.where) {
    throw new Error("revokeApiKeys: a where clause is required");
  }
  const rows: Array<{ id: string }> = await executor
    .update(apiKeys)
    .set({
      isActive: false,
      revokedAt: new Date(),
      revokedBy: params.revokedBy ?? null,
      revokedReason: params.reason,
    })
    .where(params.where)
    .returning({ id: apiKeys.id });
  for (const fn of invalidators) fn();
  return rows;
}
