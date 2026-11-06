/**
 * The two destructive messaging writes, one door each for the two ways they
 * are asked: the person directly (Hub REST, rest/messaging.ts) and the person
 * approving an agent's ask (the proposal executors in
 * routers/proposals/executors/messaging.ts). Both route callers pass the
 * governance gate first; this module only performs the write, with the same
 * ownership / visibility floor on both paths.
 *
 *  - `messaging/delete_account`: disconnect the person's own account (marked
 *    disconnected here, removed at the provider so a sync cannot revive it).
 *  - `channel/delete_external`: unlink an external conversation from its
 *    entity, which deletes the channel row and, by cascade, its mirrored
 *    messages. Only a channel the caller can see (the channel read floor and
 *    the key's grant, the floor every channel write door uses).
 */

import {
  db,
  and,
  eq,
  messagingAccounts,
  channels,
  ChannelType,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import type { MessagingConnector } from "../../connectors/MessagingConnector.js";
import { channelVisibilityWhere } from "../../utils/channel-visibility.js";

const logger = createLogger({ module: "owner-messaging-writes" });

/** Mark the caller's own account disconnected and remove it at the provider. */
export async function disconnectOwnMessagingAccount(
  connector: Pick<MessagingConnector, "deleteAccount">,
  account: { id: string; externalId: string }
): Promise<void> {
  // Disconnected in the pod first, so it is hidden at once.
  await db
    .update(messagingAccounts)
    .set({ status: "disconnected", updatedAt: new Date() })
    .where(eq(messagingAccounts.id, account.id));
  // Removed at the provider so a sync does not revive it. Non-fatal.
  connector.deleteAccount(account.externalId).catch((err: unknown) => {
    logger.warn(
      { err, externalId: account.externalId },
      "messaging account: provider delete failed (non-fatal)"
    );
  });
}

/** An external channel linked to an entity, if `userId` can see it. */
export async function findVisibleLinkedExternalChannel(
  userId: string,
  channelId: string
): Promise<{ id: string; workspaceId: string | null } | null> {
  const [row] = await db
    .select({ id: channels.id, workspaceId: channels.workspaceId })
    .from(channels)
    .where(
      and(
        eq(channels.id, channelId),
        eq(channels.channelType, ChannelType.EXTERNAL),
        eq(channels.contextObjectType, "entity"),
        channelVisibilityWhere(userId)
      )
    )
    .limit(1);
  return row ?? null;
}

/** Delete that channel (its mirrored messages go with it); false if gone. */
export async function deleteLinkedExternalChannel(
  channelId: string
): Promise<boolean> {
  const [deleted] = await db
    .delete(channels)
    .where(
      and(
        eq(channels.id, channelId),
        eq(channels.channelType, ChannelType.EXTERNAL),
        eq(channels.contextObjectType, "entity")
      )
    )
    .returning({ id: channels.id });
  return !!deleted;
}
