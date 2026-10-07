/**
 * The domain-event producer reaches subscribers through THE ONE webhook door.
 *
 * Driven from the REAL reactor (`webhook-delivery` in `@synap/events`
 * side-effects, found in the live registry) through the real
 * `handleWebhookDelivery` fan-out and the real per-subscription delivery, with
 * pg-boss simulated by a recorder (a throw = retry, up to the job's
 * `retryLimit`). Boundaries mocked: `db` and the outbound fetch.
 *
 * Pins:
 *   - audience: a domain event reaches ONLY its own user's subscriptions;
 *   - wire format `event.v1` is byte-compatible with what this worker always
 *     sent (body keys, raw-hex signature, X-Synap-Event-Type / -Event-Id), and
 *     now names itself in `X-Synap-Webhook-Format`;
 *   - a failed POST is retried (it used to be swallowed, so pg-boss never
 *     retried it);
 *   - the delivery log references the `events` row (`eventId`), never the
 *     subject id — `webhook_deliveries.event_id` is an FK to `events.id`, so
 *     logging the subject id made the insert throw after the POST, and the
 *     redelivery re-POSTed every subscriber.
 *
 * NOT covered, measured: pg-boss's own retry scheduling (backoff timing) — the
 * test asserts the options handed to `send`, and simulates the retry loop.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";

const h = vi.hoisted(() => ({
  subs: [] as Array<{
    id: string;
    userId: string;
    url: string;
    secret: string;
    active: boolean;
    eventTypes: string[];
    retryConfig?: unknown;
  }>,
  fetch: vi.fn(async () => ({ ok: true, status: 200 })),
  inserted: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", () => {
  // `eq(col, val)` is recorded so a `where` can answer by value: the fan-out
  // reads by owner (`user_id = …`), the delivery by subscription id.
  const where = (cond: { col?: string; val?: unknown }) => {
    const rows =
      cond?.col === "user_id"
        ? h.subs.filter((s) => s.userId === cond.val && s.active)
        : cond?.col === "id"
          ? h.subs.filter((s) => s.id === cond.val)
          : [{ n: h.inserted.length }];
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
    insert: () => ({
      values: async (v: Record<string, unknown>) => {
        h.inserted.push(v);
      },
    }),
  };
  return {
    db: chain,
    webhookSubscriptions: { id: "id", userId: "user_id", active: "active" },
    webhookDeliveries: {
      subscriptionId: "subscription_id",
      eventId: "event_id",
    },
    // `and(a, b)` keeps the first condition so owner reads still filter by owner.
    eq: (col: string, val: unknown) => ({ col, val }),
    and: (first: unknown) => first,
    drizzleSql: () => ({}),
  };
});
vi.mock("@synap/shared-utils", () => ({ safeExternalFetch: h.fetch }));

import { getReactors } from "@synap/events";
import { handleWebhookDelivery } from "./webhook-worker.js";

const A_URL = "https://a.example/hook";
const B_URL = "https://b.example/hook";
const EVENT_ROW = "99999999-9999-4999-8999-999999999999";
const SUBJECT = "11111111-1111-4111-8111-111111111111";

type Sent = { queue: string; data: unknown; options?: unknown };

function recorder(): {
  boss: { send: (...a: unknown[]) => Promise<string> };
  sent: Sent[];
} {
  const sent: Sent[] = [];
  return {
    sent,
    boss: {
      send: async (queue: unknown, data: unknown, options?: unknown) => {
        sent.push({ queue: queue as string, data, options });
        return "job-id";
      },
    },
  };
}

/** Emit through the REAL reactor, then drain every job through the REAL door. */
async function emitAndDrain(
  payload: Record<string, unknown>
): Promise<number[]> {
  const reactor = getReactors().find((r) => r.id === "webhook-delivery");
  expect(reactor, "the webhook reactor is registered").toBeDefined();
  const { boss, sent } = recorder();
  await reactor!.handler(payload as never, { boss } as never);

  const attempts: number[] = [];
  while (sent.length > 0) {
    const { queue, data, options } = sent.shift()!;
    expect(queue).toBe("webhook-delivery");
    const retryLimit = (options as { retryLimit?: number })?.retryLimit ?? 0;
    let n = 0;
    for (;;) {
      n++;
      try {
        await handleWebhookDelivery(
          { id: "j", name: queue, data, expireInSeconds: 60 } as never,
          boss as never
        );
        break;
      } catch {
        if (n > retryLimit) break;
      }
    }
    // The fan-out job itself is not a delivery; count only deliveries.
    if ((data as { stage?: string }).stage === "deliver") attempts.push(n);
  }
  return attempts;
}

function calls(): Array<
  [string, { body: string; headers: Record<string, string> }]
> {
  return h.fetch.mock.calls as never;
}

beforeEach(() => {
  h.fetch.mockReset();
  h.fetch.mockImplementation(async () => ({ ok: true, status: 200 }));
  h.inserted = [];
  h.subs = [
    {
      id: "sub-a",
      userId: "user-a",
      url: A_URL,
      secret: "sa",
      active: true,
      eventTypes: ["entity.update.completed"],
    },
    {
      id: "sub-b",
      userId: "user-b",
      url: B_URL,
      secret: "sb",
      active: true,
      eventTypes: ["entity.update.completed"],
    },
  ];
});

const EVENT = {
  subjectType: "entity",
  action: "update",
  subjectId: SUBJECT,
  userId: "user-a",
  workspaceId: "ws-1",
  data: { title: "Q3 plan" },
  eventId: EVENT_ROW,
};

describe("domain events through the one webhook door", () => {
  it("reach only the event's own user, in the unchanged event.v1 format", async () => {
    expect(await emitAndDrain(EVENT)).toEqual([1]);
    expect(calls().map((c) => c[0])).toEqual([A_URL]);

    const [, init] = calls()[0]!;
    expect(Object.keys(JSON.parse(init.body))).toEqual([
      "type",
      "subjectId",
      "userId",
      "data",
      "timestamp",
    ]);
    expect(JSON.parse(init.body)).toMatchObject({
      type: "entity.update.completed",
      subjectId: SUBJECT,
      userId: "user-a",
      data: { title: "Q3 plan" },
    });
    const expectedSig = createHmac("sha256", "sa")
      .update(init.body)
      .digest("hex");
    expect(init.headers["X-Synap-Signature"]).toBe(expectedSig);
    expect(init.headers["X-Synap-Event-Type"]).toBe("entity.update.completed");
    expect(init.headers["X-Synap-Event-Id"]).toBe(SUBJECT);
    expect(init.headers["X-Synap-Webhook-Format"]).toBe("event.v1");
    expect(init.headers["X-Synap-Delivery-Id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("a failed POST is retried until it lands, and each attempt is logged against the events row", async () => {
    h.fetch
      .mockImplementationOnce(async () => ({ ok: false, status: 502 }))
      .mockImplementationOnce(async () => ({ ok: true, status: 200 }));
    expect(await emitAndDrain(EVENT)).toEqual([2]);
    expect(calls().map((c) => c[0])).toEqual([A_URL, A_URL]);
    expect(calls()[0]![1].body).toBe(calls()[1]![1].body);

    expect(h.inserted.map((r) => [r.eventId, r.status, r.attempt])).toEqual([
      [EVENT_ROW, "failed", 1],
      [EVENT_ROW, "success", 2],
    ]);
  });

  it("with no events row, nothing is logged — the subject id is never written as an event id", async () => {
    await emitAndDrain({ ...EVENT, eventId: undefined });
    expect(calls()).toHaveLength(1);
    expect(h.inserted).toEqual([]);
  });

  it("a subscription that did not list the type gets nothing", async () => {
    h.subs[0]!.eventTypes = ["entity.create.completed"];
    await emitAndDrain(EVENT);
    expect(calls()).toEqual([]);
  });
});
