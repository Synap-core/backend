/**
 * REAL-POSTGRES (PGlite) test for migration 0372 and the two state machines
 * it backs (pipeline-health W1):
 *  - the migration and the baseline create both tables with EVERY column the
 *    drizzle schema declares, idempotently;
 *  - inbound deliveries: a sender's delivery id is stored ONCE per
 *    subscription (a redelivery returns the first row); a claim is a lease;
 *    an incomplete settle keeps progress and backs off, and the sweeper lists
 *    the row only once the backoff lapses; a complete settle is never claimed
 *    again; retention drops only delivered rows;
 *  - observation keys: one claim per fact, a second copy sees the first
 *    event; a released key is claimable again; a claim with no event older
 *    than the lease is taken over (a writer that died).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  inboundDeliveries,
  observationKeys,
} from "./schema/inbound-deliveries.js";
import {
  recordInboundDelivery,
  claimInboundDelivery,
  settleInboundDelivery,
  listDueInboundDeliveries,
  pruneInboundDeliveries,
} from "./services/inbound-delivery-outbox.js";
import {
  claimObservationKey,
  settleObservationKey,
  releaseObservationKey,
} from "./services/observation-keys.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const M0372 = readFileSync(
  resolve(
    HERE,
    "../migrations/0372_inbound_deliveries_and_observation_keys.sql"
  ),
  "utf8"
);
const BASELINE = readFileSync(
  resolve(HERE, "../migrations/0000_baseline_schema.sql"),
  "utf8"
);

const SUB = "11111111-1111-4111-8111-111111111111";
const SUB2 = "22222222-2222-4222-8222-222222222222";
const EVENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

let pg: PGlite;
let db: any;

beforeAll(async () => {
  pg = new PGlite();
  // The one table 0372 references; its own columns are not under test here.
  await pg.exec(`CREATE TABLE "webhook_subscriptions" ("id" uuid PRIMARY KEY)`);
  await pg.exec(
    `INSERT INTO "webhook_subscriptions" ("id") VALUES ('${SUB}'), ('${SUB2}')`
  );
  await pg.exec(M0372);
  await pg.exec(M0372);
  db = drizzle(pg);
}, 60_000);
afterAll(async () => pg?.close());

async function columnsOf(table: string): Promise<string[]> {
  const r = await pg.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = '${table}'`
  );
  return r.rows.map((x) => x.column_name).sort();
}

describe("migration 0372", () => {
  it("creates every declared column of both tables, idempotently", async () => {
    const inbound = getTableConfig(inboundDeliveries).columns.map(
      (c) => c.name
    );
    const keys = getTableConfig(observationKeys).columns.map((c) => c.name);
    expect(inbound.length).toBeGreaterThanOrEqual(13);
    expect(keys.length).toBe(3);
    expect(await columnsOf("inbound_deliveries")).toEqual([...inbound].sort());
    expect(await columnsOf("observation_keys")).toEqual([...keys].sort());
  });

  it("the baseline carries the same tables and indexes", () => {
    const body = M0372.slice(M0372.indexOf("CREATE TABLE"));
    expect(body.length).toBeGreaterThan(500);
    expect(BASELINE).toContain(body.trim());
  });
});

async function store(deliveryId: string | null, sub = SUB) {
  return recordInboundDelivery(db, {
    subscriptionId: sub,
    userId: "owner-1",
    workspaceId: null,
    deliveryId,
    event: "pull_request",
    payload: { n: 1 },
  });
}

async function lapse(id: string) {
  await pg.exec(
    `UPDATE "inbound_deliveries" SET "claimed_until" = now() - interval '1 second', "received_at" = now() - interval '1 hour' WHERE "id" = '${id}'`
  );
}

describe("inbound delivery outbox", () => {
  it("a redelivered id is stored once per subscription; no id is never deduped", async () => {
    const first = await store("gh-1");
    const again = await store("gh-1");
    expect(first.duplicate).toBe(false);
    expect(again).toEqual({ id: first.id, duplicate: true });

    const otherSub = await store("gh-1", SUB2);
    expect(otherSub.duplicate).toBe(false);
    expect(otherSub.id).not.toBe(first.id);

    const a = await store(null);
    const b = await store(null);
    expect(a.duplicate || b.duplicate).toBe(false);
    expect(a.id).not.toBe(b.id);
  });

  it("claim is a lease; incomplete backs off and keeps progress; complete is final", async () => {
    const { id } = await store("gh-lease");
    const held = await claimInboundDelivery(db, id);
    expect(held?.attempts).toBe(1);
    expect(await claimInboundDelivery(db, id)).toBeNull(); // leased

    await settleInboundDelivery(db, id, {
      delivered: ["webhook-delivery"],
      complete: false,
      error: "automation-trigger-match",
    });
    // Backing off: not due, not claimable.
    await pg.exec(
      `UPDATE "inbound_deliveries" SET "received_at" = now() - interval '1 hour' WHERE "id" = '${id}'`
    );
    expect(await listDueInboundDeliveries(db)).not.toContain(id);

    await lapse(id);
    expect(await listDueInboundDeliveries(db)).toContain(id);
    const retry = await claimInboundDelivery(db, id);
    expect(retry?.delivered).toEqual(["webhook-delivery"]);
    expect(retry?.lastError).toBe("automation-trigger-match");
    expect(retry?.attempts).toBe(2);

    await settleInboundDelivery(db, id, {
      delivered: ["webhook-delivery", "automation-trigger-match"],
      complete: true,
    });
    await lapse(id);
    expect(await listDueInboundDeliveries(db)).not.toContain(id);
    expect(await claimInboundDelivery(db, id)).toBeNull();
  });

  it("the sweeper leaves a fresh row to the door's inline attempt", async () => {
    const { id } = await store("gh-fresh");
    expect(await listDueInboundDeliveries(db)).not.toContain(id);
  });

  it("retention drops old delivered rows, never an owed one", async () => {
    const done = await store("gh-old-done");
    const owed = await store("gh-old-owed");
    await settleInboundDelivery(db, done.id, { delivered: [], complete: true });
    await pg.exec(
      `UPDATE "inbound_deliveries" SET "dispatched_at" = now() - interval '30 days', "received_at" = now() - interval '30 days' WHERE "id" = '${done.id}'`
    );
    await pg.exec(
      `UPDATE "inbound_deliveries" SET "received_at" = now() - interval '30 days' WHERE "id" = '${owed.id}'`
    );
    expect(await pruneInboundDeliveries(db)).toBe(1);
    const left = await pg.query<{ id: string }>(
      `SELECT "id" FROM "inbound_deliveries" WHERE "id" IN ('${done.id}', '${owed.id}')`
    );
    expect(left.rows.map((r) => r.id)).toEqual([owed.id]);
  });
});

describe("observation keys", () => {
  it("one claim per fact; a second copy sees the first event", async () => {
    expect(await claimObservationKey(db, "dev.pr_merged:a/b#1")).toEqual({
      owned: true,
    });
    // In flight: the second copy is told so, not handed ownership.
    expect(await claimObservationKey(db, "dev.pr_merged:a/b#1")).toEqual({
      owned: false,
      eventId: null,
    });
    await settleObservationKey(db, "dev.pr_merged:a/b#1", EVENT_A);
    expect(await claimObservationKey(db, "dev.pr_merged:a/b#1")).toEqual({
      owned: false,
      eventId: EVENT_A,
    });
  });

  it("a released key (a failed write) is claimable again", async () => {
    expect((await claimObservationKey(db, "k-release")).owned).toBe(true);
    await releaseObservationKey(db, "k-release");
    expect((await claimObservationKey(db, "k-release")).owned).toBe(true);
  });

  it("release never drops a key whose fact is recorded", async () => {
    await claimObservationKey(db, "k-kept");
    await settleObservationKey(db, "k-kept", EVENT_A);
    await releaseObservationKey(db, "k-kept");
    expect(await claimObservationKey(db, "k-kept")).toEqual({
      owned: false,
      eventId: EVENT_A,
    });
  });

  it("an abandoned claim (no event past the lease) is taken over; a recorded one never is", async () => {
    await claimObservationKey(db, "k-dead");
    await claimObservationKey(db, "k-done");
    await settleObservationKey(db, "k-done", EVENT_A);
    await pg.exec(
      `UPDATE "observation_keys" SET "claimed_at" = now() - interval '1 hour' WHERE "key" IN ('k-dead', 'k-done')`
    );
    expect(await claimObservationKey(db, "k-dead")).toEqual({ owned: true });
    expect(await claimObservationKey(db, "k-done")).toEqual({
      owned: false,
      eventId: EVENT_A,
    });
  });
});
