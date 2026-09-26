/**
 * The sync-status facts stored OUTSIDE the sync state, joined onto the rows
 * `getConnectionSyncStatus` builds from it.
 */
import { db, inArray } from "@synap/database";
import { ProposalStatus, proposals, secrets } from "@synap/database/schema";
import type { ConnectionSyncStatusDraft } from "./connection-sync.js";

/**
 * Two facts stored OUTSIDE the sync state, joined in one read each:
 *   - which broker connection a row mirrors, and whether its credential is
 *     known dead (`secrets.account_hint` / `connection_state`);
 *   - whether a failure's enable request is still open. A decided request is
 *     never offered as the fix; an APPROVED one marks the failure `resolved`.
 * A failed read throws — never a row that silently lost its identity.
 */
export async function withConnectionFacts(
  rows: ConnectionSyncStatusDraft[]
): Promise<ConnectionSyncStatusDraft[]> {
  const connectionIds = [
    ...new Set(rows.flatMap((r) => (r.connectionId ? [r.connectionId] : []))),
  ];
  const requestIds = [
    ...new Set(
      rows.flatMap((r) =>
        r.failure?.enableProposalId ? [r.failure.enableProposalId] : []
      )
    ),
  ];
  const [conns, requests] = await Promise.all([
    connectionIds.length === 0
      ? []
      : db
          .select({
            id: secrets.id,
            accountHint: secrets.accountHint,
            connectionState: secrets.connectionState,
          })
          .from(secrets)
          .where(inArray(secrets.id, connectionIds)),
    requestIds.length === 0
      ? []
      : db
          .select({ id: proposals.id, status: proposals.status })
          .from(proposals)
          .where(inArray(proposals.id, requestIds)),
  ]);
  const conn = new Map(conns.map((c) => [String(c.id), c]));
  const requestStatus = new Map(
    requests.map((r) => [String(r.id), String(r.status)])
  );
  return rows.map((row) => {
    const c = row.connectionId ? conn.get(row.connectionId) : undefined;
    const withIdentity: ConnectionSyncStatusDraft = row.connectionId
      ? {
          ...row,
          brokerConnectionId: c?.accountHint ?? null,
          connectionState:
            c?.connectionState === "needs_reauth" ? "needs_reauth" : null,
        }
      : row;
    const requestId = row.failure?.enableProposalId;
    if (!requestId || !row.failure) return withIdentity;
    const status = requestStatus.get(requestId);
    if (status === ProposalStatus.PENDING) return withIdentity;
    const { enableProposalId: _decided, ...failure } = row.failure;
    return {
      ...withIdentity,
      failure: {
        ...failure,
        ...(status === ProposalStatus.APPROVED
          ? { resolved: true as const }
          : {}),
      },
    };
  });
}
