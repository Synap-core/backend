/**
 * The pod-callback descriptor — where the Intelligence Service should call BACK
 * into this pod over Hub Protocol (`/api/hub/*`) during a turn.
 *
 * It carries ONLY the pod URL. It deliberately does NOT carry a pod-read key:
 * the IS owns its own per-pod key in its directory (`customer.hubProtocolApiKey`,
 * minted + handed to it at registration) and presents that on every callback.
 * The backend never sends — and no longer stores in env — the is_internal key.
 * This is the single-source model: one key per IS, held by the IS, the pod keeps
 * only the bcrypt hash to validate. (Removed the old `dataPodApiKey` field +
 * `HUB_PROTOCOL_API_KEY` env read — that was the multi-source drift that made the
 * agent read 0.)
 *
 * Spread this into the turn payload (`...getPodCallback()`). The
 * `pod-callback.tripwire.test.ts` test forbids hand-writing `dataPodUrl:` /
 * `dataPodApiKey:` anywhere else, so neither field can drift back in.
 *
 * Returns `""` when neither `PUBLIC_URL` nor `BACKEND_URL` is set — a real pod
 * misconfiguration (the pod must know its own public URL); the IS also resolves
 * the URL from its own `customer.dataPodUrl` for SSRF safety, so this is the
 * informational hint, not the authority.
 */
export interface PodCallback {
  dataPodUrl: string;
}

export function getPodCallback(): PodCallback {
  return {
    dataPodUrl:
      process.env.PUBLIC_URL ||
      process.env.BACKEND_URL ||
      (process.env.DOMAIN ? `https://${process.env.DOMAIN}` : ""),
  };
}
