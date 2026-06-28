/**
 * DiscordConnector — a MessagingConnector that posts agent replies back to a
 * Discord channel via the Discord REST API.
 *
 * V0 scope (BYOA Discord bridge): OUTBOUND ONLY. Sending a message needs no
 * gateway/websocket connection — a single authenticated REST call to
 * `POST /channels/{channelId}/messages` is sufficient. Inbound is handled by a
 * separate Discord-side bot process that calls
 * `POST /api/hub/discord/agent-turn`; this connector never reads from Discord.
 *
 * Auth: bot token from `DISCORD_BOT_TOKEN`, sent as `Authorization: Bot <token>`
 * (the literal "Bot " prefix is required by Discord).
 *
 * Provider id: "discord". On EXTERNAL channels `externalSource` is "discord" and
 * `externalChannelId` / `threadId` is the Discord channel snowflake id — which is
 * exactly what `sendMessage(threadId, ...)` receives as its `threadId`.
 *
 * The other MessagingConnector interface methods are minimal stubs: Discord
 * accounts/conversations/messages are not synced into the inbox in V0, and
 * webhooks are not registered here (the bot process owns inbound).
 */

import type {
  MessagingConnector,
  MessagingAccount,
  ConversationSummary,
  Message,
  WebhookEvent,
} from "./MessagingConnector.js";

const DISCORD_API_BASE = "https://discord.com/api/v10";

export class DiscordConnector implements MessagingConnector {
  constructor(private readonly overrides?: { botToken?: string }) {}

  private get botToken(): string {
    return this.overrides?.botToken || process.env.DISCORD_BOT_TOKEN || "";
  }

  isConfigured(): boolean {
    return !!this.botToken;
  }

  /**
   * Discord is server-managed (single shared bot token), so it needs no per-user
   * messaging account. The send target is the bound EXTERNAL channel; `sendMessage`
   * ignores its accountId argument.
   */
  requiresAccount(): boolean {
    return false;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bot ${this.botToken}`,
      "Content-Type": "application/json",
      // Discord requires a User-Agent for bot requests.
      "User-Agent": "Synap-Discord-Bridge (https://synap, v0)",
    };
  }

  /**
   * Post a message into a Discord channel. `threadId` is the Discord channel id
   * (snowflake). Sending requires no gateway connection — a single REST call.
   */
  async sendMessage(
    _externalAccountId: string,
    threadId: string,
    body: string
  ): Promise<void> {
    const res = await fetch(
      `${DISCORD_API_BASE}/channels/${threadId}/messages`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ content: body }),
      }
    );
    if (res.status === 429) {
      // Rate limited. Surface Retry-After cleanly; no auto-retry loop here.
      const retryAfter = res.headers.get("Retry-After") ?? "unknown";
      throw new Error(
        `Discord sendMessage rate limited (429) — retry after ${retryAfter}s`
      );
    }
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(
        `Discord sendMessage failed: ${res.status}${errBody ? ` — ${errBody.slice(0, 200)}` : ""}`
      );
    }
  }

  /**
   * Rename a Discord channel via PATCH /channels/{channelId}.
   * Discord allows ~2 renames per 10 minutes per channel — callers should
   * debounce and handle the 429 (rate-limit) error thrown here.
   */
  async renameChannel(channelId: string, name: string): Promise<void> {
    const res = await fetch(`${DISCORD_API_BASE}/channels/${channelId}`, {
      method: "PATCH",
      headers: this.headers(),
      body: JSON.stringify({ name }),
    });
    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After") ?? "unknown";
      throw new Error(
        `Discord renameChannel rate limited (429) — retry after ${retryAfter}s`
      );
    }
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(
        `Discord renameChannel failed: ${res.status}${errBody ? ` — ${errBody.slice(0, 200)}` : ""}`
      );
    }
  }

  /**
   * Pin a message in a Discord channel via PUT /channels/{channelId}/pins/{messageId}.
   * Discord allows ~5 pins per 10 seconds per channel; callers should handle the
   * 429 (rate-limit) error thrown here.
   */
  async pinMessage(channelId: string, messageId: string): Promise<void> {
    const res = await fetch(
      `${DISCORD_API_BASE}/channels/${channelId}/pins/${messageId}`,
      {
        method: "PUT",
        headers: this.headers(),
      }
    );
    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After") ?? "unknown";
      throw new Error(
        `Discord pinMessage rate limited (429) — retry after ${retryAfter}s`
      );
    }
    if (res.status !== 204 && !res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(
        `Discord pinMessage failed: ${res.status}${errBody ? ` — ${errBody.slice(0, 200)}` : ""}`
      );
    }
    // 204 No Content = success
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
