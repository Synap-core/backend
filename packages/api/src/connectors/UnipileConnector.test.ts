/**
 * The messaging service speaks Unipile API v2 (developer.unipile.com/v2.0,
 * OpenAPI 2.62.0) — and only v2.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * 2026-10-28: the connector called `${dsn}/api/v1/...` with a per-account DSN.
 * The founder's Unipile account is v2-only (v1 closed, v1 keys do not
 * authenticate on v2), so CRM › Connected accounts could not list the LinkedIn
 * account the installed v2 capability lists fine.
 *
 * No network: `fetch` is stubbed; every request it received is asserted (URL,
 * method, body) against the v2 reference, and the responses are v2 shapes.
 * NOT covered: that Unipile still answers these shapes live — that is the
 * dogfood check (GET /api/hub/messaging/accounts on a pod with the capability).
 */
import { createHmac } from "crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  UnipileConnector,
  UNIPILE_WEBHOOK_EVENTS,
  resetUnipileCachesForTest,
} from "./UnipileConnector.js";

const BASE = "https://api.unipile.com/v2";
const KEY = "v2-key";

type Call = { url: string; method: string; body: unknown; key: string | null };
let calls: Call[];
let routes: Array<[RegExp, (call: Call) => Response]>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function route(method: string, path: RegExp, reply: (call: Call) => Response) {
  routes.push([new RegExp(`^${method} ${path.source}`), reply]);
}

beforeEach(() => {
  calls = [];
  routes = [];
  resetUnipileCachesForTest();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      const call: Call = {
        url,
        method: init.method ?? "GET",
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        key: headers["X-API-KEY"] ?? null,
      };
      calls.push(call);
      const hit = routes.find(([re]) => re.test(`${call.method} ${url}`));
      return hit ? hit[1](call) : json({ error: "no route" }, 404);
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  // Every request went to the v2 host with the key; none to a v1 path.
  for (const c of calls) {
    expect(c.url.startsWith(`${BASE}/`), c.url).toBe(true);
    expect(c.url).not.toMatch(/\/api\/v1\//);
    expect(c.key).toBe(KEY);
  }
});

const connector = () => new UnipileConnector({ apiKey: KEY });
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const at = (path: string) => new RegExp(`${esc(BASE + path)}$`);

const account = (id: string, provider: string, status = "running") => ({
  object: "Account",
  id,
  name: `${provider} account`,
  provider,
  status,
  is_locked: false,
  user_id: "u",
  created_at: "2026-10-01T00:00:00.000Z",
  application_id: "app_1",
  metadata: {},
});

describe("accounts — GET /v2/accounts/ (offset pages, { data, has_more })", () => {
  it("maps v2 accounts: provider lowercase (google → gmail), status running/degraded → connected, others → reconnection_required", async () => {
    route("GET", at("/accounts/?offset=0"), () =>
      json({
        object: "Accounts",
        data: [
          account("acc_li", "linkedin"),
          account("acc_g", "google", "degraded"),
        ],
        has_more: true,
      })
    );
    route("GET", at("/accounts/?offset=2"), () =>
      json({
        object: "Accounts",
        data: [
          account("acc_wa", "whatsapp", "disconnected"),
          account("acc_tg", "telegram", "partial"),
        ],
        has_more: false,
      })
    );
    const accounts = await connector().getAccounts("user-1");
    expect(accounts).toEqual([
      {
        id: "acc_li",
        externalId: "acc_li",
        provider: "linkedin",
        displayName: "linkedin account",
        status: "connected",
      },
      {
        id: "acc_g",
        externalId: "acc_g",
        provider: "gmail",
        displayName: "google account",
        status: "connected",
      },
      {
        id: "acc_wa",
        externalId: "acc_wa",
        provider: "whatsapp",
        displayName: "whatsapp account",
        status: "reconnection_required",
      },
      {
        id: "acc_tg",
        externalId: "acc_tg",
        provider: "telegram",
        displayName: "telegram account",
        status: "reconnection_required",
      },
    ]);
  });

  it("a failed read throws — never an empty list a caller would read as 'no accounts'", async () => {
    route("GET", at("/accounts/?offset=0"), () =>
      json({ type: "errors/invalid_api_key" }, 401)
    );
    await expect(connector().getAccounts("user-1")).rejects.toThrow(/401/);
  });

  it("a v1-shaped body ({ items }) is not read as an empty v2 list", async () => {
    route("GET", at("/accounts/?offset=0"), () =>
      json({ items: [{ id: "x", type: "LINKEDIN" }] })
    );
    await expect(connector().getAccounts("user-1")).rejects.toThrow(
      /unexpected response shape/
    );
  });
});

describe("chats and messages — account id in the PATH", () => {
  const chats = {
    data: [
      {
        object: "Chat",
        id: "chat-1",
        name: "Ada Lovelace",
        provider: "linkedin",
        last_message_timestamp: "2026-10-27T10:00:00.000Z",
        unread_count: 2,
        user: { object: "User", id: "li-ada", display_name: "Ada Lovelace" },
        last_message: { object: "MessagePreview", text: "Hello!" },
      },
    ],
    next_cursor: "c2",
  };

  it("a LinkedIn account lists the CLASSIC_PRIMARY inbox (LinkedIn is inbox-based)", async () => {
    route("GET", at("/accounts/acc_li"), () =>
      json(account("acc_li", "linkedin"))
    );
    route(
      "GET",
      at("/acc_li/inboxes/CLASSIC_PRIMARY/chats?limit=25&cursor=c1"),
      () => json(chats)
    );
    const out = await connector().getConversations("acc_li", "c1");
    expect(out).toEqual({
      items: [
        {
          externalThreadId: "chat-1",
          provider: "linkedin",
          participantName: "Ada Lovelace",
          participantExternalId: "li-ada",
          lastMessageAt: "2026-10-27T10:00:00.000Z",
          lastMessagePreview: "Hello!",
          unread: true,
        },
      ],
      nextCursor: "c2",
    });
  });

  it("another provider lists the account's chats", async () => {
    route("GET", at("/accounts/acc_wa"), () =>
      json(account("acc_wa", "whatsapp"))
    );
    route("GET", at("/acc_wa/chats?limit=25"), () =>
      json({
        data: [{ ...chats.data[0], provider: "whatsapp", unread_count: 0 }],
      })
    );
    const out = await connector().getConversations("acc_wa");
    expect(out.items.map((i) => [i.provider, i.unread])).toEqual([
      ["whatsapp", false],
    ]);
  });

  it("lists a chat's messages", async () => {
    route("GET", at("/acc_li/chats/chat-1/messages?limit=25"), () =>
      json({
        data: [
          {
            object: "Message",
            id: "m1",
            chat_id: "chat-1",
            sender_id: "li-ada",
            sender: { object: "User", id: "li-ada", display_name: "Ada" },
            text: "Hi",
            timestamp: "2026-10-27T10:00:00.000Z",
            is_sender: false,
            attachments: [
              {
                object: "Attachment",
                type: "file",
                url: "https://f/1",
                filename: "deck.pdf",
              },
            ],
          },
          {
            object: "Message",
            id: "m2",
            chat_id: "chat-1",
            sender_id: "me",
            timestamp: "2026-10-27T10:01:00.000Z",
            is_sender: true,
            attachments: [],
          },
        ],
      })
    );
    const messages = await connector().getMessages("acc_li", "chat-1");
    expect(messages).toEqual([
      {
        externalMessageId: "m1",
        threadId: "chat-1",
        senderName: "Ada",
        senderProviderId: "li-ada",
        body: "Hi",
        sentAt: "2026-10-27T10:00:00.000Z",
        direction: "inbound",
        attachments: [{ name: "deck.pdf", url: "https://f/1" }],
      },
      {
        externalMessageId: "m2",
        threadId: "chat-1",
        senderName: "me",
        senderProviderId: "me",
        body: "",
        sentAt: "2026-10-27T10:01:00.000Z",
        direction: "outbound",
        attachments: [],
      },
    ]);
  });

  it("sends into a chat with POST /{account}/chats/{chat}/messages/send { text }", async () => {
    route("POST", at("/acc_li/chats/chat-1/messages/send"), () =>
      json({ object: "MessageSent", message_id: "m3" })
    );
    const sent = await connector().sendMessage("acc_li", "chat-1", "On my way");
    expect(sent).toEqual({ messageId: "m3" });
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      [
        "POST",
        `${BASE}/acc_li/chats/chat-1/messages/send`,
        { text: "On my way" },
      ],
    ]);
  });

  it("a refused send throws", async () => {
    route("POST", at("/acc_li/chats/chat-1/messages/send"), () =>
      json({ type: "errors/forbidden" }, 403)
    );
    await expect(
      connector().sendMessage("acc_li", "chat-1", "x")
    ).rejects.toThrow(/403/);
  });
});

describe("hosted auth — POST /v2/auth/link", () => {
  it("asks for lowercase providers, redirects back, and carries the user as `state`", async () => {
    route("POST", at("/auth/link"), () =>
      json({ object: "HostedAuthLink", link: "https://account.unipile.com/x" })
    );
    const link = await connector().getAuthUrl(
      "user-1",
      "https://crm.example/settings",
      ["linkedin", "gmail"]
    );
    expect(link).toBe("https://account.unipile.com/x");
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({
      providers: ["linkedin", "google"],
      redirect_uri: "https://crm.example/settings",
      state: "user-1",
    });
    expect(Date.parse(String(body.expires_on))).toBeGreaterThan(Date.now());
    // v1-only fields are gone.
    for (const k of ["api_url", "notify_url", "type", "name"])
      expect(body).not.toHaveProperty(k);
  });

  it("no provider asked → every messaging provider", async () => {
    route("POST", at("/auth/link"), () => json({ link: "https://l" }));
    await connector().getAuthUrl("user-1", "https://r");
    expect((calls[0]!.body as Record<string, unknown>).providers).toBe(
      "*:MESSAGING"
    );
  });
});

describe("webhooks — /v2/webhooks/endpoints/, signed deliveries", () => {
  const URL = "https://pod.example/api/webhooks/messaging";
  const SECRET = "whsec_1";
  const endpoint = (events: string[], secret = SECRET) => ({
    object: "WebhookEndpoint",
    id: "we_1",
    url: URL,
    trigger_events: events,
    secret,
    enabled: true,
  });
  const sign = (body: string, secret = SECRET, t = "1761650000") =>
    `t=${t},v0=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

  it("registers the pod's endpoint for the events it handles when none exists", async () => {
    route("GET", at("/webhooks/endpoints/?offset=0"), () =>
      json({ object: "WebhookEndpoints", data: [], has_more: false })
    );
    route("POST", at("/webhooks/endpoints/"), () =>
      json(endpoint([...UNIPILE_WEBHOOK_EVENTS]))
    );
    await connector().ensureWebhooksRegistered("https://pod.example/");
    expect(calls[1]!.body).toEqual({
      url: URL,
      trigger_events: [...UNIPILE_WEBHOOK_EVENTS],
    });
  });

  it("adds the missing events to an existing endpoint instead of a duplicate", async () => {
    route("GET", at("/webhooks/endpoints/?offset=0"), () =>
      json({ data: [endpoint(["message.new"])], has_more: false })
    );
    route("PATCH", at("/webhooks/endpoints/we_1"), () =>
      json(endpoint([...UNIPILE_WEBHOOK_EVENTS]))
    );
    await connector().ensureWebhooksRegistered("https://pod.example");
    expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
    expect(
      [
        ...(calls[1]!.body as { trigger_events: string[] }).trigger_events,
      ].sort()
    ).toEqual([...UNIPILE_WEBHOOK_EVENTS].sort());
  });

  const messageEvent = JSON.stringify({
    id: "evt_1",
    type: "message.new",
    account_id: "acc_li",
    account_provider: "linkedin",
    payload: {
      object: "Message",
      id: "m9",
      chat_id: "chat-1",
      sender_id: "li-ada",
      sender: { object: "User", id: "li-ada", display_name: "Ada" },
      text: "Ping",
      timestamp: "2026-10-28T09:00:00.000Z",
      is_sender: false,
    },
  });

  it("a signed message.new becomes message.created", async () => {
    route("GET", at("/webhooks/endpoints/?offset=0"), () =>
      json({ data: [endpoint(["message.new"])], has_more: false })
    );
    const event = await connector().parseWebhook(
      { "unipile-signature": sign(messageEvent) },
      messageEvent
    );
    expect(event).toEqual({
      type: "message.created",
      accountExternalId: "acc_li",
      provider: "linkedin",
      threadId: "chat-1",
      message: {
        externalMessageId: "m9",
        threadId: "chat-1",
        senderName: "Ada",
        senderProviderId: "li-ada",
        body: "Ping",
        sentAt: "2026-10-28T09:00:00.000Z",
        direction: "inbound",
      },
    });
  });

  it("an unsigned or mis-signed delivery is dropped", async () => {
    route("GET", at("/webhooks/endpoints/?offset=0"), () =>
      json({ data: [endpoint(["message.new"])], has_more: false })
    );
    const c = connector();
    expect(await c.parseWebhook({}, messageEvent)).toBeNull();
    expect(
      await c.parseWebhook(
        { "unipile-signature": sign(messageEvent, "whsec_other") },
        messageEvent
      )
    ).toBeNull();
    // A body changed after signing.
    expect(
      await c.parseWebhook(
        { "unipile-signature": sign(messageEvent) },
        messageEvent.replace("Ping", "Pong")
      )
    ).toBeNull();
    // The v1 custom header is not a credential any more.
    expect(
      await c.parseWebhook({ "unipile-auth": SECRET }, messageEvent)
    ).toBeNull();
  });

  it("no signing secret = every delivery refused: none registered, or one with an empty secret", async () => {
    let endpoints: unknown[] = [];
    route("GET", at("/webhooks/endpoints/?offset=0"), () =>
      json({ data: endpoints, has_more: false })
    );
    const c = connector();
    // Nothing registered: no secret can verify anything.
    expect(
      await c.parseWebhook(
        { "unipile-signature": sign(messageEvent, "") },
        messageEvent
      )
    ).toBeNull();
    // An endpoint whose secret is empty: an HMAC under the empty key is one
    // anyone computes, so it is not a signature (pre-launch audit, webhooks F2).
    resetUnipileCachesForTest();
    endpoints = [endpoint(["message.new"], "")];
    const forged = await c.parseWebhook(
      { "unipile-signature": sign(messageEvent, "") },
      messageEvent
    );
    expect(forged).toBeNull();
  });

  it("a rotated endpoint secret is picked up without a restart", async () => {
    let secret = SECRET;
    route("GET", at("/webhooks/endpoints/?offset=0"), () =>
      json({ data: [endpoint(["message.new"], secret)], has_more: false })
    );
    const c = connector();
    expect(
      await c.parseWebhook(
        { "unipile-signature": sign(messageEvent) },
        messageEvent
      )
    ).not.toBeNull();
    secret = "whsec_rotated";
    vi.useFakeTimers({ now: Date.now() + 60_000, toFake: ["Date"] });
    try {
      expect(
        await c.parseWebhook(
          { "unipile-signature": sign(messageEvent, "whsec_rotated") },
          messageEvent
        )
      ).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("account events map to the account lifecycle; account.add names the user from `state`", async () => {
    route("GET", at("/webhooks/endpoints/?offset=0"), () =>
      json({ data: [endpoint([...UNIPILE_WEBHOOK_EVENTS])], has_more: false })
    );
    const c = connector();
    const deliver = (e: Record<string, unknown>) => {
      const body = JSON.stringify(e);
      return c.parseWebhook({ "unipile-signature": sign(body) }, body);
    };
    expect(
      await deliver({
        type: "account.add",
        account_id: "acc_new",
        account_provider: "linkedin",
        payload: { account: account("acc_new", "linkedin"), state: "user-1" },
      })
    ).toEqual({
      type: "account.created",
      accountExternalId: "acc_new",
      provider: "linkedin",
      userId: "user-1",
    });
    // Linked from elsewhere (no state): nobody to give it to — the next sync claims it.
    expect(
      await deliver({
        type: "account.add",
        account_id: "acc_new",
        account_provider: "linkedin",
        payload: { account: account("acc_new", "linkedin") },
      })
    ).toBeNull();
    expect(
      await deliver({
        type: "account.status.disconnected",
        account_id: "acc_li",
        account_provider: "linkedin",
        payload: { timestamp: "2026-10-28T09:00:00.000Z" },
      })
    ).toEqual({
      type: "account.reconnection_required",
      accountExternalId: "acc_li",
      provider: "linkedin",
    });
    expect(
      await deliver({
        type: "account.remove",
        account_id: "acc_li",
        account_provider: "linkedin",
        payload: { account: { id: "acc_li" } },
      })
    ).toEqual({
      type: "account.disconnected",
      accountExternalId: "acc_li",
      provider: "linkedin",
    });
    // v1 event names mean nothing in v2.
    expect(
      await deliver({ event: "message_created", account_id: "acc_li" })
    ).toBeNull();
  });
});

// ── Channels lane B (2026-11-02): what the channel needs from the adapter ──
// Inbound: the sender's provider id, the message id and the direction survive
// the webhook. Outbound: a send returns the message id, a first message
// returns the chat id. Identity: a profile lookup gives the member id, the
// public handle and the network distance. History: pages with a cursor.
// Health: whether the pod's endpoint is registered for every handled event.

describe("message ids and chat ids from sends", () => {
  it("a send whose answer carries several ids (attachments apart) returns the first; none → null", async () => {
    let reply: unknown = { object: "MessageSent", message_id: ["m4", "m5"] };
    route("POST", at("/acc_li/chats/chat-1/messages/send"), () => json(reply));
    expect(await connector().sendMessage("acc_li", "chat-1", "x")).toEqual({
      messageId: "m4",
    });
    reply = { object: "MessageSent", message_id: null };
    expect(await connector().sendMessage("acc_li", "chat-1", "x")).toEqual({
      messageId: null,
    });
  });

  it("a 2xx send with an unreadable body is sent (messageId null), never a throw that invites a resend", async () => {
    route(
      "POST",
      at("/acc_li/chats/chat-1/messages/send"),
      () => new Response("", { status: 201 })
    );
    expect(await connector().sendMessage("acc_li", "chat-1", "x")).toEqual({
      messageId: null,
    });
  });

  it("LinkedIn starts a 1to1 chat from the CLASSIC_PRIMARY inbox with ONE id as a string", async () => {
    route("GET", at("/accounts/acc_li"), () =>
      json(account("acc_li", "linkedin"))
    );
    route("POST", at("/acc_li/inboxes/CLASSIC_PRIMARY/chats/send"), () =>
      json({ object: "ChatStarted", chat_id: "chat-9", message_id: "m10" })
    );
    const started = await connector().startChat("acc_li", "ACoAda", "Hello");
    expect(started).toEqual({ chatId: "chat-9", messageId: "m10" });
    const send = calls.find((c) => c.method === "POST")!;
    expect(send.url).toBe(`${BASE}/acc_li/inboxes/CLASSIC_PRIMARY/chats/send`);
    // An array, even of one id, would ask Unipile for a group chat.
    expect(send.body).toEqual({ text: "Hello", users_ids: "ACoAda" });
  });

  it("another provider starts the chat with POST /{account}/chats/send", async () => {
    route("GET", at("/accounts/acc_wa"), () =>
      json(account("acc_wa", "whatsapp"))
    );
    route("POST", at("/acc_wa/chats/send"), () =>
      json({ object: "ChatStarted", chat_id: "wa-chat", message_id: null })
    );
    expect(await connector().startChat("acc_wa", "33600", "Hi")).toEqual({
      chatId: "wa-chat",
      messageId: null,
    });
  });

  it("a refused first message throws (no chat, no message)", async () => {
    route("GET", at("/accounts/acc_li"), () =>
      json(account("acc_li", "linkedin"))
    );
    route("POST", at("/acc_li/inboxes/CLASSIC_PRIMARY/chats/send"), () =>
      json({ type: "errors/no_connection_with_recipient" }, 422)
    );
    await expect(
      connector().startChat("acc_li", "ACoBob", "Hi")
    ).rejects.toThrow(/startChat failed: 422/);
  });

  it("a 2xx first message with no chat_id throws and says the message WAS sent", async () => {
    route("GET", at("/accounts/acc_li"), () =>
      json(account("acc_li", "linkedin"))
    );
    route("POST", at("/acc_li/inboxes/CLASSIC_PRIMARY/chats/send"), () =>
      json({ object: "ChatStarted", message_id: "m11" })
    );
    await expect(
      connector().startChat("acc_li", "ACoAda", "Hi")
    ).rejects.toThrow(/sent but the answer has no chat_id/);
  });
});

describe("profiles and chats — GET /{account}/users/{id}, GET /{account}/chats/{chat}", () => {
  const profile = (extra: Record<string, unknown> = {}) => ({
    object: "UserProfile",
    id: "ACoAda",
    type: "individual",
    public_identifier: "ada-lovelace",
    display_name: "Ada Lovelace",
    first_name: "Ada",
    last_name: "Lovelace",
    provider: "linkedin",
    is_blocked: false,
    specifics: { network_distance: "FIRST_DEGREE" },
    ...extra,
  });

  it("a LinkedIn lookup by public handle gives the member id, the handle and the distance", async () => {
    route("GET", at("/accounts/acc_li"), () =>
      json(account("acc_li", "linkedin"))
    );
    route(
      "GET",
      at("/acc_li/users/ada-lovelace?variant=linkedin_classic"),
      () => json(profile())
    );
    expect(await connector().getProfile("acc_li", "ada-lovelace")).toEqual({
      providerId: "ACoAda",
      publicIdentifier: "ada-lovelace",
      name: "Ada Lovelace",
      networkDistance: "FIRST_DEGREE",
    });
  });

  it("reads the distance wherever the shape puts it (specifics.linkedin, top level, v1 DISTANCE_n); unknown → null", async () => {
    route("GET", at("/accounts/acc_li"), () =>
      json(account("acc_li", "linkedin"))
    );
    let body: unknown = profile({
      specifics: { linkedin: { network_distance: "SECOND_DEGREE" } },
    });
    route("GET", at("/acc_li/users/ACoAda?variant=linkedin_classic"), () =>
      json(body)
    );
    const c = connector();
    expect((await c.getProfile("acc_li", "ACoAda"))!.networkDistance).toBe(
      "SECOND_DEGREE"
    );
    body = profile({ specifics: {}, network_distance: "DISTANCE_1" });
    expect((await c.getProfile("acc_li", "ACoAda"))!.networkDistance).toBe(
      "FIRST_DEGREE"
    );
    body = profile({
      specifics: {},
      display_name: undefined,
      public_identifier: undefined,
    });
    expect(await c.getProfile("acc_li", "ACoAda")).toEqual({
      providerId: "ACoAda",
      publicIdentifier: null,
      name: "Ada Lovelace",
      networkDistance: null,
    });
  });

  it("another provider is looked up without the LinkedIn variant", async () => {
    route("GET", at("/accounts/acc_ig"), () =>
      json(account("acc_ig", "instagram"))
    );
    route("GET", at("/acc_ig/users/ada.ig"), () =>
      json(profile({ id: "ig-1", public_identifier: "ada.ig", specifics: {} }))
    );
    expect(await connector().getProfile("acc_ig", "ada.ig")).toMatchObject({
      providerId: "ig-1",
      networkDistance: null,
    });
  });

  it("no such person (404) is null; any other failure throws — never read as 'not found'", async () => {
    route("GET", at("/accounts/acc_li"), () =>
      json(account("acc_li", "linkedin"))
    );
    route("GET", at("/acc_li/users/nobody?variant=linkedin_classic"), () =>
      json({ type: "errors/resource_not_found" }, 404)
    );
    route("GET", at("/acc_li/users/limited?variant=linkedin_classic"), () =>
      json({ type: "errors/too_many_requests" }, 429)
    );
    const c = connector();
    expect(await c.getProfile("acc_li", "nobody")).toBeNull();
    await expect(c.getProfile("acc_li", "limited")).rejects.toThrow(/429/);
  });

  it("a 1to1 chat names its counterpart; a group has none; 404 → null", async () => {
    route("GET", at("/acc_li/chats/chat-1"), () =>
      json({
        object: "Chat",
        id: "chat-1",
        name: "Ada Lovelace",
        type: "1to1",
        is_group: false,
        user_id: "ACoAda",
        user: {
          object: "User",
          id: "ACoAda",
          display_name: "Ada Lovelace",
          public_identifier: "ada-lovelace",
        },
      })
    );
    route("GET", at("/acc_li/chats/group-1"), () =>
      json({
        object: "Chat",
        id: "group-1",
        name: "Team",
        type: "group",
        is_group: true,
      })
    );
    route("GET", at("/acc_li/chats/gone"), () => json({}, 404));
    route("GET", at("/acc_li/chats/broken"), () => json({}, 500));
    const c = connector();
    expect(await c.getChat("acc_li", "chat-1")).toEqual({
      chatId: "chat-1",
      counterpart: {
        providerId: "ACoAda",
        name: "Ada Lovelace",
        publicIdentifier: "ada-lovelace",
      },
    });
    expect(await c.getChat("acc_li", "group-1")).toEqual({
      chatId: "group-1",
      counterpart: null,
    });
    expect(await c.getChat("acc_li", "gone")).toBeNull();
    await expect(c.getChat("acc_li", "broken")).rejects.toThrow(/500/);
  });
});

describe("paged messages — cursor in, next_cursor out", () => {
  const msg = (id: string) => ({
    object: "Message",
    id,
    chat_id: "chat-1",
    sender_id: "ACoAda",
    text: id,
    timestamp: "2026-10-27T10:00:00.000Z",
    is_sender: false,
  });

  it("walks pages with the cursor until there is none", async () => {
    route("GET", at("/acc_li/chats/chat-1/messages?limit=25"), () =>
      json({ data: [msg("m3"), msg("m2")], next_cursor: "p2" })
    );
    route("GET", at("/acc_li/chats/chat-1/messages?limit=25&cursor=p2"), () =>
      json({ data: [msg("m1")], next_cursor: null })
    );
    const c = connector();
    const first = await c.getMessagesPage("acc_li", "chat-1");
    expect(first.messages.map((m) => m.externalMessageId)).toEqual([
      "m3",
      "m2",
    ]);
    expect(first.nextCursor).toBe("p2");
    const last = await c.getMessagesPage("acc_li", "chat-1", first.nextCursor);
    expect(last).toEqual({
      messages: [
        expect.objectContaining({
          externalMessageId: "m1",
          senderProviderId: "ACoAda",
          direction: "inbound",
        }),
      ],
    });
  });

  it("the unpaged getMessages(account, chat) still answers the first page as an array", async () => {
    route("GET", at("/acc_li/chats/chat-1/messages?limit=25"), () =>
      json({ data: [msg("m3")], next_cursor: "p2" })
    );
    const messages = await connector().getMessages("acc_li", "chat-1");
    expect(messages.map((m) => m.externalMessageId)).toEqual(["m3"]);
  });

  it("a failed page throws — never an empty page a caller reads as 'no history'", async () => {
    route("GET", at("/acc_li/chats/chat-1/messages?limit=25&cursor=p9"), () =>
      json({ type: "errors/invalid_cursor" }, 400)
    );
    await expect(
      connector().getMessagesPage("acc_li", "chat-1", "p9")
    ).rejects.toThrow(/400/);
  });
});

describe("webhook payloads the channel reads, and the endpoint's health", () => {
  const URL = "https://pod.example/api/webhooks/messaging";
  const SECRET = "whsec_1";
  const sign = (body: string, t = "1761650000") =>
    `t=${t},v0=${createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex")}`;
  const endpoint = (events: string[], extra: Record<string, unknown> = {}) => ({
    object: "WebhookEndpoint",
    id: "we_1",
    url: URL,
    trigger_events: events,
    secret: SECRET,
    enabled: true,
    ...extra,
  });
  const deliver = (e: Record<string, unknown>) => {
    const body = JSON.stringify(e);
    return connector().parseWebhook({ "unipile-signature": sign(body) }, body);
  };
  beforeEach(() => {
    route("GET", at("/webhooks/endpoints/?offset=0"), () =>
      json({ data: [endpoint([...UNIPILE_WEBHOOK_EVENTS])], has_more: false })
    );
  });

  it("message.new keeps the sender's provider id, public handle, message id and direction", async () => {
    const event = await deliver({
      id: "evt_2",
      type: "message.new",
      account_id: "acc_li",
      account_provider: "linkedin",
      payload: {
        object: "Message",
        id: "m20",
        chat_id: "chat-1",
        sender_id: "ACoAda",
        sender: {
          object: "User",
          id: "ACoAda",
          display_name: "Ada",
          public_identifier: "ada-lovelace",
        },
        text: "Sounds good",
        timestamp: "2026-11-02T09:00:00.000Z",
        is_sender: false,
      },
    });
    expect(event).toMatchObject({
      type: "message.created",
      threadId: "chat-1",
      message: {
        externalMessageId: "m20",
        senderProviderId: "ACoAda",
        senderPublicIdentifier: "ada-lovelace",
        direction: "inbound",
      },
    });
  });

  it("a message the person sent from their own device is outbound, with their own id", async () => {
    const event = await deliver({
      type: "message.new",
      account_id: "acc_li",
      account_provider: "linkedin",
      payload: {
        id: "m21",
        chat_id: "chat-1",
        sender_id: "ACoMe",
        text: "Sent from my phone",
        timestamp: "2026-11-02T09:01:00.000Z",
        is_sender: true,
      },
    });
    expect(event).toMatchObject({
      type: "message.created",
      message: {
        externalMessageId: "m21",
        senderProviderId: "ACoMe",
        direction: "outbound",
      },
    });
  });

  it("a message.new with no sender at all still becomes message.created (no sender id)", async () => {
    const event = await deliver({
      type: "message.new",
      account_id: "acc_li",
      account_provider: "linkedin",
      payload: {
        id: "m22",
        chat_id: "chat-1",
        text: "system note",
        timestamp: "2026-11-02T09:02:00.000Z",
        is_sender: false,
      },
    });
    expect(event?.type).toBe("message.created");
    if (event?.type !== "message.created") throw new Error("unreachable");
    expect(event.message.externalMessageId).toBe("m22");
    expect(event.message).not.toHaveProperty("senderProviderId");
    expect(event.message.direction).toBe("inbound");
  });

  it("read and delivery receipts become message.status by message id", async () => {
    expect(
      await deliver({
        type: "message.receipt.read",
        account_id: "acc_li",
        account_provider: "linkedin",
        payload: {
          chat_id: "chat-1",
          message_id: "m20",
          user_id: "ACoAda",
          timestamp: "2026-11-02T10:00:00.000Z",
        },
      })
    ).toEqual({
      type: "message.status",
      accountExternalId: "acc_li",
      provider: "linkedin",
      threadId: "chat-1",
      externalMessageId: "m20",
      status: "read",
      at: "2026-11-02T10:00:00.000Z",
    });
    expect(
      await deliver({
        type: "message.receipt.delivery",
        account_id: "acc_fb",
        account_provider: "facebook",
        payload: {
          chat_id: "fb-chat",
          message_id: "fb-m",
          user_id: "u",
          timestamp: "2026-11-02T10:01:00.000Z",
        },
      })
    ).toMatchObject({ type: "message.status", status: "delivered" });
    // A receipt without the message id it is about is not one.
    expect(
      await deliver({
        type: "message.receipt.read",
        account_id: "acc_li",
        payload: { chat_id: "chat-1" },
      })
    ).toBeNull();
  });

  it("an unsigned receipt is dropped like any unsigned delivery", async () => {
    const body = JSON.stringify({
      type: "message.receipt.read",
      account_id: "acc_li",
      payload: { chat_id: "chat-1", message_id: "m20" },
    });
    expect(await connector().parseWebhook({}, body)).toBeNull();
  });

  it("describeWebhook: registered, missing events, missing, disabled, no public URL", async () => {
    let endpoints: unknown[] = [endpoint([...UNIPILE_WEBHOOK_EVENTS])];
    routes = [];
    route("GET", at("/webhooks/endpoints/?offset=0"), () =>
      json({ data: endpoints, has_more: false })
    );
    const c = connector();
    expect(await c.describeWebhook("https://pod.example/")).toEqual({
      state: "registered",
      url: URL,
      missingEvents: [],
    });
    endpoints = [endpoint(["message.new", "account.add"])];
    const partial = await c.describeWebhook("https://pod.example");
    expect(partial.state).toBe("missing-events");
    expect(partial.missingEvents).toContain("message.receipt.read");
    expect(partial.missingEvents).not.toContain("message.new");
    endpoints = [
      {
        ...endpoint([...UNIPILE_WEBHOOK_EVENTS]),
        url: "https://other.example/api/webhooks/messaging",
      },
    ];
    expect((await c.describeWebhook("https://pod.example")).state).toBe(
      "missing"
    );
    endpoints = [endpoint([...UNIPILE_WEBHOOK_EVENTS], { enabled: false })];
    expect(await c.describeWebhook("https://pod.example")).toMatchObject({
      state: "missing",
      error: expect.stringMatching(/disabled/),
    });
    const before = calls.length;
    expect(await c.describeWebhook(undefined)).toEqual({
      state: "no-public-url",
      url: null,
      missingEvents: [...UNIPILE_WEBHOOK_EVENTS],
    });
    expect(calls.length).toBe(before); // nothing asked of Unipile
  });

  it("describeWebhook: a failed read is 'unknown' with the error, never 'missing'", async () => {
    routes = [];
    route("GET", at("/webhooks/endpoints/?offset=0"), () =>
      json({ type: "errors/invalid_api_key" }, 401)
    );
    const health = await connector().describeWebhook("https://pod.example");
    expect(health).toMatchObject({ state: "unknown", url: URL });
    expect(health.error).toMatch(/401/);
  });

  it("ensureWebhooksRegistered asks for the receipt events too", async () => {
    routes = [];
    route("GET", at("/webhooks/endpoints/?offset=0"), () =>
      json({ data: [endpoint(["message.new"])], has_more: false })
    );
    route("PATCH", at("/webhooks/endpoints/we_1"), () =>
      json(endpoint([...UNIPILE_WEBHOOK_EVENTS]))
    );
    await connector().ensureWebhooksRegistered("https://pod.example");
    const patched = (calls.at(-1)!.body as { trigger_events: string[] })
      .trigger_events;
    expect(patched).toEqual(
      expect.arrayContaining([
        "message.receipt.read",
        "message.receipt.delivery",
      ])
    );
  });
});
