/**
 * Producer 1 (domain events) honours a subscription's WORKSPACE binding (O4).
 *
 * The fan-out read runs as SQL on PGlite over a real `webhook_subscriptions`
 * table, so the binding must be SELECTED, not only filtered on (a mocked db
 * hands back whatever the fixture holds and would pass with the column
 * missing). pg-boss is a recorder: what the fan-out enqueues is the audience.
 *
 * The defect: `fanOutDomainEvent` matched on owner only, so a subscription
 * bound to workspace W (`webhooks.createForWorkspace`, or a site's webhook)
 * received every event of its creator — every space.
 *
 * Rows rule out: no workspace filter (the ws-2 row), a filter that drops
 * unbound subscriptions (the unbound rows), a pod-wide event reaching a bound
 * subscription (the null rows), and an owner leak (B's row).
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000 });

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client) };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { webhookSubscriptions } from "@synap/database/schema";
import { handleWebhookDelivery } from "./webhook-worker.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const A = "user-a";
const B = "user-b";
const WS1 = randomUUID();
const WS2 = randomUUID();
const SUB = {
  unbound: randomUUID(),
  ws1: randomUUID(),
  ws2: randomUUID(),
  bOther: randomUUID(),
};

beforeAll(async () => {
  await h.client!.exec(ddlFor(webhookSubscriptions as unknown as PgTable));
  for (const [id, user, ws] of [
    [SUB.unbound, A, null],
    [SUB.ws1, A, WS1],
    [SUB.ws2, A, WS2],
    [SUB.bOther, B, null],
  ] as const) {
    await h.client!.query(
      `insert into webhook_subscriptions (id, user_id, workspace_id, name, url, event_types, secret, active, retry_config)
       values ($1,$2,$3,'s','https://hook.example/x','{entity.update.completed}','sec',true,'{"maxRetries":0}'::jsonb)`,
      [id, user, ws]
    );
  }
});

/** Run one fan-out job; return the subscription ids it enqueued a delivery for. */
async function audience(
  workspaceId: string | null | undefined
): Promise<string[]> {
  const sent: Array<{ subscriptionId?: string }> = [];
  const boss = {
    send: async (_q: string, data: { subscriptionId?: string }) => {
      sent.push(data);
      return "job";
    },
  };
  await handleWebhookDelivery(
    {
      id: randomUUID(),
      name: "webhook-delivery",
      expireInSeconds: 60,
      data: {
        eventType: "entity.update.completed",
        subjectId: randomUUID(),
        userId: A,
        workspaceId,
        data: {},
      },
    } as never,
    boss as never
  );
  return sent.map((d) => d.subscriptionId!).sort();
}

describe("domain-event fan-out — workspace-bound subscriptions", () => {
  it("an event of WS1 reaches the unbound and the WS1-bound subscription, never WS2's", async () => {
    expect(await audience(WS1)).toEqual([SUB.unbound, SUB.ws1].sort());
  });

  it("an event of WS2 reaches the unbound and the WS2-bound subscription", async () => {
    expect(await audience(WS2)).toEqual([SUB.unbound, SUB.ws2].sort());
  });

  it("a pod-wide event (null workspace) reaches unbound subscriptions only", async () => {
    expect(await audience(null)).toEqual([SUB.unbound]);
    expect(await audience(undefined)).toEqual([SUB.unbound]);
  });

  it("another person's subscription never matches (owner rule unchanged)", async () => {
    for (const ws of [WS1, WS2, null]) {
      expect(await audience(ws)).not.toContain(SUB.bOther);
    }
  });
});
