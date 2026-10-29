import { createHash, createHmac, timingSafeEqual } from "crypto";
import { z } from "zod";
import type {
  MessagingConnector,
  MessagingAccount,
  ConversationSummary,
  Message,
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
});

const UnipileChatSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  provider: z.string().optional(),
  last_message_timestamp: z.string().optional(),
  updated_at: z.string().optional(),
  unread_count: z.number().optional(),
  // A 1to1 chat carries the other person as `user`.
  user: UnipileUserSchema.optional(),
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

const UnipileMessagesResponseSchema = z.object({
  data: z.array(UnipileMessageSchema),
});

// POST /v2/auth/link → { object: 'HostedAuthLink', link }.
const UnipileAuthLinkResponseSchema = z.object({ link: z.string() });

const UnipileWebhookEndpointSchema = z.object({
  id: z.string(),
  url: z.string(),
  trigger_events: z.array(z.string()),
  secret: z.string(),
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

/** The events the messaging service handles (Create a Webhook Endpoint). */
export const UNIPILE_WEBHOOK_EVENTS = [
  "message.new",
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

  async getMessages(
    externalAccountId: string,
    threadId: string
  ): Promise<Message[]> {
    const res = await this.call(
      "GET",
      `/${encodeURIComponent(externalAccountId)}/chats/${encodeURIComponent(threadId)}/messages?limit=${PAGE_LIMIT}`
    );
    if (!res.ok) throw await failure(res, "getMessages");
    const parsed = UnipileMessagesResponseSchema.safeParse(await res.json());
    if (!parsed.success)
      throw new Error("Unipile getMessages: unexpected response shape");
    return parsed.data.data.map((m) => ({
      externalMessageId: m.id,
      threadId,
      senderName: m.sender?.display_name ?? m.sender_id ?? "Unknown",
      body: m.text ?? "",
      sentAt: m.timestamp ?? new Date().toISOString(),
      direction: m.is_sender ? "outbound" : "inbound",
      attachments: m.attachments
        ?.filter((a) => a.url)
        .map((a) => ({
          name: a.filename ?? a.display_name ?? a.type ?? "",
          url: a.url!,
        })),
    }));
  }

  async deleteAccount(externalId: string): Promise<void> {
    const res = await this.call(
      "DELETE",
      `/accounts/${encodeURIComponent(externalId)}`
    );
    if (!res.ok) throw await failure(res, "deleteAccount");
  }

  async sendMessage(
    externalAccountId: string,
    threadId: string,
    body: string
  ): Promise<void> {
    const res = await this.call(
      "POST",
      `/${encodeURIComponent(externalAccountId)}/chats/${encodeURIComponent(threadId)}/messages/send`,
      { text: body }
    );
    if (!res.ok) throw await failure(res, "sendMessage");
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
    const url = `${publicUrl.replace(/\/+$/, "")}/api/webhooks/messaging`;
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
        // Payload is a Message object (Get a Message).
        const msg = UnipileMessageSchema.safeParse(payload);
        if (!msg.success) return null;
        const m = msg.data;
        return {
          type: "message.created",
          accountExternalId,
          provider,
          threadId: m.chat_id,
          message: {
            externalMessageId: m.id,
            threadId: m.chat_id,
            senderName: m.sender?.display_name ?? m.sender_id ?? "",
            body: m.text ?? "",
            sentAt: m.timestamp ?? new Date().toISOString(),
            direction: m.is_sender ? "outbound" : "inbound",
          },
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
