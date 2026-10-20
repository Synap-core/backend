import { isRefusedSiteBase, normalizeHost } from "@synap-core/types/tenancy";

/**
 * The realtime server's first-party base, from SYNAP_BASE_DOMAIN. The rule is
 * the one in `@synap-core/types/tenancy` (the API's CORS uses it too): a bare
 * TLD or a tenant zone (`pod.synap.live`, `synap.live`, their staging twins) is
 * never a base, because every other tenant's pod lives under it and would
 * become a credentialed Socket.IO caller.
 */
export function realtimeFirstPartyBase(raw: string | undefined): string | null {
  const base = normalizeHost(raw ?? "");
  if (!base || isRefusedSiteBase(base)) return null;
  return base;
}
