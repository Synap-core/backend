/**
 * Which providers THIS pod can offer at all — the ONE derivation behind the
 * membrane state `unavailable` ("Not available here": no Connect door, there
 * is nothing to connect to). Read off the broker's declared integrations
 * (uniqueKey and provider, lowercased). `null` = UNKNOWN (no broker answer):
 * then nothing may be called unavailable — unknown stays connectable.
 * Used by the capability card (`capability-catalog.ts`) and the reader offers
 * (`url-reader-sources.ts` → `url-reader-fold.ts`).
 */

/** The provider keys a broker's declared integrations offer. */
export function declaredProviders(
  integrations: ReadonlyArray<{ uniqueKey: string; provider: string }>
): Set<string> {
  return new Set(
    integrations.flatMap((i) => [
      i.uniqueKey.toLowerCase(),
      i.provider.toLowerCase(),
    ])
  );
}

/** Is `provider` KNOWN not to be offered here? Unknown availability → false. */
export function isProviderUnavailable(
  available: ReadonlySet<string> | null,
  provider: string | null | undefined
): boolean {
  return (
    available !== null && !!provider && !available.has(provider.toLowerCase())
  );
}

/**
 * Ask the broker which providers it offers. `null` when there is no broker
 * or it did not answer — availability is then unproven, never "none".
 */
export async function loadProviderAvailability(): Promise<Set<string> | null> {
  const { resolveBroker } = await import("../../connectors/index.js");
  const resolved = await resolveBroker("nango");
  if (!resolved.ok) return null;
  const declared = await resolved.broker.listIntegrationsResult();
  return declared.ok ? declaredProviders(declared.integrations) : null;
}
