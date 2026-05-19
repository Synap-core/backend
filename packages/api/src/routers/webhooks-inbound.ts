import { createHash } from "crypto";
import { Hono } from "hono";
import { createLogger } from "@synap-core/core";
import { sql as drizzleSql } from "drizzle-orm";
import {
  db,
  eq,
  and,
  workspaces,
  channels,
  messages,
  messagingAccounts,
  ChannelType,
  ChannelScope,
  MessageRole,
  MessageAuthorType,
  MessageCategory,
} from "@synap/database";
import { emitSideEffects } from "@synap/events";
import { getMessagingConnector } from "../connectors/index.js";
import { MessagingAccountService } from "../services/messaging-account-service.js";

const logger = createLogger({ module: "webhooks-inbound" });

export const webhooksInboundRouter = new Hono();

webhooksInboundRouter.post("/messaging", async (c) => {
  const rawBody = await c.req.text();
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => {
    headers[k] = v;
  });

  const connector = await getMessagingConnector();
  if (!connector) {
    return c.json({ error: "Messaging connector not configured" }, 503);
  }

  let event;
  try {
    event = await connector.parseWebhook(headers, rawBody);
  } catch (err) {
    logger.warn({ err }, "Webhook parse error");
    return c.json({ ok: true }); // always 200 to prevent Unipile retries on auth failures
  }

  if (!event) return c.json({ ok: true });

  try {
    if (event.type === "message.created") {
      const account = await db.query.messagingAccounts.findFirst({
        where: and(
          eq(messagingAccounts.externalId, event.accountExternalId),
          eq(messagingAccounts.provider, event.provider)
        ),
      });
      if (!account) return c.json({ ok: true });

      // Find the workspace owned by this user
      const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.ownerId, account.userId),
      });
      if (!workspace) {
        logger.warn(
          { userId: account.userId },
          "No workspace found for messaging account owner"
        );
        return c.json({ ok: true });
      }

      const senderName = event.message.senderName;
      const messagePreview = event.message.body.slice(0, 120);

      // ── Upsert the EXTERNAL channel row ────────────────────────────────────
      // This is the canonical Synap representation of the external thread.
      // We use (externalSource, externalId) as the unique dedup key.
      let channelId: string;

      const existingChannel = await db.query.channels.findFirst({
        where: and(
          eq(channels.channelType, ChannelType.EXTERNAL),
          eq(channels.externalSource as any, event.provider),
          eq(channels.externalId as any, event.threadId)
        ),
        columns: { id: true, metadata: true, contextObjectId: true },
      });

      if (existingChannel) {
        channelId = existingChannel.id;
        // Update last-message cache in metadata
        await db
          .update(channels)
          .set({
            metadata: drizzleSql`${channels.metadata} || ${JSON.stringify({
              lastMessageAt: event.message.sentAt,
              lastMessagePreview: messagePreview,
              unread: true,
            })}::jsonb`,
            updatedAt: new Date(),
          })
          .where(eq(channels.id, channelId));
      } else {
        const [inserted] = await db
          .insert(channels)
          .values({
            userId: account.userId,
            workspaceId: workspace.id,
            channelType: ChannelType.EXTERNAL,
            scope: ChannelScope.WORKSPACE,
            title: senderName,
            externalSource: event.provider,
            externalChannelId: event.threadId,
            externalId: event.threadId,
            metadata: {
              accountId: account.externalId,
              participantName: senderName,
              lastMessageAt: event.message.sentAt,
              lastMessagePreview: messagePreview,
              unread: true,
            },
          })
          .returning({ id: channels.id });
        channelId = inserted.id;
        logger.info(
          { channelId, provider: event.provider, threadId: event.threadId },
          "Auto-created EXTERNAL channel for inbound message"
        );
      }

      // ── Store the message in the messages table ─────────────────────────────
      // role=user + authorType=external = inbound message from an external contact
      const msgHash = createHash("sha256")
        .update(
          `${event.provider}:${event.threadId}:${event.message.sentAt}:${event.message.body}`
        )
        .digest("hex");

      await db
        .insert(messages)
        .values({
          channelId,
          userId: account.userId,
          role: MessageRole.USER,
          authorType: MessageAuthorType.EXTERNAL,
          messageCategory: MessageCategory.CHAT,
          externalSource: event.provider,
          content: event.message.body,
          hash: msgHash,
          timestamp: new Date(event.message.sentAt),
        })
        .onConflictDoNothing(); // idempotent — webhook may fire more than once

      logger.info(
        { channelId, provider: event.provider, threadId: event.threadId },
        "Inbound message stored"
      );

      // ── Fire automation event ────────────────────────────────────────────────
      // Fire for ALL inbound messages (pre-linked or not). Automations with
      // eventPattern "external_message.received.completed" will match.
      const contextEntityId = (existingChannel as any)?.contextObjectId ?? null;
      await emitSideEffects({
        subjectType: "external_message",
        action: "received",
        subjectId: (contextEntityId ?? channelId) as string,
        userId: account.userId,
        workspaceId: workspace.id,
        data: {
          entityId: contextEntityId as string,
          channelId,
          provider: event.provider,
          threadId: event.threadId,
          participantName: senderName,
          messagePreview,
        },
      }).catch((err) => {
        logger.warn({ err, channelId }, "emitSideEffects failed (non-fatal)");
      });
    } else if (event.type === "account.created") {
      // notify_url callback: auto-sync the newly connected account into our DB
      const connector = await getMessagingConnector();
      if (connector) {
        const liveAccounts = await connector
          .getAccounts(event.userId)
          .catch(() => []);
        const account = liveAccounts.find(
          (a) => a.externalId === event.accountExternalId
        );
        if (account) {
          await MessagingAccountService.upsert({
            userId: event.userId,
            provider: account.provider,
            externalId: account.externalId,
            displayName: account.displayName,
            status: account.status,
          });
          logger.info(
            {
              userId: event.userId,
              externalId: event.accountExternalId,
              provider: account.provider,
            },
            "Account auto-synced after hosted auth connection"
          );
        }
      }
    } else if (event.type === "account.reconnection_required") {
      await MessagingAccountService.updateStatus(
        event.accountExternalId,
        event.provider,
        "reconnection_required",
        event.accountExternalId
      );
      logger.info(
        { externalId: event.accountExternalId },
        "Account reconnection required"
      );
    } else if (event.type === "account.disconnected") {
      await MessagingAccountService.updateStatus(
        event.accountExternalId,
        event.provider,
        "disconnected",
        event.accountExternalId
      );
      logger.info(
        { externalId: event.accountExternalId },
        "Account disconnected"
      );
    }
  } catch (err) {
    logger.error({ err, event }, "Webhook handler error");
  }

  return c.json({ ok: true });
});
