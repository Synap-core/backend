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
        body: "Hi",
        sentAt: "2026-10-27T10:00:00.000Z",
        direction: "inbound",
        attachments: [{ name: "deck.pdf", url: "https://f/1" }],
      },
      {
        externalMessageId: "m2",
        threadId: "chat-1",
        senderName: "me",
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
    await connector().sendMessage("acc_li", "chat-1", "On my way");
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
