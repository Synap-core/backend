/**
 * Hub Protocol REST — messaging
 *
 * Provider-agnostic messaging connector routes (Unipile-backed).
 * All routes return 503 when messaging is not configured.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { sql as drizzleSql } from "drizzle-orm";
import { db, eq, and, messagingAccounts } from "@synap/database";
import type { MessagingAccount as DbMessagingAccount } from "@synap/database";

import { getMessagingConnector } from "../../../connectors/index.js";
import { ErrorSchema } from "./_codecs/_openapi.js";
import { logger, type HubHono } from "./_shared.js";

// ── Shared response schemas ────────────────────────────────────────────────

const MessagingAccountSchema = z
  .object({
    id: z.string(),
    externalId: z.string(),
    provider: z.string(),
    displayName: z.string(),
    status: z.enum(["connected", "reconnection_required", "disconnected"]),
  })
  .openapi("MessagingAccount");

const ConversationSummarySchema = z
  .object({
    externalThreadId: z.string(),
    provider: z.string(),
    participantName: z.string(),
    participantExternalId: z.string(),
    lastMessageAt: z.string(),
    lastMessagePreview: z.string(),
    unread: z.boolean(),
  })
  .openapi("ConversationSummary");

const MessageSchema = z
  .object({
    externalMessageId: z.string(),
    threadId: z.string(),
    senderName: z.string(),
    body: z.string(),
    sentAt: z.string(),
    direction: z.enum(["inbound", "outbound"]),
    attachments: z
      .array(z.object({ name: z.string(), url: z.string() }))
      .optional(),
  })
  .openapi("MessagingMessage");

type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

export function registerMessagingRoutes(app: HubHono): void {
  // ── GET /messaging/accounts ───────────────────────────────────────────────
  const listAccountsRoute = createRoute({
    method: "get",
    path: "/messaging/accounts",
    tags: ["Messaging"],
    summary: "List connected messaging accounts",
    responses: {
      200: {
        description: "List of connected accounts",
        content: {
          "application/json": { schema: z.array(MessagingAccountSchema) },
        },
      },
      500: {
        description: "Internal error",
        content: { "application/json": { schema: ErrorSchema } },
      },
      503: {
        description: "Connector not configured",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(listAccountsRoute, async (c) => {
    const connector = await getMessagingConnector();
    if (!connector)
      return c.json({ error: "Messaging connector not configured" }, 503);
    const userId = c.get("userId") as string;
    try {
      let dbAccounts = await db.query.messagingAccounts.findMany({
        where: eq(messagingAccounts.userId, userId),
      });
      const liveAccounts = await connector.getAccounts(userId).catch(() => []);

      // Auto-seed: if DB has no accounts but Unipile has some (e.g. connected via
      // Unipile dashboard directly), claim all live accounts for this user.
      if (dbAccounts.length === 0 && liveAccounts.length > 0) {
        for (const account of liveAccounts) {
          await db
            .insert(messagingAccounts)
            .values({
              userId,
              provider: account.provider,
              externalId: account.externalId,
              displayName: account.displayName,
              status: account.status,
            })
            .onConflictDoNothing();
        }
        dbAccounts = await db.query.messagingAccounts.findMany({
          where: eq(messagingAccounts.userId, userId),
        });
      }

      const liveByExternalId = new Map(
        liveAccounts.map((a) => [a.externalId, a])
      );
      const result = dbAccounts.map((row: DbMessagingAccount) => {
        const live = liveByExternalId.get(row.externalId);
        return {
          id: row.id,
          externalId: row.externalId,
          provider: row.provider,
          displayName: live?.displayName ?? row.displayName,
          status: (live?.status ?? row.status) as
            | "connected"
            | "reconnection_required"
            | "disconnected",
        };
      });
      return c.json(result, 200);
    } catch (err) {
      logger.error({ err, userId }, "GET /messaging/accounts failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── GET /messaging/auth-url ───────────────────────────────────────────────
  const getAuthUrlRoute = createRoute({
    method: "get",
    path: "/messaging/auth-url",
    tags: ["Messaging"],
    summary: "Get hosted auth URL for connecting a new account",
    request: {
      query: z.object({ redirectUrl: z.string() }),
    },
    responses: {
      200: {
        description: "Auth URL",
        content: {
          "application/json": {
            schema: z.object({ url: z.string() }).openapi("MessagingAuthUrl"),
          },
        },
      },
      500: {
        description: "Internal error",
        content: { "application/json": { schema: ErrorSchema } },
      },
      503: {
        description: "Connector not configured",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(getAuthUrlRoute, async (c) => {
    const connector = await getMessagingConnector();
    if (!connector)
      return c.json({ error: "Messaging connector not configured" }, 503);
    const userId = c.get("userId") as string;
    const { redirectUrl } = c.req.valid("query");
    try {
      const url = await connector.getAuthUrl(userId, redirectUrl);
      return c.json({ url }, 200);
    } catch (err) {
      logger.error({ err, userId }, "GET /messaging/auth-url failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── POST /messaging/accounts/sync ────────────────────────────────────────
  const syncAccountsRoute = createRoute({
    method: "post",
    path: "/messaging/accounts/sync",
    tags: ["Messaging"],
    summary: "Sync live accounts from the connector into the database",
    responses: {
      200: {
        description: "Sync result",
        content: {
          "application/json": {
            schema: z
              .object({ synced: z.number() })
              .openapi("MessagingAccountsSyncResult"),
          },
        },
      },
      500: {
        description: "Internal error",
        content: { "application/json": { schema: ErrorSchema } },
      },
      503: {
        description: "Connector not configured",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(syncAccountsRoute, async (c) => {
    const connector = await getMessagingConnector();
    if (!connector)
      return c.json({ error: "Messaging connector not configured" }, 503);
    const userId = c.get("userId") as string;
    try {
      const liveAccounts = await connector.getAccounts(userId);
      if (liveAccounts.length === 0) return c.json({ synced: 0 }, 200);

      for (const account of liveAccounts) {
        await db
          .insert(messagingAccounts)
          .values({
            userId,
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
              displayName: drizzleSql`excluded.display_name`,
              status: drizzleSql`excluded.status`,
              updatedAt: new Date(),
            },
          });
      }

      return c.json({ synced: liveAccounts.length }, 200);
    } catch (err) {
      logger.error({ err, userId }, "POST /messaging/accounts/sync failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── DELETE /messaging/accounts/:accountId ─────────────────────────────────
  const deleteAccountRoute = createRoute({
    method: "delete",
    path: "/messaging/accounts/{accountId}",
    tags: ["Messaging"],
    summary: "Disconnect a messaging account",
    request: {
      params: z.object({ accountId: z.string() }),
    },
    responses: {
      200: {
        description: "Account disconnected",
        content: {
          "application/json": {
            schema: z
              .object({ success: z.boolean() })
              .openapi("MessagingDeleteResult"),
          },
        },
      },
      500: {
        description: "Internal error",
        content: { "application/json": { schema: ErrorSchema } },
      },
      503: {
        description: "Connector not configured",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(deleteAccountRoute, async (c) => {
    const connector = await getMessagingConnector();
    if (!connector)
      return c.json({ error: "Messaging connector not configured" }, 503);
    const userId = c.get("userId") as string;
    const { accountId } = c.req.valid("param");
    try {
      await db
        .update(messagingAccounts)
        .set({ status: "disconnected", updatedAt: new Date() })
        .where(
          and(
            eq(messagingAccounts.id, accountId),
            eq(messagingAccounts.userId, userId)
          )
        );
      return c.json({ success: true }, 200);
    } catch (err) {
      logger.error(
        { err, accountId },
        "DELETE /messaging/accounts/:accountId failed"
      );
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── GET /messaging/conversations ──────────────────────────────────────────
  const listConversationsRoute = createRoute({
    method: "get",
    path: "/messaging/conversations",
    tags: ["Messaging"],
    summary: "List conversations across all connected accounts",
    request: {
      query: z.object({
        contactEntityId: z.string().optional(),
      }),
    },
    responses: {
      200: {
        description: "Conversations",
        content: {
          "application/json": { schema: z.array(ConversationSummarySchema) },
        },
      },
      500: {
        description: "Internal error",
        content: { "application/json": { schema: ErrorSchema } },
      },
      503: {
        description: "Connector not configured",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(listConversationsRoute, async (c) => {
    const connector = await getMessagingConnector();
    if (!connector)
      return c.json({ error: "Messaging connector not configured" }, 503);
    const userId = c.get("userId") as string;
    try {
      const connectedAccounts = await db.query.messagingAccounts.findMany({
        where: and(
          eq(messagingAccounts.userId, userId),
          eq(messagingAccounts.status, "connected")
        ),
      });
      const all: ConversationSummary[] = [];
      await Promise.all(
        connectedAccounts.map(async (account: DbMessagingAccount) => {
          try {
            const { items } = await connector.getConversations(
              account.externalId
            );
            all.push(...items);
          } catch (err) {
            logger.warn(
              { err, accountId: account.id },
              "getConversations failed for account"
            );
          }
        })
      );
      return c.json(all, 200);
    } catch (err) {
      logger.error({ err, userId }, "GET /messaging/conversations failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── GET /messaging/conversations/:threadId/messages ───────────────────────
  const getMessagesRoute = createRoute({
    method: "get",
    path: "/messaging/conversations/{threadId}/messages",
    tags: ["Messaging"],
    summary: "Get messages in a conversation thread",
    request: {
      params: z.object({ threadId: z.string() }),
      query: z.object({ accountId: z.string() }),
    },
    responses: {
      200: {
        description: "Messages",
        content: { "application/json": { schema: z.array(MessageSchema) } },
      },
      500: {
        description: "Internal error",
        content: { "application/json": { schema: ErrorSchema } },
      },
      503: {
        description: "Connector not configured",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(getMessagesRoute, async (c) => {
    const connector = await getMessagingConnector();
    if (!connector)
      return c.json({ error: "Messaging connector not configured" }, 503);
    const { threadId } = c.req.valid("param");
    const { accountId } = c.req.valid("query");
    try {
      const messages = await connector.getMessages(accountId, threadId);
      return c.json(messages, 200);
    } catch (err) {
      logger.error({ err, threadId, accountId }, "GET messages failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── POST /messaging/conversations/:threadId/send ──────────────────────────
  const sendMessageRoute = createRoute({
    method: "post",
    path: "/messaging/conversations/{threadId}/send",
    tags: ["Messaging"],
    summary: "Send a message in a conversation thread",
    request: {
      params: z.object({ threadId: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z
              .object({ accountId: z.string(), body: z.string() })
              .openapi("SendMessageRequest"),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Message sent",
        content: {
          "application/json": {
            schema: z
              .object({ success: z.boolean() })
              .openapi("SendMessageResult"),
          },
        },
      },
      500: {
        description: "Internal error",
        content: { "application/json": { schema: ErrorSchema } },
      },
      503: {
        description: "Connector not configured",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(sendMessageRoute, async (c) => {
    const connector = await getMessagingConnector();
    if (!connector)
      return c.json({ error: "Messaging connector not configured" }, 503);
    const { threadId } = c.req.valid("param");
    const { accountId, body } = c.req.valid("json");
    try {
      await connector.sendMessage(accountId, threadId, body);
      return c.json({ success: true }, 200);
    } catch (err) {
      logger.error({ err, threadId, accountId }, "POST send failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
