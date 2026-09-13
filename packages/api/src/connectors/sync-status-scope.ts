/**
 * Scope connection-sync status to the connections a user owns.
 *
 * `getConnectionSyncStatus` reports every connection on the pod. A per-connection
 * row carries that connection's id, error, proposal and counts — another member's
 * data. Rows without a `connectionId` are provider-level (e.g. "sync on, no
 * connection") and carry nothing connection-specific, so they are kept.
 */
export function scopeSyncStatusToUser<T extends { connectionId?: string }>(
  rows: T[],
  ownedConnectionIds: ReadonlySet<string>
): T[] {
  return rows.filter(
    (r) => !r.connectionId || ownedConnectionIds.has(r.connectionId)
  );
}
