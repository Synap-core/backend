/**
 * The reader door's per-(person, lens) source cache — a LEAF (no imports), so
 * every door that changes which readers can run drops it without pulling the
 * reader machinery in.
 *
 * Dropped by the doors that turn a reader on/off or add/remove one:
 *   - `setSkillApproved` (a verb on/off — `skills.setApproved`,
 *     `capabilities.setToolEnabled`, the `capability.enable` executor),
 *   - `capabilityContainers.update` (a pack on/off),
 *   - `createCapabilityFromDefinition` (install / template apply),
 *   - `uninstallCapability`,
 *   - `addCredential` / `removeCredential` / `disconnectConnection` (connect,
 *     disconnect).
 * Everything else that can move a reader's state (a secret written by another
 * door, a template reconcile, a catalog sync) is bounded by the TTL: a few
 * seconds, long enough to serve one request's loop over many items.
 */

export const URL_READER_SOURCES_TTL_MS = 5_000;
const MAX_KEYS = 500;

const entries = new Map<string, { at: number; value: unknown }>();

/** Drop every cached reader list (a door changed which readers can run). */
export function invalidateUrlReaderCache(): void {
  entries.clear();
}

export function readerCacheGet<T>(
  key: string,
  now = Date.now()
): T | undefined {
  const hit = entries.get(key);
  if (!hit || now - hit.at >= URL_READER_SOURCES_TTL_MS) return undefined;
  return hit.value as T;
}

export function readerCacheSet(
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
