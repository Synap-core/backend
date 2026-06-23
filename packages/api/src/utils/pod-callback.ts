/**
 * The pod-callback descriptor — the URL + bearer the Intelligence Service uses
 * to call BACK into this pod over Hub Protocol (`/api/hub/*`) during a turn.
 *
 * This is the SINGLE source of truth for the two `dataPod*` fields every IS
 * turn-dispatch site sends. It exists because those fields were hand-assembled
 * at 7 different call sites, each re-deriving them independently — which drifted:
 *   - `dataPodApiKey`: 5 of 6 sites passed the WRONG key (the reverse-direction
 *     webhook key `serviceApiKey` instead of the `is_internal` pod-read key), so
 *     the `X-Delegated-Operator-Id` delegation gate never fired and every read
 *     returned the bare service identity → "0 entities / fresh workspace".
 *   - `dataPodUrl`: three different fallback chains across the same sites — a
 *     latent functional bug (wrong callback URL on a pod where DOMAIN is set but
 *     BACKEND_URL isn't, etc.) that simply hadn't bitten yet.
 *
 * Spread this into the turn payload (`...getPodCallback()`) — never hand-write
 * either field. The `pod-callback.tripwire.test.ts` test enforces that.
 *
 * KEY DISTINCTION — do NOT confuse the two backend↔IS secrets (opposite
 * directions, stored differently, both required):
 *   - `dataPodApiKey` here = `HUB_PROTOCOL_API_KEY` = the IS→pod READ key
 *     (`is_internal`, hashed/one-way, carries the delegation gate).
 *   - `serviceApiKey` (= decrypt of `intelligence_services.api_key`) = the
 *     backend→IS WEBHOOK key, sent as the `X-API-Key` header when the backend
 *     CALLS the IS. That one stays where it is; it is never `dataPodApiKey`.
 *
 * Both fields resolve to `""` when their env var is unset. That is a real pod
 * misconfiguration — `HUB_PROTOCOL_API_KEY` is the plaintext `provision.ts`
 * hashes into the `is_internal` row, and the pod must know its own public URL —
 * so the empty value fails loudly at the call instead of silently using a wrong
 * identity or URL.
 */
export interface PodCallback {
  dataPodUrl: string;
  dataPodApiKey: string;
}

export function getPodCallback(): PodCallback {
  return {
    // Union of every prior fallback chain, in priority order, so no env that
    // worked before regresses: explicit public URL → backend URL → DOMAIN-derived.
    dataPodUrl:
      process.env.PUBLIC_URL ||
      process.env.BACKEND_URL ||
      (process.env.DOMAIN ? `https://${process.env.DOMAIN}` : ""),
    dataPodApiKey: process.env.HUB_PROTOCOL_API_KEY || "",
  };
}
