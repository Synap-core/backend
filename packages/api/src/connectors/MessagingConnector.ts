export interface MessagingAccount {
  id: string;
  externalId: string;
  provider: string;
  displayName: string;
  status: "connected" | "reconnection_required" | "disconnected";
}

export interface ConversationSummary {
  externalThreadId: string;
  provider: string;
  participantName: string;
  participantExternalId: string;
  lastMessageAt: string;
  lastMessagePreview: string;
  unread: boolean;
}

export interface Message {
  externalMessageId: string;
  threadId: string;
  senderName: string;
  body: string;
  sentAt: string;
  direction: "inbound" | "outbound";
  attachments?: Array<{ name: string; url: string }>;
}

export type WebhookEvent =
  | {
      type: "message.created";
      accountExternalId: string;
      provider: string;
      threadId: string;
      message: Message;
    }
  | {
      type: "account.reconnection_required";
      accountExternalId: string;
      provider: string;
    }
  | {
      type: "account.disconnected";
      accountExternalId: string;
      provider: string;
    }
  | {
      type: "account.created";
      accountExternalId: string;
      provider: string;
      userId: string;
    };

export interface MessagingConnector {
  isConfigured(): boolean;
  /**
   * Whether sending requires a per-user messaging account (resolved from
   * `messaging_accounts`). Default semantics = true (Unipile/Stalwart: each user
   * sends from their own connected account). Server-managed connectors that own
   * a single shared credential (e.g. Discord's bot token) return false, and the
   * send target is resolved from the bound EXTERNAL channel instead — `accountId`
   * is then ignored by `sendMessage`.
   */
  requiresAccount(): boolean;
  getAuthUrl(
    userId: string,
    redirectUrl: string,
    providers?: string[]
  ): Promise<string>;
  getAccounts(userId: string): Promise<MessagingAccount[]>;
  getConversations(
    externalAccountId: string,
    cursor?: string
  ): Promise<{ items: ConversationSummary[]; nextCursor?: string }>;
  getMessages(externalAccountId: string, threadId: string): Promise<Message[]>;
  sendMessage(
    externalAccountId: string,
    threadId: string,
    body: string
  ): Promise<void>;
  parseWebhook(
    headers: Record<string, string>,
    rawBody: string | Buffer
  ): Promise<WebhookEvent | null>;
  /**
   * Permanently remove an account from the provider.
   * The externalId is the provider-side account ID (e.g. Unipile account ID).
   */
  deleteAccount(externalId: string): Promise<void>;
  /**
   * Idempotent: ensures persistent message-event webhooks are registered with
   * the provider. Called after account sync so inbound messages reach our endpoint.
   */
  ensureWebhooksRegistered(publicUrl: string): Promise<void>;
}
