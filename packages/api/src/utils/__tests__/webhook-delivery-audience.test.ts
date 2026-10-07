/**
 * Webhook fan-out reaches ONLY subscriptions whose owner may read the event's
 * subject. The defect this pins: `dispatchWebhooksForEvent` selected every
 * active matching `webhook_subscriptions` row on the pod with no owner filter,
 * so on a multi-user pod user B's webhook received user A's chat messages and
 * entity updates.
 *
 * Boundaries mocked (the same seams the neighbouring tests mock): the
 * subscription SELECT (`db`), the channel reader set
 * (`listChannelAudienceUserIds`), the entity read floor (`scopedDb`), and the
 * outbound fetch (`safeExternalFetch`). Driven through the real emit door
 * (`emitChatEvent`) for chat, and the util's own door for entities.
 *
 * NOT covered, measured: the channel read predicate itself (pinned by
 * `chat-realtime-audience.pglite.test.ts`) and the entity floor itself
 * (`accessScopeWhere`, pinned in `access/`). This test proves the dispatcher
 * CONSULTS those doors and filters by owner; it does not re-prove the doors.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  subs: [] as Array<{
    id: string;
    userId: string;
    url: string;
    secret: string;
  }>,
  channelReaders: new Map<string, string[]>(),
  entityReaders: new Map<string, string[]>(),
  fetch: vi.fn(async () => ({ ok: true, status: 200 })),
}));

vi.mock("@synap/database", () => {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: async () => h.subs,
  };
  return {
    db: chain,
    webhookSubscriptions: {},
    eq: () => ({}),
    and: () => ({}),
    drizzleSql: () => ({}),
  };
});
vi.mock("@synap/database/schema", () => ({ entities: { id: "id" } }));
vi.mock("@synap/shared-utils", () => ({ safeExternalFetch: h.fetch }));
vi.mock("../channel-visibility.js", () => ({
  listChannelAudienceUserIds: async (_db: unknown, channelId: string) =>
    h.channelReaders.get(channelId) ?? [],
}));
vi.mock("../../access/index.js", () => ({
  AccessContext: { operator: ({ userId }: { userId: string }) => ({ userId }) },
  scopedDb: (access: { userId: string }) => ({
    findMany: async () => {
      // The entity under test is whichever was registered; the mock floor
      // admits exactly the registered readers.
      const [[entityId, readers]] = [...h.entityReaders.entries()];
      return readers.includes(access.userId) ? [{ id: entityId }] : [];
    },
  }),
}));
// The socket bridge + turn observer are separate transports; keep them inert.
vi.mock("../chat-turn-observer.js", () => ({
  notifyChatTurnObserver: () => undefined,
}));

import { deliverWebhooksForEvent } from "../webhook-delivery.js";
import { emitChatEvent } from "../chat-realtime-broadcast.js";

const A_URL = "https://a.example/hook";
const B_URL = "https://b.example/hook";

function deliveredUrls(): string[] {
  return (h.fetch.mock.calls as unknown as Array<[string]>).map((c) => c[0]);
}

beforeEach(() => {
  h.fetch.mockClear();
  h.channelReaders.clear();
  h.entityReaders.clear();
  h.subs = [
    { id: "sub-a", userId: "user-a", url: A_URL, secret: "sa" },
    { id: "sub-b", userId: "user-b", url: B_URL, secret: "sb" },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true }))
  );
});

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("webhook fan-out is bounded by who may read the subject", () => {
  it("a chat message in A's channel reaches A's webhook, never B's", async () => {
    h.channelReaders.set("chan-a", ["user-a"]);
    emitChatEvent({
      event: "chat:message",
      data: { channelId: "chan-a", content: "secret plan" },
      channelId: "chan-a",
      userId: "user-a",
      workspaceId: "ws-1",
    });
    await settle();
    expect(deliveredUrls()).toEqual([A_URL]);
    // Payload + signature shape preserved for existing subscribers.
    const [, init] = h.fetch.mock.calls[0] as unknown as [
      string,
      { body: string; headers: Record<string, string> },
    ];
    expect(JSON.parse(init.body)).toMatchObject({
      event: "chat:message",
      data: { channelId: "chan-a" },
    });
    expect(init.headers["X-Synap-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(init.headers["X-Synap-Event"]).toBe("chat:message");
  });

  it("a channel both users read reaches both", async () => {
    h.channelReaders.set("chan-shared", ["user-a", "user-b"]);
    emitChatEvent({
      event: "chat:message",
      data: { channelId: "chan-shared" },
      channelId: "chan-shared",
      userId: "user-a",
    });
    await settle();
    expect(deliveredUrls().sort()).toEqual([A_URL, B_URL].sort());
  });

  it("a payload-named channel the actor cannot read reaches only the actor", async () => {
    h.channelReaders.set("chan-a", ["user-a"]);
    emitChatEvent({
      event: "chat:message",
      data: { channelId: "chan-a" },
      userId: "user-b",
    });
    await settle();
    expect(deliveredUrls()).toEqual([B_URL]);
  });

  it("an update to A's entity reaches A's webhook, never B's", async () => {
    h.entityReaders.set("ent-a", ["user-a"]);
    await deliverWebhooksForEvent(
      "entity.update.completed",
      { entityId: "ent-a", changedProperties: { salary: 1 } },
      { kind: "entity", entityId: "ent-a" }
    );
    expect(deliveredUrls()).toEqual([A_URL]);
  });

  it("a failed audience read delivers to nobody (not everyone)", async () => {
    // No entity registered: the mock floor throws on destructuring.
    await deliverWebhooksForEvent(
      "entity.update.completed",
      { entityId: "ent-x" },
      { kind: "entity", entityId: "ent-x" }
    );
    expect(deliveredUrls()).toEqual([]);
  });

  it("an event with no channel or entity reaches only the actor", async () => {
    await deliverWebhooksForEvent(
      "chat:thread:created",
      {},
      { kind: "user", userId: "user-a" }
    );
    expect(deliveredUrls()).toEqual([A_URL]);
  });
});
