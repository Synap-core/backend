import type { SyncConnectorConnection } from "./SyncConnector.js";

/**
 * Which of a user's broker connections a reconnect left behind: ONE connection
 * per (user, provider) stays, the others are stale (founder, 2026-10-28: "it
 * should always have one connection for each capability and each user").
 *
 * Reconnecting a provider creates a new Nango connection and never clears the
 * old one; on the founder's pod three dead Google connections sat beside the
 * new one, their syncs failing every hour.
 *
 * The one kept is the newest healthy connection (the newest of all when none
 * is healthy). Another is stale only when that is PROVEN:
 * - it is errored (dead credential) while the one kept is healthy, or
 * - both have a creation date and it is older.
 * A connection with no date that is not proven dead is never revoked: the
 * broker did not say which is newer, and guessing could revoke the live one.
 *
 * Object-scoped connections (bound to an entity or project) are a deliberate
 * second account and are never stale.
 */
export function staleConnectionIds(
  connections: readonly SyncConnectorConnection[]
): string[] {
  const byProvider = new Map<string, SyncConnectorConnection[]>();
  for (const c of connections) {
    if (c.objectScoped) continue;
    const group = byProvider.get(c.provider) ?? [];
    group.push(c);
    byProvider.set(c.provider, group);
  }

  const stale: string[] = [];
  for (const group of byProvider.values()) {
    if (group.length < 2) continue;
    const healthy = group.filter((c) => !c.hasError);
    const kept = newest(healthy.length > 0 ? healthy : group);
    for (const c of group) {
      if (c === kept) continue;
      const deadBesideLive = c.hasError === true && !kept.hasError;
      const provenOlder =
        c.createdAt !== null &&
        kept.createdAt !== null &&
        c.createdAt.getTime() < kept.createdAt.getTime();
      if (deadBesideLive || provenOlder) stale.push(c.connectionId);
    }
  }
  return stale;
}

/** The newest by creation date; an undated one never counts as newest. */
function newest(
  group: readonly SyncConnectorConnection[]
): SyncConnectorConnection {
  return group.reduce((best, c) =>
    (c.createdAt?.getTime() ?? -Infinity) >
    (best.createdAt?.getTime() ?? -Infinity)
      ? c
      : best
  );
}
