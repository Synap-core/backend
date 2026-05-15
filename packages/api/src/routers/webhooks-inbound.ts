import { Hono } from "hono";
import { createLogger } from "@synap-core/core";
import { sql as drizzleSql } from "drizzle-orm";
import {
  db,
  eq,
  and,
  messagingAccounts,
  entities,
  workspaces,
} from "@synap/database";
import { getMessagingConnector } from "../connectors/index.js";

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

      // Look up a person entity whose email/linkedinUrl/whatsapp matches the sender
      // We use the message senderName as a fallback identifier
      const senderName = event.message.senderName;

      let contactEntityId: string | null = null;
      try {
        const matchedPerson = await db.query.entities.findFirst({
          where: and(
            eq(entities.workspaceId, workspace.id),
            eq(entities.type, "person"),
            drizzleSql`(
              ${entities.properties}->>'email' = ${senderName}
              OR ${entities.properties}->>'linkedinUrl' = ${senderName}
              OR ${entities.properties}->>'whatsapp' = ${senderName}
            )`
          ),
        });
        contactEntityId = matchedPerson?.id ?? null;
      } catch {
        // Non-fatal — proceed without contact link
      }

      // Upsert a conversation entity: query first, then insert or update
      const conversationProps = {
        platform: event.provider,
        threadId: event.threadId,
        contactEntityId,
        accountId: account.id,
        lastMessageAt: event.message.sentAt,
        lastMessagePreview: event.message.body.slice(0, 120),
        unread: true,
      };

      const existingConversation = await db.query.entities.findFirst({
        where: and(
          eq(entities.workspaceId, workspace.id),
          eq(entities.type, "conversation"),
          drizzleSql`${entities.properties}->>'threadId' = ${event.threadId}`,
          drizzleSql`${entities.properties}->>'platform' = ${event.provider}`
        ),
      });

      if (existingConversation) {
        await db
          .update(entities)
          .set({
            properties: drizzleSql`${entities.properties} || ${JSON.stringify(conversationProps)}::jsonb`,
            updatedAt: new Date(),
          })
          .where(eq(entities.id, existingConversation.id));
      } else {
        await db.insert(entities).values({
          userId: account.userId,
          workspaceId: workspace.id,
          type: "conversation",
          title: senderName,
          properties: conversationProps,
        });
      }

      logger.info(
        {
          accountId: account.id,
          threadId: event.threadId,
          workspaceId: workspace.id,
        },
        "Conversation entity upserted"
      );
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
          await db
            .insert(messagingAccounts)
            .values({
              userId: event.userId,
              provider: account.provider,
              externalId: account.externalId,
              displayName: account.displayName,
              status: account.status,
            })
            .onConflictDoUpdate({
              target: [
                messagingAccounts.userId,
                messagingAccounts.provider,
                messagingAccounts.externalId,
              ],
              set: {
                displayName: account.displayName,
                status: account.status,
                updatedAt: new Date(),
              },
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
      await db
        .update(messagingAccounts)
        .set({ status: "reconnection_required", updatedAt: new Date() })
        .where(
          and(
            eq(messagingAccounts.externalId, event.accountExternalId),
            eq(messagingAccounts.provider, event.provider)
          )
        );
      logger.info(
        { externalId: event.accountExternalId },
        "Account reconnection required"
      );
    } else if (event.type === "account.disconnected") {
      await db
        .update(messagingAccounts)
        .set({ status: "disconnected", updatedAt: new Date() })
        .where(
          and(
            eq(messagingAccounts.externalId, event.accountExternalId),
            eq(messagingAccounts.provider, event.provider)
          )
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
