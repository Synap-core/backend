/**
 * The capability READ caches and their ONE invalidation call — a leaf (it
 * imports only the reader cache, itself a leaf), so every door that changes
 * which verbs can run drops BOTH caches with one call and cannot remember one
 * and forget the other.
 *
 *  - the reader door's source cache (`url-reader-cache.ts`, 5 s);
 *  - find's ASSEMBLED registry (`find-intent.ts`): the registry rows, their
 *    runnable projection, the argsSchema map and the coverage counts, keyed
 *    `user | agent | lens | grant fingerprint` (a narrow key's rows must never
 *    serve a wide one), 15 s; and the intent vocabulary (`capability_intents`
 *    has no runtime writer; a migration restarts the process), same TTL.
 *    Not a second index (find-intent.ts docblock): the same answer, held.
 *
 * Dropped by `invalidateCapabilityReadCaches()`, called by the doors that turn
 * a verb on or off or add or remove one: `setSkillApproved`,
 * `capabilityContainers.update`, `createCapabilityFromDefinition`,
 * `uninstallCapability`, `addCredential` / `removeCredential` /
 * `disconnectConnection`, and a capability grant's revoke. Everything else
 * (a template reconcile, a catalog sync, another process) is bounded by the
 * TTL. Guarded by `capability-read-caches.test.ts` (no door calls the reader
 * cache's own invalidation directly).
 */
import { invalidateUrlReaderCache } from "./url-reader-cache.js";

export const FIND_REGISTRY_TTL_MS = 15_000;
const MAX_KEYS = 500;

const entries = new Map<string, { at: number; value: unknown }>();

/** Drop every capability read cache (a door changed which verbs can run). */
export function invalidateCapabilityReadCaches(): void {
  entries.clear();
  invalidateUrlReaderCache();
}

export function findRegistryCacheGet<T>(
  key: string,
  now = Date.now()
): T | undefined {
  const hit = entries.get(key);
  if (!hit || now - hit.at >= FIND_REGISTRY_TTL_MS) return undefined;
  return hit.value as T;
}

export function findRegistryCacheSet(
  key: string,
  value: unknown,
  now = Date.now()
): void {
  if (entries.size >= MAX_KEYS) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
  entries.set(key, { at: now, value });
}
