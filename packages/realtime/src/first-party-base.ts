import {
  isRefusedFirstPartyBase,
  normalizeHost,
} from "@synap-core/types/tenancy";

/**
 * The realtime server's first-party base, from SYNAP_BASE_DOMAIN. The rule is
 * the one in `@synap-core/types/tenancy` (the API's CORS uses it too): a bare
 * TLD, a tenant zone (`pod.synap.live`, `synap.live`, their staging twins) or a
 * host under a current zone (`alice.pod.synap.live`) is never a base: other
 * tenants' pods, and the sites a tenant runs under its pod's name, would become
 * credentialed Socket.IO callers. A legacy nested base (`alice.synap.live`) is
 * kept until the moves end (decision 1c7398f2).
 */
export function realtimeFirstPartyBase(raw: string | undefined): string | null {
  const base = normalizeHost(raw ?? "");
  if (!base || isRefusedFirstPartyBase(base)) return null;
  return base;
}
