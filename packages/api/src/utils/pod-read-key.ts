/**
 * The IS's pod-read bearer — the `is_internal` keystone key.
 *
 * This is the token the Intelligence Service presents when it calls BACK into
 * this pod over Hub Protocol (`/api/hub/*`) during a turn (the `dataPodApiKey`
 * field in the turn payload). It MUST be the `is_internal` key
 * (`HUB_PROTOCOL_API_KEY`) — that is the ONLY `keyType` the
 * `X-Delegated-Operator-Id` gate in `hub-protocol-rest.ts` honours. With it, the
 * IS reads the pod AS the operator whose turn it is (operator-floor delegation);
 * without it the IS reads as its own service identity and sees nothing →
 * "0 entities / fresh workspace".
 *
 * ⚠️ This is NOT `intelligence_services.apiKey` / `resolvedService.serviceApiKey`.
 * That is the REVERSE-direction secret: the webhook key the backend uses to
 * authenticate when it CALLS the IS. The two keys travel in opposite directions
 * and are stored differently (webhook key = encrypted/reversible so the backend
 * can re-send it; pod-read key = hashed/one-way + carries the keyType gate).
 * Passing the webhook key as `dataPodApiKey` was the bug that made every
 * agent-turn read 0 — the presented key never matched the `is_internal` row, so
 * delegation never fired. Always resolve the pod-read key here, never the
 * webhook key.
 *
 * Returns `""` when `HUB_PROTOCOL_API_KEY` is unset. That is a real pod
 * misconfiguration (delegation cannot work without it — it is the plaintext
 * `provision.ts` hashes into the `is_internal` row), and the empty bearer makes
 * it fail loudly at the read instead of silently reading as the wrong identity.
 */
export function getPodReadKey(): string {
  return process.env.HUB_PROTOCOL_API_KEY || "";
}
