/**
 * DiscordConnector — a MessagingConnector for OUTBOUND Discord sends.
 *
 * The backend is Discord-AGNOSTIC: it never calls discord.com. This connector's
 * `sendMessage` writes an abstract `post_message` intent to the `channel_egress`
 * outbox; the Discord bridge (the SOLE Discord egress) polls the outbox and
 * delivers it via its own discord.js client. See decision `8304d8c8`.
 *
 * FIREWALL: the bridge owns the firewall (bot/AI output never to client-comms).
 * Sends that reach THIS connector are already governance-authorized upstream
 * (`gateMessagingSend` in external-dispatch: an un-approved AGENT send is
 * proposed/denied and never gets here; owner + approved-proposal sends are
 * human-authorized). So the egress carries `authorType: "human"` — a deliberate,
 * authorized operator→client send that the bridge firewall must let through. The
 * "block un-approved AI" guarantee lives upstream in the gate, not here.
 *
 * Provider id: "discord". `sendMessage`'s `threadId` is the Discord channel
 * snowflake (the bound EXTERNAL channel's externalId), which is exactly the
 * egress `externalId`. The other MessagingConnector methods are V0 stubs (Discord
 * accounts/conversations/messages are not synced into the inbox; the bot process
 * owns inbound). Channel rename/pin no longer go through this connector — those
 * hub routes enqueue `rename_channel` / `pin_message` intents directly.
 */

import { enqueueChannelEgress } from "@synap/database";
import type {
  MessagingConnector,
  MessagingAccount,
  ConversationSummary,
  Message,
  WebhookEvent,
} from "./MessagingConnector.js";

export class DiscordConnector implements MessagingConnector {
  // The bridge holds the bot token; the backend only enqueues, so this connector
  // is always "configured" (no token to check).
  isConfigured(): boolean {
    return true;
  }

  /**
   * Discord is server-managed (single shared bot token on the bridge), so it
   * needs no per-user messaging account. The send target is the bound EXTERNAL
   * channel; `sendMessage` ignores its accountId argument.
   */
  requiresAccount(): boolean {
    return false;
  }

  /**
   * Enqueue an outbound message to a Discord channel. `threadId` is the Discord
   * channel id (snowflake). Never calls Discord — writes a `post_message` intent
   * the bridge delivers. `authorType: "human"` because the send is already
   * authorized upstream (see the file header / firewall note).
   */
  async sendMessage(
    _externalAccountId: string,
    threadId: string,
    body: string
  ): Promise<void> {
    await enqueueChannelEgress({
      externalSource: "discord",
      externalId: threadId,
      kind: "post_message",
      payload: { content: body, authorType: "human" },
    });
  }

  // ── Inbound / sync surface: not used in V0 (bot process owns inbound) ───────

  async getAuthUrl(): Promise<string> {
    throw new Error("DiscordConnector does not support hosted auth URLs");
  }

  async getAccounts(_userId: string): Promise<MessagingAccount[]> {
    return [];
  }

  async getConversations(): Promise<{
    items: ConversationSummary[];
    nextCursor?: string;
  }> {
    return { items: [] };
  }

  async getMessages(): Promise<Message[]> {
    return [];
  }

  async deleteAccount(): Promise<void> {
    // No-op: Discord bot accounts are not managed through this connector.
  }

  async ensureWebhooksRegistered(): Promise<void> {
    // No-op: inbound Discord events arrive via the bot process, not webhooks.
  }

  async parseWebhook(): Promise<WebhookEvent | null> {
    return null;
  }
}
