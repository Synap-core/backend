/**
 * D7 — a key-bound webhook delivers exactly what its key's GRANT can read, in
 * BOTH producers; S2 — a revoked key's subscription gets nothing.
 *
 * Real on PGlite: the subscriptions, the keys (liveness), the grants
 * (`GrantRepository.resolveForKey`), the owner read floor
 * (`scopedDb(AccessContext.operator)`) and the grant read clause
 * (`grant-read.ts`, `entity.<kind>.read` + workspace pins). Producer 1 runs the
 * jobs fan-out (`handleWebhookDelivery`) with the resolver the API registers
 * at load. Mocked: pg-boss (a recorder: what is enqueued IS the audience) and
 * the channel reader set.
 *
 * Owner A holds: a note in WS1, a note in WS2, a pod-wide PERSON. Keys:
 *   WS1    `entity.*.read` pinned to WS1
 *   PERSON `entity.note.read` pinned to WS1  +  `entity.person.read` (no pin)
 *   NOTE   `entity.note.read` (no pin)
 *   ALL    `*` (unbounded)
 *   REV    `*`, but the key is revoked
 * plus one SESSION subscription (no key) — today's owner-wide rule.
 *
 * Rows rule out: owner-wide delivery for a key (WS2 note / person to WS1),
 * a workspace pin ignored, kinds ignored (person to NOTE), pod-wide rows never
 * reaching a key (person to PERSON / ALL), a revoked key still delivered, the
 * session row narrowed by any key's grant, and producer 1 skipping the grant.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000 });

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  sent: [] as Array<{ subscriptionId?: string }>,
  channelReaders: [] as string[],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return { ...actual, db, getDb: async () => db };
});
vi.mock("@synap/events", () => ({
  getBoss: () => ({
    send: async (_q: string, data: { subscriptionId?: string }) => {
      h.sent.push(data);
      return "job";
    },
  }),
}));
vi.mock("../channel-visibility.js", async (importOriginal) => ({
  // The channel read floor stays real (the access rule for `channels`).
  ...(await importOriginal<Record<string, unknown>>()),
  listChannelAudienceUserIds: async () => h.channelReaders,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { handleWebhookDelivery } from "@synap/jobs/workers/webhook-worker.js";
// Importing the API module registers its grant read into the jobs fan-out.
import { deliverWebhooksForEvent } from "../webhook-delivery.js";
// The grant read clause registers itself with scopedDb at load.
import "../../access/grant-read.js";

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

const A = randomUUID();
const WS1 = randomUUID();
const WS2 = randomUUID();
const NOTE_WS1 = randomUUID();
const NOTE_WS2 = randomUUID();
const PERSON = randomUUID();
const CH_WS1 = randomUUID();
const KEY = {
  ws1: randomUUID(),
  person: randomUUID(),
  note: randomUUID(),
  all: randomUUID(),
  rev: randomUUID(),
};
const SUB = {
  session: randomUUID(),
  ws1: randomUUID(),
  person: randomUUID(),
  note: randomUUID(),
  all: randomUUID(),
  rev: randomUUID(),
};
const EVENT = "entity.update.completed";

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

async function grant(
  keyId: string,
  permissions: string[],
  workspaceIds: string[] | null
) {
  await q(
    `insert into grants (id, api_key_id, principal_user_id, on_behalf_of, permissions, workspace_ids, created_by, created_at)
     values ($1,$2,$3,$3,$4,$5,$3, now())`,
    [randomUUID(), keyId, A, permissions, workspaceIds]
  );
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(`insert into users (id, email) values ($1,'a@example.test')`, [A]);
  for (const ws of [WS1, WS2]) {
    await q(
      `insert into workspaces (id, name, owner_id, settings) values ($1,$2,$3,'{}'::jsonb)`,
      [ws, `ws-${ws.slice(0, 4)}`, A]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
      [randomUUID(), ws, A]
    );
  }
  for (const [id, ws, type] of [
    [NOTE_WS1, WS1, "note"],
    [NOTE_WS2, WS2, "note"],
    [PERSON, null, "person"],
  ] as const) {
    await q(
      `insert into entities (id, user_id, workspace_id, type, title, properties, system_data)
       values ($1,$2,$3,$4,'n','{}'::jsonb,'{}'::jsonb)`,
      [id, A, ws, type]
    );
  }
  await q(
    `insert into channels (id, title, user_id, workspace_id, channel_type) values ($1,'c',$2,$3,'workspace')`,
    [CH_WS1, A, WS1]
  );

  for (const [id, active] of [
    [KEY.ws1, true],
    [KEY.person, true],
    [KEY.note, true],
    [KEY.all, true],
    [KEY.rev, false],
  ] as const) {
    await q(
      `insert into api_keys (id, user_id, key_name, is_active, revoked_at) values ($1,$2,'k',$3,${
        active ? "null" : "now()"
      })`,
      [id, A, active]
    );
  }
  await grant(KEY.ws1, ["entity.*.read"], [WS1]);
  await grant(KEY.person, ["entity.note.read"], [WS1]);
  await grant(KEY.person, ["entity.person.read"], null);
  await grant(KEY.note, ["entity.note.read"], null);
  await grant(KEY.all, ["*"], null);
  await grant(KEY.rev, ["*"], null);

  for (const [id, key] of [
    [SUB.session, null],
    [SUB.ws1, KEY.ws1],
    [SUB.person, KEY.person],
    [SUB.note, KEY.note],
    [SUB.all, KEY.all],
    [SUB.rev, KEY.rev],
  ] as const) {
    await q(
      `insert into webhook_subscriptions (id, user_id, api_key_id, name, url, event_types, secret, active, retry_config)
       values ($1,$2,$3,'s','https://hook.example/x','{${EVENT}}','sec',true,'{"maxRetries":0}'::jsonb)`,
      [id, A, key]
    );
  }
});

beforeEach(() => {
  h.sent = [];
  h.channelReaders = [A];
});

const audience = () => h.sent.map((d) => d.subscriptionId!).sort();
const sorted = (...ids: string[]) => [...ids].sort();

async function entityEvent(entityId: string): Promise<string[]> {
  await deliverWebhooksForEvent(
    EVENT,
    { entityId },
    { kind: "entity", entityId }
  );
  return audience();
}

/** Producer 1: one domain-event fan-out job for the subject. */
async function domainEvent(
  subjectId: string,
  workspaceId: string | null
): Promise<string[]> {
  const sent: Array<{ subscriptionId?: string }> = [];
  await handleWebhookDelivery(
    {
      id: randomUUID(),
      name: "webhook-delivery",
      expireInSeconds: 60,
      data: { eventType: EVENT, subjectId, userId: A, workspaceId, data: {} },
    } as never,
    {
      send: async (_q: string, data: { subscriptionId?: string }) => {
        sent.push(data);
        return "job";
      },
    } as never
  );
  return sent.map((d) => d.subscriptionId!).sort();
}

describe("producer 2 (deliverWebhooksForEvent) — delivery by the key's grant", () => {
  it("a note in WS1 reaches every key that reads WS1 notes, never the revoked key", async () => {
    expect(await entityEvent(NOTE_WS1)).toEqual(
      sorted(SUB.session, SUB.ws1, SUB.person, SUB.note, SUB.all)
    );
  });

  it("a note in WS2 does not reach the keys pinned to WS1", async () => {
    expect(await entityEvent(NOTE_WS2)).toEqual(
      sorted(SUB.session, SUB.note, SUB.all)
    );
  });

  it("a pod-wide person reaches only the keys whose grant reads persons", async () => {
    expect(await entityEvent(PERSON)).toEqual(
      sorted(SUB.session, SUB.person, SUB.all)
    );
  });

  it("a channel event reaches only the keys whose grant reads channels", async () => {
    await deliverWebhooksForEvent(
      EVENT,
      {},
      { kind: "channel", channelId: CH_WS1, trusted: true, actorUserId: A }
    );
    expect(audience()).toEqual(sorted(SUB.session, SUB.all));
  });

  it("a subject-less user event reaches the session row only", async () => {
    await deliverWebhooksForEvent(EVENT, {}, { kind: "user", userId: A });
    expect(audience()).toEqual([SUB.session]);
  });
});

describe("producer 1 (domain-event fan-out) — the same grant rule", () => {
  it("a pod-wide person reaches only the keys whose grant reads persons", async () => {
    expect(await domainEvent(PERSON, null)).toEqual(
      sorted(SUB.session, SUB.person, SUB.all)
    );
  });

  it("a note in WS2 does not reach the keys pinned to WS1, nor the revoked key", async () => {
    expect(await domainEvent(NOTE_WS2, WS2)).toEqual(
      sorted(SUB.session, SUB.note, SUB.all)
    );
  });
});
