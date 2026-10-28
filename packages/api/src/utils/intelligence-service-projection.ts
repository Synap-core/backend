/**
 * What a READ of an `intelligence_services` row may hand a caller.
 *
 * The row carries two kinds of secret: the `apiKey` column (an envelope, or a
 * legacy plaintext while `SYNAP_FIELD_ALLOW_LEGACY_PLAINTEXT` is on) and keys
 * inside `metadata`: `managementToken` (what `intelligence.relayToService`
 * authenticates to the service with) and `pendingConfig` (relay payloads
 * queued for an unreachable service, which can hold channel tokens). Every
 * reader of the row goes through these two functions, so a new secret-shaped
 * key is stripped everywhere at once (audit 2026-10-28, pod-routers F5:
 * `intelligenceRegistry.get` filtered the key `_apiKey`, which does not exist,
 * and returned the `apiKey` cell to any signed-in caller).
 */

/** A top-level metadata key whose value is, or may contain, a secret. */
const SECRET_METADATA_KEY =
  /token|secret|password|passphrase|api[-_]?key|credential|private[-_]?key|^pendingConfig$/i;

/** `metadata` with every secret-shaped top-level key removed. */
export function publicServiceMetadata(
  metadata: unknown
): Record<string, unknown> {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(metadata as Record<string, unknown>).filter(
      ([key]) => !SECRET_METADATA_KEY.test(key)
    )
  );
}

/** A service row without `apiKey` and with its metadata made public. */
export function publicServiceRow<
  T extends { apiKey?: unknown; metadata?: unknown },
>(
  row: T
): Omit<T, "apiKey" | "metadata"> & { metadata: Record<string, unknown> } {
  const { apiKey: _apiKey, metadata, ...rest } = row;
  return { ...rest, metadata: publicServiceMetadata(metadata) };
}
