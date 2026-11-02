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
  /**
   * The sender's id ON THE PROVIDER (Unipile v2 `sender.id` / `sender_id`;
   * on LinkedIn the member id `ACo…`). For an outbound message it is the
   * account owner's own id. Absent when the provider gives none.
   */
  senderProviderId?: string;
  /** The sender's public handle (LinkedIn profile slug), when given. */
  senderPublicIdentifier?: string;
  body: string;
  sentAt: string;
  direction: "inbound" | "outbound";
  attachments?: Array<{ name: string; url: string }>;
}

/** One page of a chat's messages, newest first (Unipile v2 order). */
export interface MessagePage {
  messages: Message[];
  /** Pass back to get the next (older) page; absent on the last page. */
  nextCursor?: string;
}

/** What a send returns: the provider's id of the message it created. */
export interface SentMessage {
  /** `null` when the provider answered without an id. */
  messageId: string | null;
}

/** A new 1to1 chat started by its first message. */
export interface StartedChat {
  chatId: string;
  messageId: string | null;
}

/**
 * LinkedIn network distance (Unipile v2 `specifics.network_distance`). Only
 * `FIRST_DEGREE` can receive a message outside InMail.
 */
export type NetworkDistance =
  "SELF" | "FIRST_DEGREE" | "SECOND_DEGREE" | "THIRD_DEGREE" | "OUT_OF_NETWORK";

/** A person's profile on the provider, looked up by provider id or handle. */
export interface MessagingProfile {
  /** The id to send to (`users_ids`); LinkedIn: the member id `ACo…`. */
  providerId: string;
  /** The public handle (LinkedIn profile slug), when the provider has one. */
  publicIdentifier: string | null;
  name: string;
  /** `null` when the provider does not say (any provider but LinkedIn). */
  networkDistance: NetworkDistance | null;
}

/** A chat and, when it is 1to1, the person on the other side. */
export interface ChatDetails {
  chatId: string;
  /** `null` for a group chat, or when the provider names no other side. */
  counterpart: {
    providerId: string;
    name: string;
    publicIdentifier: string | null;
  } | null;
}

/**
 * Whether the provider will deliver this pod's events. `unknown` = the
 * provider could not be read (a fault, with `error`), never "not registered".
 */
export interface WebhookHealth {
  state:
    "registered" | "missing" | "missing-events" | "no-public-url" | "unknown";
  /** The endpoint URL the pod expects; `null` without a public URL. */
  url: string | null;
  /** Events the pod handles that the endpoint does not deliver. */
  missingEvents: string[];
  error?: string;
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
      /**
       * A sent message was delivered to, or read by, the other side
       * (Unipile v2 `message.receipt.delivery` / `message.receipt.read`).
       */
      type: "message.status";
      accountExternalId: string;
      provider: string;
      threadId: string;
      externalMessageId: string;
      status: "delivered" | "read";
      /** When it happened (ISO), as the provider reports it. */
      at: string;
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
  /** The latest page of a chat's messages (the original, unpaged shape). */
  getMessages(externalAccountId: string, threadId: string): Promise<Message[]>;
  /**
   * One page of a chat's messages, newest first; `cursor` = the previous
   * page's `nextCursor`. A failed read throws (never an empty page).
   */
  getMessagesPage?(
    externalAccountId: string,
    threadId: string,
    cursor?: string
  ): Promise<MessagePage>;
  /**
   * Send into an existing chat. A connector that knows the created message's
   * id returns it; a non-2xx answer throws.
   */
  sendMessage(
    externalAccountId: string,
    threadId: string,
    body: string
  ): Promise<SentMessage | void>;
  /**
   * Start a 1to1 chat with one person by sending the first message (on
   * LinkedIn, a person you already talk to gets it in that chat). A non-2xx
   * answer throws.
   */
  startChat?(
    externalAccountId: string,
    attendeeProviderId: string,
    body: string
  ): Promise<StartedChat>;
  /**
   * Look a person up by provider id or public handle. `null` = the provider
   * has no such person (404); any other failure throws.
   */
  getProfile?(
    externalAccountId: string,
    identifier: string
  ): Promise<MessagingProfile | null>;
  /** One chat and its 1to1 counterpart. `null` = no such chat (404). */
  getChat?(
    externalAccountId: string,
    chatId: string
  ): Promise<ChatDetails | null>;
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
  /**
   * Read-only twin of `ensureWebhooksRegistered` for the health check: is the
   * pod's endpoint registered for every event it handles? Never throws.
   */
  describeWebhook?(
    publicUrl: string | null | undefined
  ): Promise<WebhookHealth>;
}
