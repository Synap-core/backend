import crypto from "node:crypto";
import { z } from "zod";
import type {
  MessagingConnector,
  MessagingAccount,
  ConversationSummary,
  Message,
  WebhookEvent,
} from "./MessagingConnector.js";

// ── Zod schemas for Unipile API responses ──────────────────────────────────

const UnipileAccountSchema = z.object({
  id: z.string(),
  type: z.string(), // 'LINKEDIN', 'GMAIL', 'WHATSAPP', etc.
  name: z.string().optional(),
  username: z.string().optional(),
  connection_status: z.string().optional(),
});

const UnipileAccountsResponseSchema = z.object({
  items: z.array(UnipileAccountSchema),
});

const UnipileChatSchema = z.object({
  id: z.string(),
  account_id: z.string(),
  attendees: z
    .array(
      z.object({
        id: z.string().optional(),
        name: z.string().optional(),
        provider_id: z.string().optional(),
      })
    )
    .optional(),
  last_message_at: z.string().optional(),
  last_message: z.string().optional(),
  unread: z.boolean().optional(),
});

const UnipileChatsResponseSchema = z.object({
  items: z.array(UnipileChatSchema),
  cursor: z.string().optional(),
});

const UnipileMessageSchema = z.object({
  id: z.string(),
  chat_id: z.string(),
  sender_id: z.string().optional(),
  sender_name: z.string().optional(),
  text: z.string().optional(),
  timestamp: z.string().optional(),
  is_sender: z.boolean().optional(),
  attachments: z
    .array(
      z.object({
        filename: z.string().optional(),
        url: z.string().optional(),
      })
    )
    .optional(),
});

const UnipileMessagesResponseSchema = z.object({
  items: z.array(UnipileMessageSchema),
});

const UnipileAuthLinkResponseSchema = z.object({
  url: z.string(),
});

// ── Helpers ────────────────────────────────────────────────────────────────

function mapProviderType(unipileType: string): string {
  const map: Record<string, string> = {
    LINKEDIN: "linkedin",
    GMAIL: "gmail",
    WHATSAPP: "whatsapp",
    INSTAGRAM: "instagram",
    TELEGRAM: "telegram",
    MESSENGER: "messenger",
    TWITTER: "twitter",
    SLACK: "slack",
  };
  return map[unipileType.toUpperCase()] ?? unipileType.toLowerCase();
}

// ── UnipileConnector ───────────────────────────────────────────────────────

export class UnipileConnector implements MessagingConnector {
  constructor(
    private readonly overrides?: {
      dsn?: string;
      apiKey?: string;
      webhookSecret?: string;
    }
  ) {}

  private get dsn(): string {
    return this.overrides?.dsn || process.env.UNIPILE_DSN || "";
  }
  private get apiKey(): string {
    return this.overrides?.apiKey || process.env.UNIPILE_API_KEY || "";
  }
  private get webhookSecret(): string {
    return (
      this.overrides?.webhookSecret || process.env.UNIPILE_WEBHOOK_SECRET || ""
    );
  }

  isConfigured(): boolean {
    return !!(this.dsn && this.apiKey);
  }

  private headers(): Record<string, string> {
    return {
      "X-API-KEY": this.apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  async getAuthUrl(userId: string, redirectUrl: string): Promise<string> {
    const res = await fetch(`${this.dsn}/api/v1/hosted/accounts/link`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        type: "create",
        api_url: this.dsn,
        expiresOn: new Date(Date.now() + 3600_000).toISOString(),
        success_redirect_url: redirectUrl,
        failure_redirect_url: redirectUrl,
        name: userId,
      }),
    });
    if (!res.ok) throw new Error(`Unipile getAuthUrl failed: ${res.status}`);
    const parsed = UnipileAuthLinkResponseSchema.safeParse(await res.json());
    if (!parsed.success)
      throw new Error("Unipile getAuthUrl: unexpected response");
    return parsed.data.url;
  }

  async getAccounts(_userId: string): Promise<MessagingAccount[]> {
    const res = await fetch(`${this.dsn}/api/v1/accounts`, {
      headers: this.headers(),
    });
    if (!res.ok) return [];
    const parsed = UnipileAccountsResponseSchema.safeParse(await res.json());
    if (!parsed.success) return [];
    return parsed.data.items.map((a) => ({
      id: a.id,
      externalId: a.id,
      provider: mapProviderType(a.type),
      displayName: a.name ?? a.username ?? a.id,
      status:
        a.connection_status === "OK" ? "connected" : "reconnection_required",
    }));
  }

  async getConversations(
    externalAccountId: string,
    cursor?: string
  ): Promise<{ items: ConversationSummary[]; nextCursor?: string }> {
    const params = new URLSearchParams({
      account_id: externalAccountId,
      limit: "50",
    });
    if (cursor) params.set("cursor", cursor);
    const res = await fetch(`${this.dsn}/api/v1/chats?${params}`, {
      headers: this.headers(),
    });
    if (!res.ok) return { items: [] };
    const parsed = UnipileChatsResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { items: [] };
    return {
      items: parsed.data.items.map((c) => {
        const attendee = c.attendees?.[0];
        return {
          externalThreadId: c.id,
          provider: "unknown",
          participantName: attendee?.name ?? "Unknown",
          participantExternalId: attendee?.provider_id ?? attendee?.id ?? "",
          lastMessageAt: c.last_message_at ?? new Date().toISOString(),
          lastMessagePreview: c.last_message ?? "",
          unread: c.unread ?? false,
        };
      }),
      nextCursor: parsed.data.cursor,
    };
  }

  async getMessages(
    externalAccountId: string,
    threadId: string
  ): Promise<Message[]> {
    const res = await fetch(
      `${this.dsn}/api/v1/chats/${threadId}/messages?account_id=${externalAccountId}`,
      { headers: this.headers() }
    );
    if (!res.ok) return [];
    const parsed = UnipileMessagesResponseSchema.safeParse(await res.json());
    if (!parsed.success) return [];
    return parsed.data.items.map((m) => ({
      externalMessageId: m.id,
      threadId,
      senderName: m.sender_name ?? m.sender_id ?? "Unknown",
      body: m.text ?? "",
      sentAt: m.timestamp ?? new Date().toISOString(),
      direction: m.is_sender ? "outbound" : "inbound",
      attachments: m.attachments
        ?.filter((a) => a.url)
        .map((a) => ({ name: a.filename ?? "", url: a.url! })),
    }));
  }

  async sendMessage(
    externalAccountId: string,
    threadId: string,
    body: string
  ): Promise<void> {
    const res = await fetch(`${this.dsn}/api/v1/chats/${threadId}/messages`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ account_id: externalAccountId, text: body }),
    });
    if (!res.ok) throw new Error(`Unipile sendMessage failed: ${res.status}`);
  }

  async parseWebhook(
    headers: Record<string, string>,
    rawBody: string | Buffer
  ): Promise<WebhookEvent | null> {
    const sig =
      headers["x-unipile-signature"] ?? headers["X-Unipile-Signature"];
    if (this.webhookSecret && sig) {
      const body =
        typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
      const expected = crypto
        .createHmac("sha256", this.webhookSecret)
        .update(body)
        .digest("hex");
      if (sig !== expected) return null;
    }
    try {
      const payload = JSON.parse(
        typeof rawBody === "string" ? rawBody : rawBody.toString("utf8")
      ) as Record<string, unknown>;
      const eventType = payload.event as string;
      const accountId = (payload.account_id ?? payload.accountId) as string;
      const provider = mapProviderType(
        (payload.provider ?? payload.account_type ?? "unknown") as string
      );

      if (eventType === "message_created" || eventType === "new_message") {
        const msg = payload.message as Record<string, unknown>;
        return {
          type: "message.created",
          accountExternalId: accountId,
          provider,
          threadId: (payload.chat_id ?? msg?.chat_id) as string,
          message: {
            externalMessageId: (msg?.id ?? "") as string,
            threadId: (payload.chat_id ?? msg?.chat_id ?? "") as string,
            senderName: (msg?.sender_name ?? "") as string,
            body: (msg?.text ?? "") as string,
            sentAt: (msg?.timestamp ?? new Date().toISOString()) as string,
            direction: msg?.is_sender ? "outbound" : "inbound",
          },
        };
      }
      if (
        eventType === "account_reconnection_required" ||
        eventType === "account.reconnection_required"
      ) {
        return {
          type: "account.reconnection_required",
          accountExternalId: accountId,
          provider,
        };
      }
      if (
        eventType === "account_disconnected" ||
        eventType === "account.disconnected"
      ) {
        return {
          type: "account.disconnected",
          accountExternalId: accountId,
          provider,
        };
      }
      return null;
    } catch {
      return null;
    }
  }
}
