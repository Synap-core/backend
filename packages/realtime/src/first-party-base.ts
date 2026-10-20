/**
 * The realtime server's first-party base, from SYNAP_BASE_DOMAIN. Mirrors
 * `apps/api/src/cors-origin.ts` (a separate process, so the rule is repeated
 * by design): a bare TLD or a tenant zone is never a base, because every other
 * tenant's pod lives under it and would become a credentialed Socket.IO caller.
 */
const TENANT_ZONES: readonly string[] = ["synap.live", "staging.synap.live"];

export function realtimeFirstPartyBase(raw: string | undefined): string | null {
  const base = raw?.trim().replace(/^\.+/, "").toLowerCase();
  if (!base || !base.includes(".") || TENANT_ZONES.includes(base)) return null;
  return base;
}
