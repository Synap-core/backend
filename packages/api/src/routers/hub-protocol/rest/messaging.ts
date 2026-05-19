/**
 * Hub Protocol REST — messaging
 *
 * Provider-agnostic messaging connector routes (Unipile-backed).
 *
 * Architecture:
 *   External channels (channelType="external") are the canonical link between
 *   a CRM entity and an external conversation thread. Each external channel
 *   stores: externalSource (provider), externalChannelId (Unipile chat ID),
 *   and metadata.accountId (which messaging_accounts row owns the thread).
 *
 *   Multi-user access: when the current user has their own account for the
 *   same provider they can reply; otherwise they get read-only view through
 *   the channel owner's account.
 */

import { createHash } from "crypto";
import { createRoute, z } from "@hono/zod-openapi";
import { sql as drizzleSql, desc } from "drizzle-orm";
import {
  db,
  eq,
  and,
  messagingAccounts,
  channels,
  messages,
  ChannelType,
  ChannelScope,
  MessageRole,
  MessageAuthorType,
  MessageCategory,
} from "@synap/database";
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

const LinkedConversationSchema = z
  .object({
    channelId: z.string(),
    externalThreadId: z.string(),
    provider: z.string(),
    participantName: z.string(),
    participantExternalId: z.string(),
    lastMessageAt: z.string(),
    lastMessagePreview: z.string(),
    unread: z.boolean(),
    accountId: z.string(),
    readOnly: z.boolean(),
  })
  .openapi("LinkedConversation");

const BrowseConversationSchema = z
  .object({
    externalThreadId: z.string(),
    provider: z.string(),
    participantName: z.string(),
    participantExternalId: z.string(),
    lastMessageAt: z.string(),
    lastMessagePreview: z.string(),
    unread: z.boolean(),
    accountId: z.string(),
    accountDisplayName: z.string(),
  })
  .openapi("BrowseConversation");

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

// ── Helpers ────────────────────────────────────────────────────────────────

type ChannelMetadata = {
  accountId?: string;
  participantName?: string;
  linkedByUserId?: string;
  // Cached by webhook handler on every inbound message (avoids Unipile calls in linked-unread)
  lastMessageAt?: string;
  lastMessagePreview?: string;
  unread?: boolean;
};

export function registerMessagingRoutes(app: HubHono): void {
  // ── GET /messaging/accounts ───────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/messaging/accounts",
      tags: ["Messaging"],
      summary: "List connected messaging accounts for the current user",
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
    }),
    async (c) => {
      const connector = await getMessagingConnector();
      if (!connector)
        return c.json({ error: "Messaging connector not configured" }, 503);
      const userId = c.get("userId") as string;
      try {
        let dbAccounts = await db.query.messagingAccounts.findMany({
          where: eq(messagingAccounts.userId, userId),
        });
        const liveAccounts = await connector
          .getAccounts(userId)
          .catch(() => []);

        // Auto-seed: claim all live accounts for this user if DB is empty.
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
        // Unipile is the source of truth for live status.
        // Merge live status first, then filter — so a DB-"disconnected" row
        // that Unipile still has running gets revived rather than hidden.
        const result = dbAccounts
          .map((row: DbMessagingAccount) => {
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
          })
          .filter((row) => row.status !== "disconnected");
        return c.json(result, 200);
      } catch (err) {
        logger.error({ err, userId }, "GET /messaging/accounts failed");
        return c.json(
          { error: err instanceof Error ? err.message : "Unknown error" },
          500
        );
      }
    }
  );

  // ── GET /messaging/auth-url ───────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/messaging/auth-url",
      tags: ["Messaging"],
      summary: "Get hosted auth URL for connecting a new account",
      request: {
        query: z.object({
          redirectUrl: z.string(),
          provider: z.string().optional(),
        }),
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
    }),
    async (c) => {
      const connector = await getMessagingConnector();
      if (!connector)
        return c.json({ error: "Messaging connector not configured" }, 503);
      const userId = c.get("userId") as string;
      const { redirectUrl, provider } = c.req.valid("query");
      const providers = provider ? [provider] : undefined;
      try {
        const url = await connector.getAuthUrl(userId, redirectUrl, providers);
        return c.json({ url }, 200);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        logger.error(
          { err, userId, message },
          "GET /messaging/auth-url failed"
        );
        c.header("Cache-Control", "no-store");
        return c.json({ error: message }, 500);
      }
    }
  );

  // ── POST /messaging/accounts/sync ────────────────────────────────────────
  app.openapi(
    createRoute({
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
    }),
    async (c) => {
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

        // Ensure Unipile message-event webhooks are registered so inbound
        // messages reach our endpoint. Non-fatal: sync succeeds even if this fails.
        const publicUrl = process.env.PUBLIC_URL;
        if (publicUrl) {
          connector.ensureWebhooksRegistered(publicUrl).catch((err) => {
            logger.warn(
              { err },
              "POST /messaging/accounts/sync: webhook registration failed (non-fatal)"
            );
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
    }
  );

  // ── DELETE /messaging/accounts/:accountId ─────────────────────────────────
  app.openapi(
    createRoute({
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
    }),
    async (c) => {
      const connector = await getMessagingConnector();
      if (!connector)
        return c.json({ error: "Messaging connector not configured" }, 503);
      const userId = c.get("userId") as string;
      const { accountId } = c.req.valid("param");
      try {
        // Look up the externalId before deleting the DB row
        const row = await db.query.messagingAccounts.findFirst({
          where: and(
            eq(messagingAccounts.id, accountId),
            eq(messagingAccounts.userId, userId)
          ),
        });

        if (!row) return c.json({ success: true }, 200);

        // Mark as disconnected in DB first so it's hidden immediately
        await db
          .update(messagingAccounts)
          .set({ status: "disconnected", updatedAt: new Date() })
          .where(eq(messagingAccounts.id, accountId));

        // Actually remove from Unipile so sync doesn't revive it. Non-fatal.
        connector.deleteAccount(row.externalId).catch((err) => {
          logger.warn(
            { err, externalId: row.externalId },
            "DELETE /messaging/accounts: Unipile delete failed (non-fatal)"
          );
        });

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
    }
  );

  // ── GET /messaging/conversations ──────────────────────────────────────────
  // When entityId is provided: returns conversations linked to that entity
  //   via EXTERNAL channels (with readOnly flag for cross-user access).
  // When entityId is omitted: browse mode — all conversations from the
  //   current user's connected accounts (for use in the link picker).
  app.openapi(
    createRoute({
      method: "get",
      path: "/messaging/conversations",
      tags: ["Messaging"],
      summary: "List conversations — entity-linked or browse mode",
      request: {
        query: z.object({
          entityId: z.string().optional(),
          // Legacy param — treated as entityId alias
          contactEntityId: z.string().optional(),
        }),
      },
      responses: {
        200: {
          description: "Conversations",
          content: {
            "application/json": {
              schema: z
                .object({
                  conversations: z.array(
                    z.union([
                      LinkedConversationSchema,
                      BrowseConversationSchema,
                    ])
                  ),
                })
                .openapi("ConversationsResult"),
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
    }),
    async (c) => {
      const connector = await getMessagingConnector();
      if (!connector)
        return c.json({ error: "Messaging connector not configured" }, 503);
      const userId = c.get("userId") as string;
      const { entityId, contactEntityId } = c.req.valid("query");
      const resolvedEntityId = entityId ?? contactEntityId;

      try {
        // ── Entity mode: return conversations linked via EXTERNAL channels ──
        if (resolvedEntityId) {
          const entityChannels = await db.query.channels.findMany({
            where: and(
              eq(channels.channelType, ChannelType.EXTERNAL),
              eq(channels.contextObjectType, "entity"),
              eq(channels.contextObjectId as any, resolvedEntityId)
            ),
          });

          // Current user's accounts by provider for readOnly check
          const userAccounts = await db.query.messagingAccounts.findMany({
            where: and(
              eq(messagingAccounts.userId, userId),
              eq(messagingAccounts.status, "connected")
            ),
          });
          const userAccountByProvider = new Map(
            userAccounts.map((a) => [a.provider, a])
          );

          // Build per-channel metadata; determine effective account per channel
          type ConvSummary = {
            externalThreadId: string;
            participantName: string;
            participantExternalId: string;
            lastMessageAt: string;
            lastMessagePreview: string;
            unread: boolean;
          };
          type Entry = {
            ch: (typeof entityChannels)[0];
            meta: ChannelMetadata;
            provider: string;
            effectiveAccountId: string;
            readOnly: boolean;
          };
          const entries: Entry[] = entityChannels.map((ch) => {
            const meta = (ch.metadata ?? {}) as ChannelMetadata;
            const provider = ch.externalSource ?? "";
            const ownAccount = userAccountByProvider.get(provider);
            const effectiveAccountId =
              ownAccount?.externalId ?? meta.accountId ?? "";
            return {
              ch,
              meta,
              provider,
              effectiveAccountId,
              readOnly: !ownAccount,
            };
          });

          // Batch: fetch conversations once per unique effective account
          const uniqueAccountIds = [
            ...new Set(
              entries.map((e) => e.effectiveAccountId).filter(Boolean)
            ),
          ];
          const convCache = new Map<string, ConvSummary[]>();
          await Promise.all(
            uniqueAccountIds.map(async (accountId) => {
              try {
                const { items } = await connector.getConversations(accountId);
                convCache.set(accountId, items);
              } catch {
                convCache.set(accountId, []);
              }
            })
          );

          const results = entries.map(
            ({ ch, meta, provider, effectiveAccountId, readOnly }) => {
              const threadId = ch.externalChannelId ?? "";
              const match = (convCache.get(effectiveAccountId) ?? []).find(
                (i) => i.externalThreadId === threadId
              );
              return {
                channelId: ch.id,
                externalThreadId: threadId,
                provider,
                participantName:
                  match?.participantName ?? meta.participantName ?? "Unknown",
                participantExternalId: match?.participantExternalId ?? "",
                lastMessageAt: match?.lastMessageAt ?? new Date().toISOString(),
                lastMessagePreview: match?.lastMessagePreview ?? "",
                unread: match?.unread ?? false,
                accountId: effectiveAccountId,
                readOnly,
              };
            }
          );

          return c.json({ conversations: results }, 200);
        }

        // ── Browse mode: all conversations from current user's accounts ─────
        const connectedAccounts = await db.query.messagingAccounts.findMany({
          where: and(
            eq(messagingAccounts.userId, userId),
            eq(messagingAccounts.status, "connected")
          ),
        });

        const browse: Array<{
          externalThreadId: string;
          provider: string;
          participantName: string;
          participantExternalId: string;
          lastMessageAt: string;
          lastMessagePreview: string;
          unread: boolean;
          accountId: string;
          accountDisplayName: string;
        }> = [];

        await Promise.all(
          connectedAccounts.map(async (account: DbMessagingAccount) => {
            try {
              const { items } = await connector.getConversations(
                account.externalId
              );
              browse.push(
                ...items.map((i) => ({
                  ...i,
                  accountId: account.externalId,
                  accountDisplayName: account.displayName,
                }))
              );
            } catch (err) {
              logger.warn(
                { err, accountId: account.id },
                "getConversations failed for account"
              );
            }
          })
        );

        return c.json({ conversations: browse }, 200);
      } catch (err) {
        logger.error({ err, userId }, "GET /messaging/conversations failed");
        return c.json(
          { error: err instanceof Error ? err.message : "Unknown error" },
          500
        );
      }
    }
  );

  // ── POST /messaging/channels/connect ─────────────────────────────────────
  // Creates an EXTERNAL channel linking a conversation thread to a CRM entity.
  app.openapi(
    createRoute({
      method: "post",
      path: "/messaging/channels/connect",
      tags: ["Messaging"],
      summary: "Link an external conversation thread to a CRM entity",
      request: {
        body: {
          content: {
            "application/json": {
              schema: z
                .object({
                  entityId: z.string(),
                  externalThreadId: z.string(),
                  accountId: z.string(),
                  provider: z.string(),
                  participantName: z.string().optional(),
                })
                .openapi("ConnectChannelRequest"),
            },
          },
        },
      },
      responses: {
        200: {
          description: "Channel created or already exists",
          content: {
            "application/json": {
              schema: z
                .object({ channelId: z.string() })
                .openapi("ConnectChannelResult"),
            },
          },
        },
        400: {
          description: "Account not found or not owned by current user",
          content: { "application/json": { schema: ErrorSchema } },
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
    }),
    async (c) => {
      const userId = c.get("userId") as string;
      const {
        entityId,
        externalThreadId,
        accountId,
        provider,
        participantName,
      } = c.req.valid("json");

      try {
        // Verify the account belongs to the current user (by DB id or externalId)
        const account = await db.query.messagingAccounts.findFirst({
          where: and(
            eq(messagingAccounts.userId, userId),
            eq(messagingAccounts.externalId, accountId)
          ),
        });
        if (!account) {
          return c.json(
            { error: "Account not found or not owned by current user" },
            400
          );
        }

        // Upsert the EXTERNAL channel — idempotent via externalId unique index
        const [existing] = await db
          .select({ id: channels.id })
          .from(channels)
          .where(
            and(
              eq(channels.externalSource, provider),
              eq(channels.externalId as any, externalThreadId),
              eq(channels.contextObjectType, "entity"),
              eq(channels.contextObjectId as any, entityId)
            )
          )
          .limit(1);

        if (existing) {
          return c.json({ channelId: existing.id }, 200);
        }

        const [inserted] = await db
          .insert(channels)
          .values({
            userId,
            channelType: ChannelType.EXTERNAL,
            scope: ChannelScope.WORKSPACE,
            contextObjectType: "entity",
            contextObjectId: entityId as any,
            externalSource: provider,
            externalChannelId: externalThreadId,
            externalId: externalThreadId,
            title: participantName ?? provider,
            metadata: {
              accountId: account.externalId,
              participantName: participantName ?? "",
              linkedByUserId: userId,
            },
          })
          .returning({ id: channels.id });

        return c.json({ channelId: inserted.id }, 200);
      } catch (err) {
        logger.error(
          { err, userId, entityId, externalThreadId },
          "POST /messaging/channels/connect failed"
        );
        return c.json(
          { error: err instanceof Error ? err.message : "Unknown error" },
          500
        );
      }
    }
  );

  // ── DELETE /messaging/channels/:channelId ─────────────────────────────────
  // Unlinks an external channel from an entity (deletes the channel row).
  app.openapi(
    createRoute({
      method: "delete",
      path: "/messaging/channels/{channelId}",
      tags: ["Messaging"],
      summary: "Unlink an external conversation from a CRM entity",
      request: {
        params: z.object({ channelId: z.string() }),
      },
      responses: {
        200: {
          description: "Channel unlinked",
          content: {
            "application/json": {
              schema: z
                .object({ success: z.boolean() })
                .openapi("UnlinkChannelResult"),
            },
          },
        },
        404: {
          description: "Channel not found",
          content: { "application/json": { schema: ErrorSchema } },
        },
        500: {
          description: "Internal error",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId") as string;
      const { channelId } = c.req.valid("param");
      try {
        const [deleted] = await db
          .delete(channels)
          .where(
            and(
              eq(channels.id as any, channelId),
              eq(channels.channelType, ChannelType.EXTERNAL),
              eq(channels.contextObjectType, "entity")
            )
          )
          .returning({ id: channels.id });

        if (!deleted) return c.json({ error: "Channel not found" }, 404);
        return c.json({ success: true }, 200);
      } catch (err) {
        logger.error(
          { err, userId, channelId },
          "DELETE /messaging/channels/:channelId failed"
        );
        return c.json(
          { error: err instanceof Error ? err.message : "Unknown error" },
          500
        );
      }
    }
  );

  // ── POST /messaging/channels/:channelId/mark-read ─────────────────────────
  // Clears the unread flag in channel metadata. Called when the user opens
  // a thread in CommunicationsTab. Keeps linked-unread count accurate.
  app.openapi(
    createRoute({
      method: "post",
      path: "/messaging/channels/{channelId}/mark-read",
      tags: ["Messaging"],
      summary: "Clear unread flag for a linked channel",
      request: { params: z.object({ channelId: z.string() }) },
      responses: {
        200: {
          description: "Marked as read",
          content: {
            "application/json": {
              schema: z
                .object({ success: z.boolean() })
                .openapi("MarkReadResult"),
            },
          },
        },
        404: {
          description: "Channel not found",
          content: { "application/json": { schema: ErrorSchema } },
        },
        500: {
          description: "Internal error",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      const { channelId } = c.req.valid("param");
      try {
        const [updated] = await db
          .update(channels)
          .set({
            metadata: drizzleSql`${channels.metadata} || '{"unread":false}'::jsonb`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(channels.id as any, channelId),
              eq(channels.channelType, ChannelType.EXTERNAL)
            )
          )
          .returning({ id: channels.id });
        if (!updated) return c.json({ error: "Channel not found" }, 404);
        return c.json({ success: true }, 200);
      } catch (err) {
        logger.error(
          { err, channelId },
          "POST /messaging/channels/:channelId/mark-read failed"
        );
        return c.json(
          { error: err instanceof Error ? err.message : "Unknown error" },
          500
        );
      }
    }
  );

  // ── GET /messaging/linked-unread ─────────────────────────────────────────
  // Returns all unread conversations linked to entities via EXTERNAL channels.
  // Pure DB query using channel metadata cache — no Unipile calls.
  // Cache is updated by the webhook handler on every inbound message.
  app.openapi(
    createRoute({
      method: "get",
      path: "/messaging/linked-unread",
      tags: ["Messaging"],
      summary: "All unread conversations linked to entities",
      responses: {
        200: {
          description: "Unread linked conversations",
          content: {
            "application/json": {
              schema: z
                .object({
                  items: z.array(
                    z
                      .object({
                        entityId: z.string(),
                        channelId: z.string(),
                        externalThreadId: z.string(),
                        provider: z.string(),
                        participantName: z.string(),
                        lastMessagePreview: z.string(),
                        lastMessageAt: z.string(),
                      })
                      .openapi("LinkedUnreadItem")
                  ),
                })
                .openapi("LinkedUnreadResult"),
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
    }),
    async (c) => {
      const connector = await getMessagingConnector();
      if (!connector)
        return c.json({ error: "Messaging connector not configured" }, 503);
      const userId = c.get("userId") as string;

      try {
        const allLinked = await db.query.channels.findMany({
          where: and(
            eq(channels.channelType, ChannelType.EXTERNAL),
            eq(channels.contextObjectType, "entity")
          ),
        });
        if (allLinked.length === 0) return c.json({ items: [] }, 200);

        const userAccounts = await db.query.messagingAccounts.findMany({
          where: and(
            eq(messagingAccounts.userId, userId),
            eq(messagingAccounts.status, "connected")
          ),
        });
        const accountByProvider = new Map(
          userAccounts.map((a) => [a.provider, a])
        );

        type ChEntry = {
          ch: (typeof allLinked)[0];
          meta: ChannelMetadata;
          effectiveAccountId: string;
        };
        const entries: ChEntry[] = allLinked
          .map((ch) => {
            const meta = (ch.metadata ?? {}) as ChannelMetadata;
            const provider = ch.externalSource ?? "";
            const ownAccount = accountByProvider.get(provider);
            const effectiveAccountId =
              ownAccount?.externalId ?? meta.accountId ?? "";
            return { ch, meta, effectiveAccountId };
          })
          .filter((e) => e.effectiveAccountId !== "");

        // Use channel metadata cache (populated by webhook handler on every inbound message).
        // No Unipile calls needed — O(1) DB query instead of O(N accounts) API calls.
        const items = entries
          .map(({ ch, meta }) => {
            if (!meta.unread) return null;
            return {
              entityId: (ch.contextObjectId ?? "") as string,
              channelId: ch.id,
              externalThreadId: ch.externalChannelId ?? "",
              provider: ch.externalSource ?? "",
              participantName: meta.participantName ?? "Unknown",
              lastMessagePreview: meta.lastMessagePreview ?? "",
              lastMessageAt: meta.lastMessageAt ?? new Date().toISOString(),
            };
          })
          .filter((x): x is NonNullable<typeof x> => x !== null);

        return c.json({ items }, 200);
      } catch (err) {
        logger.error({ err, userId }, "GET /messaging/linked-unread failed");
        return c.json(
          { error: err instanceof Error ? err.message : "Unknown error" },
          500
        );
      }
    }
  );

  // ── GET /messaging/conversations/:threadId/messages ───────────────────────
  app.openapi(
    createRoute({
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
    }),
    async (c) => {
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
    }
  );

  // ── POST /messaging/conversations/:threadId/send ──────────────────────────
  app.openapi(
    createRoute({
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
    }),
    async (c) => {
      const connector = await getMessagingConnector();
      if (!connector)
        return c.json({ error: "Messaging connector not configured" }, 503);
      const userId = c.get("userId") as string;
      const { threadId } = c.req.valid("param");
      const { accountId, body } = c.req.valid("json");
      try {
        await connector.sendMessage(accountId, threadId, body);

        // Mirror the outbound message into the messages table so the DB inbox
        // shows a complete conversation history (inbound + outbound).
        const linkedChannel = await db.query.channels.findFirst({
          where: and(
            eq(channels.channelType, ChannelType.EXTERNAL),
            eq(channels.externalId as any, threadId)
          ),
          columns: { id: true },
        });
        if (linkedChannel) {
          const msgHash = createHash("sha256")
            .update(`outbound:${threadId}:${Date.now()}:${body}`)
            .digest("hex");
          await db
            .insert(messages)
            .values({
              channelId: linkedChannel.id,
              userId,
              role: MessageRole.USER,
              authorType: MessageAuthorType.HUMAN,
              messageCategory: MessageCategory.CHAT,
              content: body,
              hash: msgHash,
            })
            .onConflictDoNothing();
        }

        return c.json({ success: true }, 200);
      } catch (err) {
        logger.error({ err, threadId, accountId }, "POST send failed");
        return c.json(
          { error: err instanceof Error ? err.message : "Unknown error" },
          500
        );
      }
    }
  );

  // ── GET /messaging/channels ───────────────────────────────────────────────
  // DB-backed list of all EXTERNAL channels for the current user.
  // Returns threads stored from webhooks — no Unipile calls.
  // Used by the CRM Channels inbox page.
  app.openapi(
    createRoute({
      method: "get",
      path: "/messaging/channels",
      tags: ["Messaging"],
      summary: "List all external channels (DB-backed inbox)",
      request: {
        query: z.object({
          provider: z.string().optional(),
          unreadOnly: z.enum(["true", "false"]).optional(),
        }),
      },
      responses: {
        200: {
          description: "External channels list",
          content: {
            "application/json": {
              schema: z
                .object({
                  channels: z.array(
                    z
                      .object({
                        channelId: z.string(),
                        provider: z.string(),
                        threadId: z.string(),
                        title: z.string(),
                        participantName: z.string(),
                        lastMessageAt: z.string(),
                        lastMessagePreview: z.string(),
                        unread: z.boolean(),
                        entityId: z.string().nullable(),
                        messageCount: z.number(),
                      })
                      .openapi("ExternalChannelItem")
                  ),
                })
                .openapi("ExternalChannelsResult"),
            },
          },
        },
        500: {
          description: "Internal error",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId") as string;
      const { provider, unreadOnly } = c.req.valid("query");

      try {
        const rows = await db.query.channels.findMany({
          where: and(
            eq(channels.channelType, ChannelType.EXTERNAL),
            eq(channels.userId, userId),
            ...(provider ? [eq(channels.externalSource as any, provider)] : [])
          ),
          orderBy: [desc(channels.updatedAt)],
        });

        const result = rows
          .map((ch) => {
            const meta = (ch.metadata ?? {}) as ChannelMetadata;
            if (unreadOnly === "true" && !meta.unread) return null;
            return {
              channelId: ch.id,
              provider: ch.externalSource ?? "",
              threadId: ch.externalChannelId ?? "",
              title: ch.title ?? meta.participantName ?? "Unknown",
              participantName: meta.participantName ?? ch.title ?? "Unknown",
              lastMessageAt: meta.lastMessageAt ?? ch.updatedAt.toISOString(),
              lastMessagePreview: meta.lastMessagePreview ?? "",
              unread: meta.unread ?? false,
              entityId: ch.contextObjectId ?? null,
              messageCount: 0,
            };
          })
          .filter((x): x is NonNullable<typeof x> => x !== null);

        return c.json({ channels: result }, 200);
      } catch (err) {
        logger.error({ err, userId }, "GET /messaging/channels failed");
        return c.json(
          { error: err instanceof Error ? err.message : "Unknown error" },
          500
        );
      }
    }
  );
}
