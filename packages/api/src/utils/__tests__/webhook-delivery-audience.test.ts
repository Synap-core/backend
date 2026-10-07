/**
 * Webhook fan-out reaches ONLY subscriptions whose owner may read the event's
 * subject. The defect this pins: `dispatchWebhooksForEvent` selected every
 * active matching `webhook_subscriptions` row on the pod with no owner filter,
 * so on a multi-user pod user B's webhook received user A's chat messages and
 * entity updates.
 *
 * Since W7 the API no longer sends HTTP: it resolves the audience and hands
 * one job per allowed subscription to THE ONE webhook door (the
 * `webhook-delivery` queue, `@synap/jobs/workers/webhook-worker`). These tests
 * drive the REAL door end to end: every job the API enqueues is run through
 * the real `handleWebhookDelivery`, with pg-boss's retry semantics simulated
 * (a throw = retry, up to the job's `retryLimit`).
 *
 * Boundaries mocked (the same seams the neighbouring tests mock): the
 * subscription SELECTs (`db`), the channel reader set
 * (`listChannelAudienceUserIds`), the entity read floor (`scopedDb`), pg-boss
 * (`getBoss` — a recorder), and the outbound fetch (`safeExternalFetch`).
 * Driven through the real emit door (`emitChatEvent`) for chat, and the util's
 * own door for entities.
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
    active: boolean;
    eventTypes?: string[];
  }>,
  channelReaders: new Map<string, string[]>(),
  entityReaders: new Map<string, string[]>(),
  fetch: vi.fn(async () => ({ ok: true, status: 200 })),
  sent: [] as Array<{ queue: string; data: unknown; options: unknown }>,
}));

vi.mock("@synap/database", () => {
  // `eq(column, value)` is recorded so a `where` can answer by value: the API
  // filters `active = true` (all subs), the door looks one up by id.
  const where = (cond: { val?: unknown }) => {
    const rows =
      typeof cond?.val === "string"
        ? h.subs.filter((s) => s.id === cond.val)
        : h.subs;
    return Object.assign(Promise.resolve(rows), {
      limit: async (n: number) => rows.slice(0, n),
    });
  };
  const chain = {
    select: () => chain,
    from: () => chain,
    where,
    update: () => chain,
    set: () => chain,
  };
  return {
    db: chain,
    webhookSubscriptions: { id: "id", active: "active" },
    webhookDeliveries: {},
    eq: (_col: unknown, val: unknown) => ({ val }),
    and: () => ({}),
    drizzleSql: () => ({}),
  };
});
vi.mock("@synap/events", () => ({
  getBoss: () => ({
    send: async (queue: string, data: unknown, options: unknown) => {
      h.sent.push({ queue, data, options });
      return "job-id";
    },
  }),
}));
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
import { handleWebhookDelivery } from "@synap/jobs/workers/webhook-worker.js";

const A_URL = "https://a.example/hook";
const B_URL = "https://b.example/hook";

function deliveredUrls(): string[] {
  return (h.fetch.mock.calls as unknown as Array<[string]>).map((c) => c[0]);
}

/**
 * Run every enqueued job through the REAL door, simulating pg-boss: a throw
 * is a retry, up to the job's `retryLimit`. Returns the attempts per job.
 */
async function drainQueue(): Promise<number[]> {
  const attempts: number[] = [];
  while (h.sent.length > 0) {
    const { queue, data, options } = h.sent.shift()!;
    expect(queue).toBe("webhook-delivery");
    const retryLimit = (options as { retryLimit?: number })?.retryLimit ?? 0;
    let n = 0;
    for (;;) {
      n++;
      try {
        await handleWebhookDelivery(
          { id: "j", name: queue, data, expireInSeconds: 60 } as never,
          { send: async () => "x" } as never
        );
        break;
      } catch {
        if (n > retryLimit) break;
      }
    }
    attempts.push(n);
  }
  return attempts;
}

beforeEach(() => {
  h.fetch.mockReset();
  h.fetch.mockImplementation(async () => ({ ok: true, status: 200 }));
  h.sent = [];
  h.channelReaders.clear();
  h.entityReaders.clear();
  h.subs = [
    { id: "sub-a", userId: "user-a", url: A_URL, secret: "sa", active: true },
    { id: "sub-b", userId: "user-b", url: B_URL, secret: "sb", active: true },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true }))
  );
});

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  await drainQueue();
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
    expect(init.headers["X-Synap-Webhook-Format"]).toBe("chat.v1");
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
    await drainQueue();
    expect(deliveredUrls()).toEqual([A_URL]);
  });

  it("a failed audience read delivers to nobody (not everyone)", async () => {
    // No entity registered: the mock floor throws on destructuring.
    await deliverWebhooksForEvent(
      "entity.update.completed",
      { entityId: "ent-x" },
      { kind: "entity", entityId: "ent-x" }
    );
    await drainQueue();
    expect(deliveredUrls()).toEqual([]);
  });

  it("an event with no channel or entity reaches only the actor", async () => {
    await deliverWebhooksForEvent(
      "chat:thread:created",
      {},
      { kind: "user", userId: "user-a" }
    );
    await drainQueue();
    expect(deliveredUrls()).toEqual([A_URL]);
  });
});

describe("webhook delivery goes through the ONE door, with retries", () => {
  it("the API enqueues one job per allowed subscription — it never POSTs itself", async () => {
    h.channelReaders.set("chan-a", ["user-a"]);
    emitChatEvent({
      event: "chat:message",
      data: { channelId: "chan-a" },
      channelId: "chan-a",
      userId: "user-a",
    });
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({
      queue: "webhook-delivery",
      data: { stage: "deliver", subscriptionId: "sub-a", format: "chat.v1" },
      options: { retryLimit: 3, retryBackoff: true },
    });
  });

  it("a failing endpoint is retried with the SAME bytes, signature and delivery id, then lands", async () => {
    h.entityReaders.set("ent-a", ["user-a"]);
    h.fetch
      .mockImplementationOnce(async () => ({ ok: false, status: 503 }))
      .mockImplementationOnce(async () => {
        throw new Error("ECONNRESET");
      });
    await deliverWebhooksForEvent(
      "entity.update.completed",
      { entityId: "ent-a" },
      { kind: "entity", entityId: "ent-a" }
    );
    const attempts = await drainQueue();

    expect(attempts).toEqual([3]);
    expect(deliveredUrls()).toEqual([A_URL, A_URL, A_URL]);
    const inits = (
      h.fetch.mock.calls as unknown as Array<
        [string, { body: string; headers: Record<string, string> }]
      >
    ).map((c) => c[1]);
    expect(new Set(inits.map((i) => i.body)).size).toBe(1);
    expect(new Set(inits.map((i) => i.headers["X-Synap-Signature"])).size).toBe(
      1
    );
    expect(
      new Set(inits.map((i) => i.headers["X-Synap-Delivery-Id"])).size
    ).toBe(1);
  });

  it("an endpoint that never recovers stops at the retry limit (1 + 3 attempts)", async () => {
    h.entityReaders.set("ent-a", ["user-a"]);
    h.fetch.mockImplementation(async () => ({ ok: false, status: 500 }));
    await deliverWebhooksForEvent(
      "entity.update.completed",
      { entityId: "ent-a" },
      { kind: "entity", entityId: "ent-a" }
    );
    expect(await drainQueue()).toEqual([4]);
  });

  it("a subscription paused after enqueue receives nothing and is not retried", async () => {
    h.entityReaders.set("ent-a", ["user-a"]);
    await deliverWebhooksForEvent(
      "entity.update.completed",
      { entityId: "ent-a" },
      { kind: "entity", entityId: "ent-a" }
    );
    h.subs[0]!.active = false;
    expect(await drainQueue()).toEqual([1]);
    expect(deliveredUrls()).toEqual([]);
  });

  it("a subscription that did not list the event type gets nothing", async () => {
    h.entityReaders.set("ent-a", ["user-a"]);
    h.subs[0]!.eventTypes = ["chat:message"];
    await deliverWebhooksForEvent(
      "entity.update.completed",
      { entityId: "ent-a" },
      { kind: "entity", entityId: "ent-a" }
    );
    await drainQueue();
    expect(deliveredUrls()).toEqual([]);
  });
});
