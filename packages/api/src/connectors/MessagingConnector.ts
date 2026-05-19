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
}
