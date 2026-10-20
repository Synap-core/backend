/**
 * S2 + D7 in producer 1 (domain events) and the delivery door.
 *
 * A subscription created by an API key (`api_key_id`) is delivered only while
 * that key is LIVE (active, not revoked, not expired) — decided at delivery
 * time, from the `api_keys` row, never by a cleanup job — and only for an
 * event whose subject the key's GRANT can read. The grant read lives in the
 * API's access layer, which jobs cannot import: the API registers it
 * (`registerKeyGrantAudience`); with none registered a key-bound subscription
 * receives nothing (fail closed). A session-created subscription (no key) is
 * unchanged: owner + workspace rule.
 *
 * Real on PGlite: the subscription read and the key-liveness read. Recorded:
 * pg-boss (what is enqueued IS the audience) and the outbound fetch.
 *
 * Rows rule out: liveness ignored (revoked / expired / inactive rows), a
 * liveness check that also drops session rows, a grant answer ignored (the
 * denied row), a resolver that is asked about the wrong subject or key, an
 * unregistered resolver read as "everything", and a delivery door that sends
 * for a key revoked after the job was queued.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000 });

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  fetched: [] as string[],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client) };
});
vi.mock("@synap/shared-utils", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  safeExternalFetch: async (url: string) => {
    h.fetched.push(url);
    return { ok: true, status: 200 };
  },
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { apiKeys, webhookSubscriptions } from "@synap/database/schema";
import {
  deliverWebhook,
  handleWebhookDelivery,
  registerKeyGrantAudience,
  type KeyGrantSubject,
} from "./webhook-worker.js";

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
const KEY = {
  live: randomUUID(),
  denied: randomUUID(),
  revoked: randomUUID(),
  inactive: randomUUID(),
  expired: randomUUID(),
  later: randomUUID(),
};
const SUB = {
  session: randomUUID(),
  live: randomUUID(),
  denied: randomUUID(),
  revoked: randomUUID(),
  inactive: randomUUID(),
  expired: randomUUID(),
  later: randomUUID(),
};
const SUBJECT = randomUUID();
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

/** The grant answer the API would give: only `live` and `later` read it. */
let asked: KeyGrantSubject[] = [];
const grantReads = async (s: KeyGrantSubject) => {
  asked.push(s);
  return s.apiKeyId === KEY.live || s.apiKeyId === KEY.later;
};

beforeAll(async () => {
  await h.client!.exec(ddlFor(webhookSubscriptions as unknown as PgTable));
  await h.client!.exec(ddlFor(apiKeys as unknown as PgTable));
  const keyRows: Array<[string, boolean, string | null, string | null]> = [
    [KEY.live, true, null, null],
    [KEY.denied, true, null, null],
    [KEY.revoked, false, "now()", null],
    [KEY.inactive, false, null, null],
    [KEY.expired, true, null, "now() - interval '1 day'"],
    [KEY.later, true, null, "now() + interval '1 day'"],
  ];
  for (const [id, active, revokedAt, expiresAt] of keyRows) {
    await q(
      `insert into api_keys (id, user_id, key_name, is_active, revoked_at, expires_at)
       values ($1,$2,'k',$3,${revokedAt ?? "null"},${expiresAt ?? "null"})`,
      [id, A, active]
    );
  }
  for (const [id, key] of [
    [SUB.session, null],
    [SUB.live, KEY.live],
    [SUB.denied, KEY.denied],
    [SUB.revoked, KEY.revoked],
    [SUB.inactive, KEY.inactive],
    [SUB.expired, KEY.expired],
    [SUB.later, KEY.later],
  ] as const) {
    await q(
      `insert into webhook_subscriptions (id, user_id, api_key_id, name, url, event_types, secret, active, retry_config)
       values ($1,$2,$3,'s','https://hook.example/' || $4,'{entity.update.completed}','sec',true,'{"maxRetries":0}'::jsonb)`,
      [id, A, key, id]
    );
  }
});

beforeEach(() => {
  asked = [];
  h.fetched = [];
  registerKeyGrantAudience(grantReads);
});

/** Run one fan-out job; return the subscription ids it enqueued a delivery for. */
async function audience(): Promise<string[]> {
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
        subjectId: SUBJECT,
        userId: A,
        workspaceId: null,
        data: {},
      },
    } as never,
    boss as never
  );
  return sent.map((d) => d.subscriptionId!).sort();
}

describe("domain-event fan-out — key-bound subscriptions", () => {
  it("delivers to the session row and to live keys whose grant reads the subject only", async () => {
    expect(await audience()).toEqual([SUB.session, SUB.live, SUB.later].sort());
  });

  it("asks the grant about the event's subject, as the subscription's key and owner", async () => {
    await audience();
    const live = asked.find((s) => s.apiKeyId === KEY.live);
    expect(live).toEqual({
      apiKeyId: KEY.live,
      ownerUserId: A,
      subjectType: "entity",
      subjectId: SUBJECT,
    });
    // A dead key's grant is never consulted: liveness is decided first.
    for (const dead of [KEY.revoked, KEY.inactive, KEY.expired]) {
      expect(asked.some((s) => s.apiKeyId === dead)).toBe(false);
    }
  });

  it("with no grant reader registered, key-bound rows get nothing (session row unchanged)", async () => {
    registerKeyGrantAudience(null);
    expect(await audience()).toEqual([SUB.session]);
  });

  it("a grant read that throws drops that row only", async () => {
    registerKeyGrantAudience(async (s) => {
      if (s.apiKeyId === KEY.later) throw new Error("grant read failed");
      return grantReads(s);
    });
    expect(await audience()).toEqual([SUB.session, SUB.live].sort());
  });
});

describe("the delivery door — liveness at send time", () => {
  const job = (subscriptionId: string) => ({
    stage: "deliver" as const,
    subscriptionId,
    eventType: "entity.update.completed",
    format: "event.v1" as const,
    body: "{}",
    deliveryId: randomUUID(),
  });

  it("does not send for a key revoked or expired after the job was queued", async () => {
    for (const s of [SUB.revoked, SUB.inactive, SUB.expired]) {
      await deliverWebhook(job(s));
    }
    expect(h.fetched).toEqual([]);
  });

  it("sends for a live key and for a session row (control)", async () => {
    await deliverWebhook(job(SUB.live));
    await deliverWebhook(job(SUB.session));
    expect(h.fetched).toHaveLength(2);
  });
});
