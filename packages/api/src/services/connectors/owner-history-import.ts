/**
 * The OWNER's ask for a messaging account's history import: one door for the
 * two ways it is asked — the person directly (`POST
 * /messaging/accounts/{id}/import-history`) and the person approving an
 * agent's ask (the `messaging/import_history` proposal executor). The run
 * itself is the `messaging-history-import` job
 * (`messaging-history-import.ts`): people already in the pod only, within the
 * daily lookup budget, every message deduplicated.
 *
 * Kept apart from the job's module on purpose: the route and the executor
 * need the account lookup and the queue, not the connector graph the run uses.
 */

import { db, and, eq, messagingAccounts } from "@synap/database";
import { getBoss } from "@synap/events";
import {
  MESSAGING_HISTORY_IMPORT_QUEUE,
  type MessagingHistoryImportJobData,
} from "@synap/jobs/workers/messaging-sync.js";
import { isUuid } from "@synap-core/types/property-render";

/** `messaging_accounts.metadata.historyImport`: the last run's progress. */
export interface OwnerHistoryImportProgress {
  status: "running" | "paused" | "done";
  cursor: string | null;
  updatedAt: string;
  chatsImported: number;
  messagesRecorded: number;
  reason?: string;
}

/** The person's own account, by its pod id or its provider id; null if not theirs. */
export async function findOwnMessagingAccount(
  userId: string,
  accountRef: string
) {
  const row = await db.query.messagingAccounts.findFirst({
    where: and(
      eq(messagingAccounts.userId, userId),
      isUuid(accountRef)
        ? eq(messagingAccounts.id, accountRef)
        : eq(messagingAccounts.externalId, accountRef)
    ),
  });
  return row ?? null;
}

/**
 * Queue one history import of `account` for its owner `userId`. Two runs at
 * once are harmless (every message dedups, and a run holds the account's
 * lease); a standard pg-boss queue enforces no singleton key, so none is
 * claimed.
 */
export async function queueOwnerHistoryImport(
  userId: string,
  account: { id: string; externalId: string; metadata: unknown }
): Promise<{
  queued: boolean;
  accountId: string;
  progress: OwnerHistoryImportProgress | null;
}> {
  const jobId = await getBoss().send(MESSAGING_HISTORY_IMPORT_QUEUE, {
    accountExternalId: account.externalId,
    userId,
  } satisfies MessagingHistoryImportJobData);
  const progress =
    ((account.metadata as Record<string, unknown> | null)?.historyImport as
      OwnerHistoryImportProgress | undefined) ?? null;
  return { queued: !!jobId, accountId: account.id, progress };
}
