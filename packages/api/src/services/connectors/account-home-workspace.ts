/**
 * The workspace a NEW external channel from a messaging account is pinned to:
 * the account's own pin, else the owner's first workspace. ONE rule for every
 * path that creates a person's channel (the webhook, the history import,
 * `openPersonChannel`), so a channel is never born pod-wide by accident: a
 * SHARED-type channel with no workspace is visible to every member of the pod
 * (`database/src/utils/channel-visibility.ts`, rule 4).
 */

import {
  db,
  and,
  eq,
  asc,
  messagingAccounts,
  workspaces,
} from "@synap/database";

export async function accountHomeWorkspace(account: {
  workspaceId: string | null;
  userId: string;
}): Promise<string | null> {
  if (account.workspaceId) return account.workspaceId;
  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.ownerId, account.userId),
    columns: { id: true },
    orderBy: [asc(workspaces.createdAt)],
  });
  return ws?.id ?? null;
}

/**
 * The same rule from the account's provider id (`messaging_accounts.
 * external_id`); with no account, or one the pod does not mirror, the owner's
 * first workspace.
 */
export async function accountHomeWorkspaceFor(
  userId: string,
  accountExternalId?: string | null
): Promise<string | null> {
  const row = accountExternalId
    ? await db.query.messagingAccounts.findFirst({
        where: and(
          eq(messagingAccounts.userId, userId),
          eq(messagingAccounts.externalId, accountExternalId)
        ),
        columns: { workspaceId: true },
      })
    : undefined;
  return accountHomeWorkspace({
    workspaceId: row?.workspaceId ?? null,
    userId,
  });
}
