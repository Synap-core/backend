import { createHash, createHmac, timingSafeEqual } from "crypto";
import { z } from "zod";
import type {
  MessagingConnector,
  MessagingAccount,
  ConversationSummary,
  Message,
  MessagePage,
  SentMessage,
  StartedChat,
  MessagingProfile,
  NetworkDistance,
  ChatDetails,
  WebhookHealth,
  WebhookEvent,
} from "./MessagingConnector.js";
import { UNIPILE_V2_BASE_URL } from "./unipile-connection.js";

// Unipile API v2 (developer.unipile.com/v2.0, OpenAPI 2.62.0). One global host,
// `X-API-KEY`, and the account id is a PATH segment of every method route
// (`/v2/{account_id}/...`). Schemas below keep only the fields this connector
// reads; Unipile adds fields freely, so unknown keys pass through.

// ── Zod schemas for Unipile v2 responses ───────────────────────────────────

const AccountStatusSchema = z.enum([
  "running",
  "errored",
  "disconnected",
  "degraded",
  "partial",
]);

const UnipileAccountSchema = z.object({
  id: z.string(),
  provider: z.string(), // 'linkedin', 'whatsapp', 'google', ... (lowercase)
  name: z.string().optional(),
  status: AccountStatusSchema,
});

// GET /v2/accounts/ → { object: 'Accounts', data, has_more } (offset/limit).
const UnipileAccountsResponseSchema = z.object({
  data: z.array(UnipileAccountSchema),
  has_more: z.boolean(),
});

const UnipileUserSchema = z.object({
  id: z.string(),
  display_name: z.string().optional(),
  public_identifier: z.string().optional(),
});

const UnipileChatSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  provider: z.string().optional(),
  last_message_timestamp: z.string().optional(),
  updated_at: z.string().optional(),
  unread_count: z.number().optional(),
  // A 1to1 chat carries the other person as `user` (and their id as `user_id`).
  user: UnipileUserSchema.optional(),
  user_id: z.string().optional(),
  type: z.string().optional(), // 'group' | '1to1' | 'channel'
  is_group: z.boolean().optional(),
  last_message: z.object({ text: z.string().optional() }).optional(),
});

const UnipileChatsResponseSchema = z.object({
  data: z.array(UnipileChatSchema),
  next_cursor: z.string().optional(),
});

const UnipileMessageSchema = z.object({
  id: z.string(),
  chat_id: z.string(),
  sender_id: z.string().optional(),
  sender: UnipileUserSchema.optional(),
  text: z.string().optional(), // undefined when the message is only attachments
  timestamp: z.string().optional(),
  is_sender: z.boolean().optional(),
  attachments: z
    .array(
      z.object({
        type: z.string().optional(),
        url: z.string().optional(),
        filename: z.string().optional(),
        display_name: z.string().optional(),
      })
    )
    .optional(),
});

// GET /v2/{account}/chats/{chat}/messages → { data, next_cursor? }, newest first.
const UnipileMessagesResponseSchema = z.object({
  data: z.array(UnipileMessageSchema),
  next_cursor: z.string().nullish(),
});

// `message_id` of a send: one id, several (attachments sent apart), or null.
const UnipileSentIdSchema = z.union([
  z.string(),
  z.array(z.string()),
  z.null(),
]);

// POST /v2/{account}/chats/{chat}/messages/send → { object: 'MessageSent', message_id }.
const UnipileMessageSentSchema = z.object({
  message_id: UnipileSentIdSchema.optional(),
});

// POST /v2/{account}[/inboxes/{inbox}]/chats/send → { object: 'ChatStarted', chat_id, message_id }.
const UnipileChatStartedSchema = z.object({
  chat_id: z.string(),
  message_id: UnipileSentIdSchema.optional(),
});

// GET /v2/{account}/users/{user} → UserProfile. LinkedIn's network distance
// sits in `specifics` (v2); older shapes put it at the top or under
// `specifics.linkedin`, so all three are read.
const UnipileUserProfileSchema = z.object({
  id: z.string(),
  public_identifier: z.string().nullish(),
  display_name: z.string().nullish(),
  first_name: z.string().nullish(),
  last_name: z.string().nullish(),
  network_distance: z.string().nullish(),
  specifics: z
    .object({
      network_distance: z.string().nullish(),
      linkedin: z
        .object({ network_distance: z.string().nullish() })
        .partial()
        .nullish(),
    })
    .partial()
    .nullish(),
});

// `message.receipt.read` / `message.receipt.delivery` payload.
const UnipileReceiptSchema = z.object({
  chat_id: z.string(),
  message_id: z.string(),
  timestamp: z.string().optional(),
});

// POST /v2/auth/link → { object: 'HostedAuthLink', link }.
const UnipileAuthLinkResponseSchema = z.object({ link: z.string() });

const UnipileWebhookEndpointSchema = z.object({
  id: z.string(),
  url: z.string(),
  trigger_events: z.array(z.string()),
  secret: z.string(),
  enabled: z.boolean().optional(),
});

// GET /v2/webhooks/endpoints/ → { object: 'WebhookEndpoints', data, has_more }.
const UnipileWebhookEndpointsResponseSchema = z.object({
  data: z.array(UnipileWebhookEndpointSchema),
  has_more: z.boolean(),
});

/**
 * The webhook event envelope: `{ id, type, account_id, account_provider,
 * payload }`, the payload shaped by `type`.
 */
const UnipileEventSchema = z.object({
  type: z.string(),
  account_id: z.string().optional(),
  account_provider: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

/**
 * The events the messaging service handles (Create a Webhook Endpoint).
 * Receipts (v2 "Event types"): `message.receipt.read` is sent by LinkedIn
 * Classic and Sales Navigator, WhatsApp, Instagram and Facebook;
 * `message.receipt.delivery` only by Facebook ("Methods & Events availability").
 */
export const UNIPILE_WEBHOOK_EVENTS = [
  "message.new",
  "message.receipt.read",
  "message.receipt.delivery",
  "account.add",
  "account.reconnect",
  "account.status.disconnected",
  "account.remove",
] as const;

/** LinkedIn chats live in inboxes; CLASSIC_PRIMARY is LinkedIn Classic's. */
const LINKEDIN_INBOX = "CLASSIC_PRIMARY";

/** Page size for chats and messages (the size the capability's verbs use). */
const PAGE_LIMIT = "25";

/** Never walk more pages than this when listing accounts or webhook endpoints. */
const MAX_PAGES = 20;

// ── Helpers ────────────────────────────────────────────────────────────────

/** Unipile v2 provider → Synap provider id (`google` is Synap's `gmail`). */
function toSynapProvider(provider: string): string {
  const p = provider.toLowerCase();
  return p === "google" ? "gmail" : p;
}

/**
 * Account status → messaging_accounts status. `partial` (a product needs
 * authentication) and `errored` need the person; `degraded` still serves.
 */
function toAccountStatus(
  status: z.infer<typeof AccountStatusSchema>
): MessagingAccount["status"] {
  return status === "running" || status === "degraded"
    ? "connected"
    : "reconnection_required";
}

/** Synap provider ids → Unipile v2 hosted-auth `providers` (lowercase only). */
function toUnipileProviders(providers?: string[]): string[] | "*:MESSAGING" {
  const map: Record<string, string> = {
    linkedin: "linkedin",
    whatsapp: "whatsapp",
    telegram: "telegram",
    instagram: "instagram",
    gmail: "google",
    outlook: "outlook",
  };
  const mapped = (providers ?? [])
    .map((p) => map[p.toLowerCase()])
    .filter((p): p is string => !!p);
  return mapped.length > 0 ? mapped : "*:MESSAGING";
}

/** The pod's one messaging webhook endpoint under its public URL. */
function webhookUrlFor(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/api/webhooks/messaging`;
}

/** A send's `message_id` (string | string[] | null) → the first id or null. */
function firstSentId(id: z.infer<typeof UnipileSentIdSchema> | undefined) {
  if (Array.isArray(id)) return id[0] ?? null;
  return id ?? null;
}

/** v2 values, plus v1's DISTANCE_n, → one NetworkDistance; else null. */
function toNetworkDistance(
  raw: string | null | undefined
): NetworkDistance | null {
  const d = (raw ?? "").toUpperCase();
  switch (d) {
    case "SELF":
    case "DISTANCE_0":
      return "SELF";
    case "FIRST_DEGREE":
    case "DISTANCE_1":
      return "FIRST_DEGREE";
    case "SECOND_DEGREE":
    case "DISTANCE_2":
      return "SECOND_DEGREE";
    case "THIRD_DEGREE":
    case "DISTANCE_3":
      return "THIRD_DEGREE";
    case "OUT_OF_NETWORK":
      return "OUT_OF_NETWORK";
    default:
      return null;
  }
}

/** A v2 Message → the connector's Message (one mapping for reads and webhooks). */
function toMessage(m: z.infer<typeof UnipileMessageSchema>): Message {
  // v2 has no "attendees": `sender.id` / `sender_id` is the user's id on the
  // provider (v1 `sender_attendee_id` was renamed `sender_id`).
  const senderProviderId = m.sender?.id ?? m.sender_id;
  return {
    externalMessageId: m.id,
    threadId: m.chat_id,
    senderName: m.sender?.display_name ?? m.sender_id ?? "",
    ...(senderProviderId ? { senderProviderId } : {}),
    ...(m.sender?.public_identifier
      ? { senderPublicIdentifier: m.sender.public_identifier }
      : {}),
    body: m.text ?? "",
    sentAt: m.timestamp ?? new Date().toISOString(),
    direction: m.is_sender ? "outbound" : "inbound",
  };
}

async function failure(res: Response, what: string): Promise<Error> {
  const body = await res.text().catch(() => "");
  return new Error(
    `Unipile ${what} failed: ${res.status}${body ? ` — ${body.slice(0, 200)}` : ""}`
  );
}

// Webhook signing secrets are read from Unipile (the endpoint API returns
// them), so no second copy is stored on the pod. Cached per API key; a
// signature no cached secret matches refetches at most every 30 s.
const SIGNING_SECRET_TTL_MS = 10 * 60_000;
const SIGNING_SECRET_REFRESH_MS = 30_000;
const signingSecretCache = new Map<
  string,
  { secrets: string[]; fetchedAt: number }
>();

/** Account provider never changes; cached so a chat list is one call. */
const accountProviderCache = new Map<string, string>();

/** Test seam: forget the cached signing secrets and account providers. */
export function resetUnipileCachesForTest(): void {
  signingSecretCache.clear();
  accountProviderCache.clear();
}

/**
 * Verify `unipile-signature: t=<unix>,v0=<hex>`: HMAC-SHA256 of
 * `${t}.${rawBody}` under an endpoint secret (developer.unipile.com/v2.0,
 * "Configure a webhook › Secure your endpoint").
 */
function signatureMatches(
  header: string,
  rawBody: string | Buffer,
  secrets: string[]
): boolean {
  const parts = new Map(
    header.split(",").map((kv) => {
      const i = kv.indexOf("=");
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()] as const;
    })
  );
  const t = parts.get("t");
  const v0 = parts.get("v0");
  if (!t || !v0 || !/^[0-9a-f]+$/i.test(v0)) return false;
  const given = Buffer.from(v0, "hex");
  const signed = Buffer.concat([
    Buffer.from(`${t}.`, "utf8"),
    typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody,
  ]);
  return secrets.some((secret) => {
    const expected = createHmac("sha256", secret).update(signed).digest();
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
}

// ── UnipileConnector ───────────────────────────────────────────────────────

export class UnipileConnector implements MessagingConnector {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(opts: { apiKey: string; baseUrl?: string }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? UNIPILE_V2_BASE_URL).replace(/\/+$/, "");
  }

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  /** Unipile sends from each user's own connected account. */
  requiresAccount(): boolean {
    return true;
  }

  private headers(): Record<string, string> {
    return {
      "X-API-KEY": this.apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  private call(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 15_000
  ): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  async getAuthUrl(
    userId: string,
    redirectUrl: string,
    providers?: string[]
  ): Promise<string> {
    // v2 has no notify_url: the new account reaches the pod as the
    // `account.add` webhook event, which echoes `state` — the user it belongs
    // to — and as `account_id` on the redirect.
    const res = await this.call("POST", "/auth/link", {
      providers: toUnipileProviders(providers),
      expires_on: new Date(Date.now() + 3600_000).toISOString(),
      redirect_uri: redirectUrl,
      state: userId,
    });
    if (!res.ok) throw await failure(res, "getAuthUrl");
    const parsed = UnipileAuthLinkResponseSchema.safeParse(await res.json());
    if (!parsed.success)
      throw new Error("Unipile getAuthUrl: unexpected response shape");
    return parsed.data.link;
  }

  async getAccounts(_userId: string): Promise<MessagingAccount[]> {
    const accounts: MessagingAccount[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.call(
        "GET",
        `/accounts/?offset=${accounts.length}`
      );
      if (!res.ok) throw await failure(res, "getAccounts");
      const parsed = UnipileAccountsResponseSchema.safeParse(await res.json());
      if (!parsed.success)
        throw new Error("Unipile getAccounts: unexpected response shape");
      for (const a of parsed.data.data) {
        accountProviderCache.set(a.id, a.provider.toLowerCase());
        accounts.push({
          id: a.id,
          externalId: a.id,
          provider: toSynapProvider(a.provider),
          displayName: a.name ?? a.id,
          status: toAccountStatus(a.status),
        });
      }
      if (!parsed.data.has_more || parsed.data.data.length === 0) break;
    }
    return accounts;
  }

  /** The account's Unipile provider (`linkedin`, ...) — picks the chats route. */
  private async providerOf(accountId: string): Promise<string> {
    const cached = accountProviderCache.get(accountId);
    if (cached) return cached;
    const res = await this.call(
      "GET",
      `/accounts/${encodeURIComponent(accountId)}`
    );
    if (!res.ok) throw await failure(res, "getAccount");
    const parsed = UnipileAccountSchema.safeParse(await res.json());
    if (!parsed.success)
      throw new Error("Unipile getAccount: unexpected response shape");
    const provider = parsed.data.provider.toLowerCase();
    accountProviderCache.set(accountId, provider);
    return provider;
  }

  async getConversations(
    externalAccountId: string,
    cursor?: string
  ): Promise<{ items: ConversationSummary[]; nextCursor?: string }> {
    const provider = await this.providerOf(externalAccountId);
    const account = encodeURIComponent(externalAccountId);
    // LinkedIn organises chats into inboxes; the account-wide list is for the
    // providers that do not (Unipile v2 "List chats & messages" guide).
    const path =
      provider === "linkedin"
        ? `/${account}/inboxes/${LINKEDIN_INBOX}/chats`
        : `/${account}/chats`;
    const params = new URLSearchParams({ limit: PAGE_LIMIT });
    if (cursor) params.set("cursor", cursor);
    const res = await this.call("GET", `${path}?${params}`);
    if (!res.ok) throw await failure(res, "getConversations");
    const parsed = UnipileChatsResponseSchema.safeParse(await res.json());
    if (!parsed.success)
      throw new Error("Unipile getConversations: unexpected response shape");
    return {
      items: parsed.data.data.map((c) => ({
        externalThreadId: c.id,
        provider: toSynapProvider(c.provider ?? provider),
        participantName: c.user?.display_name ?? c.name ?? "Unknown",
        participantExternalId: c.user?.id ?? "",
        lastMessageAt:
          c.last_message_timestamp ?? c.updated_at ?? new Date().toISOString(),
        lastMessagePreview: c.last_message?.text ?? "",
        unread: (c.unread_count ?? 0) > 0,
      })),
      nextCursor: parsed.data.next_cursor,
    };
  }

  /** The latest page of a chat's messages (the unpaged shape callers had). */
  async getMessages(
    externalAccountId: string,
    threadId: string
  ): Promise<Message[]> {
    return (await this.getMessagesPage(externalAccountId, threadId)).messages;
  }

  /**
   * One page of a chat's messages, newest first (v2 List all Chat Messages:
   * `cursor` in, `next_cursor` out). No `next_cursor` = the last page.
   */
  async getMessagesPage(
    externalAccountId: string,
    threadId: string,
    cursor?: string
  ): Promise<MessagePage> {
    const params = new URLSearchParams({ limit: PAGE_LIMIT });
    if (cursor) params.set("cursor", cursor);
    const res = await this.call(
      "GET",
      `/${encodeURIComponent(externalAccountId)}/chats/${encodeURIComponent(threadId)}/messages?${params}`
    );
    if (!res.ok) throw await failure(res, "getMessages");
    const parsed = UnipileMessagesResponseSchema.safeParse(await res.json());
    if (!parsed.success)
      throw new Error("Unipile getMessages: unexpected response shape");
    const messages = parsed.data.data.map((m) => ({
      ...toMessage(m),
      threadId,
      senderName: m.sender?.display_name ?? m.sender_id ?? "Unknown",
      attachments: m.attachments
        ?.filter((a) => a.url)
        .map((a) => ({
          name: a.filename ?? a.display_name ?? a.type ?? "",
          url: a.url!,
        })),
    }));
    const nextCursor = parsed.data.next_cursor ?? undefined;
    return nextCursor ? { messages, nextCursor } : { messages };
  }

  async deleteAccount(externalId: string): Promise<void> {
    const res = await this.call(
      "DELETE",
      `/accounts/${encodeURIComponent(externalId)}`
    );
    if (!res.ok) throw await failure(res, "deleteAccount");
  }

  /**
   * Send into an existing chat: POST /{account}/chats/{chat}/messages/send
   * → { object: 'MessageSent', message_id }. The message was sent once the
   * answer is 2xx, so an unreadable body is `messageId: null`, never a throw
   * (a throw would read as "not sent" and invite a second send).
   */
  async sendMessage(
    externalAccountId: string,
    threadId: string,
    body: string
  ): Promise<SentMessage> {
    const res = await this.call(
      "POST",
      `/${encodeURIComponent(externalAccountId)}/chats/${encodeURIComponent(threadId)}/messages/send`,
      { text: body }
    );
    if (!res.ok) throw await failure(res, "sendMessage");
    const parsed = UnipileMessageSentSchema.safeParse(
      await res.json().catch(() => null)
    );
    return {
      messageId: parsed.success ? firstSentId(parsed.data.message_id) : null,
    };
  }

  /**
   * Start a 1to1 chat by sending the first message. LinkedIn starts chats
   * from its CLASSIC_PRIMARY inbox (POST /{account}/inboxes/CLASSIC_PRIMARY/
   * chats/send); the other providers from POST /{account}/chats/send. Both
   * answer { object: 'ChatStarted', chat_id, message_id }. `users_ids` is ONE
   * id as a string: an array, even of one id, asks for a group chat.
   */
  async startChat(
    externalAccountId: string,
    attendeeProviderId: string,
    body: string
  ): Promise<StartedChat> {
    const provider = await this.providerOf(externalAccountId);
    const account = encodeURIComponent(externalAccountId);
    const path =
      provider === "linkedin"
        ? `/${account}/inboxes/${LINKEDIN_INBOX}/chats/send`
        : `/${account}/chats/send`;
    const res = await this.call("POST", path, {
      text: body,
      users_ids: attendeeProviderId,
    });
    if (!res.ok) throw await failure(res, "startChat");
    // A 2xx means the message went out: without the chat id the caller cannot
    // bind the chat, so this throws, and says the message WAS sent.
    const parsed = UnipileChatStartedSchema.safeParse(
      await res.json().catch(() => null)
    );
    if (!parsed.success)
      throw new Error(
        "Unipile startChat: the message was sent but the answer has no chat_id"
      );
    return {
      chatId: parsed.data.chat_id,
      messageId: firstSentId(parsed.data.message_id),
    };
  }

  /**
   * Look a person up by provider id (LinkedIn `ACo…`) or public handle
   * (LinkedIn profile slug): GET /{account}/users/{id}, LinkedIn with
   * `variant=linkedin_classic` (no sections: the cheap read). The visit is not
   * notified. 404 = no such person (null); any other failure throws.
   */
  async getProfile(
    externalAccountId: string,
    identifier: string
  ): Promise<MessagingProfile | null> {
    const provider = await this.providerOf(externalAccountId);
    const query = provider === "linkedin" ? "?variant=linkedin_classic" : "";
    const res = await this.call(
      "GET",
      `/${encodeURIComponent(externalAccountId)}/users/${encodeURIComponent(identifier)}${query}`
    );
    if (res.status === 404) return null;
    if (!res.ok) throw await failure(res, "getProfile");
    const parsed = UnipileUserProfileSchema.safeParse(await res.json());
    if (!parsed.success)
      throw new Error("Unipile getProfile: unexpected response shape");
    const p = parsed.data;
    const name =
      p.display_name ||
      [p.first_name, p.last_name].filter(Boolean).join(" ") ||
      identifier;
    return {
      providerId: p.id,
      publicIdentifier: p.public_identifier ?? null,
      name,
      networkDistance: toNetworkDistance(
        p.specifics?.network_distance ??
          p.specifics?.linkedin?.network_distance ??
          p.network_distance
      ),
    };
  }

  /**
   * One chat: GET /{account}/chats/{chat}. A 1to1 chat names the other side
   * as `user` (`user_id`); a group has no single counterpart. 404 = null.
   */
  async getChat(
    externalAccountId: string,
    chatId: string
  ): Promise<ChatDetails | null> {
    const res = await this.call(
      "GET",
      `/${encodeURIComponent(externalAccountId)}/chats/${encodeURIComponent(chatId)}`
    );
    if (res.status === 404) return null;
    if (!res.ok) throw await failure(res, "getChat");
    const parsed = UnipileChatSchema.safeParse(await res.json());
    if (!parsed.success)
      throw new Error("Unipile getChat: unexpected response shape");
    const c = parsed.data;
    const isGroup = c.is_group === true || c.type === "group";
    const providerId = c.user?.id ?? c.user_id;
    return {
      chatId: c.id,
      counterpart:
        isGroup || !providerId
          ? null
          : {
              providerId,
              name: c.user?.display_name ?? c.name ?? providerId,
              publicIdentifier: c.user?.public_identifier ?? null,
            },
    };
  }

  async probe(): Promise<{
    reachable: boolean;
    authenticated: boolean;
    error: string | null;
  }> {
    try {
      const res = await this.call("GET", "/accounts/?limit=1", undefined, 5000);
      if (res.status === 401 || res.status === 403) {
        return {
          reachable: true,
          authenticated: false,
          error: `Invalid Unipile v2 API key (${res.status})`,
        };
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return {
          reachable: true,
          authenticated: false,
          error: `Unipile returned ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
        };
      }
      return { reachable: true, authenticated: true, error: null };
    } catch (err) {
      return {
        reachable: false,
        authenticated: false,
        error: `Cannot reach Unipile: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private async listWebhookEndpoints(): Promise<
    Array<z.infer<typeof UnipileWebhookEndpointSchema>>
  > {
    const endpoints: Array<z.infer<typeof UnipileWebhookEndpointSchema>> = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.call(
        "GET",
        `/webhooks/endpoints/?offset=${endpoints.length}`,
        undefined,
        5_000
      );
      if (!res.ok) throw await failure(res, "listWebhookEndpoints");
      const parsed = UnipileWebhookEndpointsResponseSchema.safeParse(
        await res.json()
      );
      if (!parsed.success)
        throw new Error(
          "Unipile listWebhookEndpoints: unexpected response shape"
        );
      endpoints.push(...parsed.data.data);
      if (!parsed.data.has_more || parsed.data.data.length === 0) break;
    }
    return endpoints;
  }

  async ensureWebhooksRegistered(publicUrl: string): Promise<void> {
    const url = webhookUrlFor(publicUrl);
    const existing = (await this.listWebhookEndpoints()).find(
      (e) => e.url === url
    );
    if (!existing) {
      const res = await this.call(
        "POST",
        "/webhooks/endpoints/",
        { url, trigger_events: [...UNIPILE_WEBHOOK_EVENTS] },
        5_000
      );
      if (!res.ok) throw await failure(res, "webhook registration");
      return;
    }
    const missing = UNIPILE_WEBHOOK_EVENTS.filter(
      (e) => !existing.trigger_events.includes(e)
    );
    if (missing.length === 0) return;
    const res = await this.call(
      "PATCH",
      `/webhooks/endpoints/${encodeURIComponent(existing.id)}`,
      { trigger_events: [...existing.trigger_events, ...missing] },
      5_000
    );
    if (!res.ok) throw await failure(res, "webhook update");
  }

  /**
   * The health check's read of `ensureWebhooksRegistered`: is this pod's
   * endpoint registered, enabled and subscribed to every handled event? A
   * failed read is `unknown` with the error, never "missing".
   */
  async describeWebhook(
    publicUrl: string | null | undefined
  ): Promise<WebhookHealth> {
    if (!publicUrl || !publicUrl.trim()) {
      return {
        state: "no-public-url",
        url: null,
        missingEvents: [...UNIPILE_WEBHOOK_EVENTS],
      };
    }
    const url = webhookUrlFor(publicUrl.trim());
    let endpoints: Array<z.infer<typeof UnipileWebhookEndpointSchema>>;
    try {
      endpoints = await this.listWebhookEndpoints();
    } catch (err) {
      return {
        state: "unknown",
        url,
        missingEvents: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
    const existing = endpoints.find((e) => e.url === url);
    if (!existing || existing.enabled === false) {
      return {
        state: "missing",
        url,
        missingEvents: [...UNIPILE_WEBHOOK_EVENTS],
        ...(existing ? { error: "The endpoint is disabled on Unipile." } : {}),
      };
    }
    const missingEvents = UNIPILE_WEBHOOK_EVENTS.filter(
      (e) => !existing.trigger_events.includes(e)
    );
    return {
      state: missingEvents.length > 0 ? "missing-events" : "registered",
      url,
      missingEvents,
    };
  }

  /** The application's webhook endpoint secrets, cached per API key. */
  private async signingSecrets(refresh: boolean): Promise<string[]> {
    const key = createHash("sha256").update(this.apiKey).digest("hex");
    const cached = signingSecretCache.get(key);
    const age = cached ? Date.now() - cached.fetchedAt : Infinity;
    if (
      cached &&
      age < SIGNING_SECRET_TTL_MS &&
      !(refresh && age > SIGNING_SECRET_REFRESH_MS)
    ) {
      return cached.secrets;
    }
    // An endpoint with no secret signs nothing: an HMAC under the empty key is
    // one anyone can compute, so it never verifies a delivery (pre-launch audit
    // 2026-10-28, webhooks F2: no secret = every call refused).
    const secrets = (await this.listWebhookEndpoints())
      .map((e) => e.secret)
      .filter((s) => s.trim().length > 0);
    signingSecretCache.set(key, { secrets, fetchedAt: Date.now() });
    return secrets;
  }

  async parseWebhook(
    headers: Record<string, string>,
    rawBody: string | Buffer
  ): Promise<WebhookEvent | null> {
    // Every v2 delivery is signed with its endpoint's secret; an unsigned or
    // mis-signed request is not from Unipile.
    const signature =
      headers["unipile-signature"] ?? headers["Unipile-Signature"];
    if (!signature) return null;
    if (
      !signatureMatches(signature, rawBody, await this.signingSecrets(false))
    ) {
      // A secret may have rotated (or an endpoint been added) since the cache.
      if (
        !signatureMatches(signature, rawBody, await this.signingSecrets(true))
      )
        return null;
    }

    let json: unknown;
    try {
      json = JSON.parse(
        typeof rawBody === "string" ? rawBody : rawBody.toString("utf8")
      );
    } catch {
      return null;
    }
    const parsed = UnipileEventSchema.safeParse(json);
    if (!parsed.success) return null;
    const event = parsed.data;
    const payload = event.payload ?? {};
    const provider = toSynapProvider(
      event.account_provider ?? String(payload.provider ?? "unknown")
    );
    const account = (payload.account ?? {}) as { id?: unknown };
    const accountExternalId =
      typeof account.id === "string" ? account.id : (event.account_id ?? "");

    switch (event.type) {
      case "message.new": {
        // Payload is a Message object (Get a Message). It fires for received
        // AND sent messages (`is_sender`), including ones sent from the
        // person's own devices: the direction says which.
        const msg = UnipileMessageSchema.safeParse(payload);
        if (!msg.success) return null;
        const m = msg.data;
        return {
          type: "message.created",
          accountExternalId,
          provider,
          threadId: m.chat_id,
          message: toMessage(m),
        };
      }
      case "message.receipt.read":
      case "message.receipt.delivery": {
        const r = UnipileReceiptSchema.safeParse(payload);
        if (!r.success) return null;
        return {
          type: "message.status",
          accountExternalId,
          provider,
          threadId: r.data.chat_id,
          externalMessageId: r.data.message_id,
          status: event.type === "message.receipt.read" ? "read" : "delivered",
          at: r.data.timestamp ?? new Date().toISOString(),
        };
      }
      case "account.add":
      case "account.reconnect": {
        // `state` is the user who started the hosted auth (getAuthUrl). An
        // account linked elsewhere carries none: the next sync claims it.
        const userId = typeof payload.state === "string" ? payload.state : "";
        if (!userId || !accountExternalId) return null;
        return {
          type: "account.created",
          accountExternalId,
          provider,
          userId,
        };
      }
      case "account.status.disconnected":
        return {
          type: "account.reconnection_required",
          accountExternalId,
          provider,
        };
      case "account.remove":
        return { type: "account.disconnected", accountExternalId, provider };
      default:
        return null;
    }
  }
}
