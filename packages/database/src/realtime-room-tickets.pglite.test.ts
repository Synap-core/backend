/**
 * REAL-POSTGRES (PGlite) test for migration 0433 and the room ticket store
 * (`utils/realtime-room-tickets.ts`), the rows behind how a pod app opens a
 * live Yjs room:
 *   - 0433 creates `realtime_room_tickets` with the drizzle schema's columns,
 *     refuses an access other than read | edit, and runs twice (idempotent);
 *     the baseline carries the table and the boot coherence list names it;
 *   - a ticket is stored as its sha256 only;
 *   - a claim admits ONE document ONCE before it expires: a replay, another
 *     document, an expired ticket and a forged one are refused, and a
 *     refused claim on another document leaves the ticket claimable;
 *   - peek consumes nothing;
 *   - a connection stands while its key is live, or while another live
 *     `app_person` key holds the same slot (a pod app's hourly rotation), and
 *     only while its person still holds access to the pod.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "./schema/index.js";
import { realtimeRoomTickets } from "./schema/realtime-room-tickets.js";
import { REQUIRED_COLUMNS } from "./utils/schema-coherence.js";
import {
  ROOM_TICKET_TTL_MS,
  claimRoomTicket,
  hashRoomTicket,
  isRoomTicket,
  liveTicketConnections,
  mintRoomTicket,
  peekRoomTicket,
} from "./utils/realtime-room-tickets.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) =>
  readFileSync(resolve(HERE, "../migrations", f), "utf8");
const M0433 = read("0433_realtime_room_tickets.sql");
const BASELINE = read("0000_baseline_schema.sql");

const DOC = randomUUID();
const OTHER_DOC = randomUUID();
const KEY = randomUUID();

let pg: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;
beforeAll(async () => {
  pg = new PGlite();
  // Only the api_keys columns the liveness read selects.
  await pg.exec(`
    CREATE TABLE api_keys (
      id uuid PRIMARY KEY,
      user_id text NOT NULL,
      key_type text NOT NULL,
      instance_id text,
      is_active boolean NOT NULL DEFAULT true,
      revoked_at timestamptz,
      expires_at timestamptz
    );
  `);
  await pg.exec(M0433);
  await pg.exec(M0433);
  db = drizzle(pg, { schema });
}, 60_000);
afterAll(async () => {
  await pg.close();
});

describe("0433 realtime_room_tickets", () => {
  it("has exactly the drizzle schema's columns", async () => {
    const { rows } = await pg.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'realtime_room_tickets'`
    );
    const sqlCols = rows.map((r) => r.column_name).sort();
    const drizzleCols = getTableConfig(realtimeRoomTickets)
      .columns.map((c) => c.name)
      .sort();
    expect(sqlCols).toEqual(drizzleCols);
  });

  it("refuses an access other than read or edit", async () => {
    await expect(
      pg.query(
        `INSERT INTO realtime_room_tickets
           (ticket_hash, user_id, document_id, access, api_key_id, expires_at)
         VALUES ('h-bad', 'u', $1, 'admin', $2, now())`,
        [DOC, KEY]
      )
    ).rejects.toThrow(/realtime_room_tickets_access_check/);
  });

  it("is in the baseline and the boot coherence list", () => {
    expect(BASELINE).toContain(
      'CREATE TABLE IF NOT EXISTS "realtime_room_tickets"'
    );
    expect(
      REQUIRED_COLUMNS.filter((c) => c.table === "realtime_room_tickets")
        .length
    ).toBeGreaterThan(0);
  });
});

describe("the room ticket store", () => {
  const mint = (over: Partial<Parameters<typeof mintRoomTicket>[1]> = {}) =>
    mintRoomTicket(db, {
      userId: "person-1",
      documentId: DOC,
      access: "edit",
      apiKeyId: KEY,
      ...over,
    });

  it("stores only the sha256 of the ticket", async () => {
    const { ticket } = await mint();
    expect(isRoomTicket(ticket)).toBe(true);
    const { rows } = await pg.query<{ ticket_hash: string }>(
      `SELECT ticket_hash FROM realtime_room_tickets WHERE ticket_hash = $1`,
      [hashRoomTicket(ticket)]
    );
    expect(rows).toHaveLength(1);
    const { rows: plain } = await pg.query(
      `SELECT 1 FROM realtime_room_tickets WHERE ticket_hash = $1`,
      [ticket]
    );
    expect(plain).toHaveLength(0);
  });

  it("claims ONE document ONCE", async () => {
    const { ticket } = await mint({ access: "read" });
    // Another document: refused, and the ticket is still claimable.
    await expect(claimRoomTicket(db, ticket, OTHER_DOC)).resolves.toBeNull();
    await expect(claimRoomTicket(db, ticket, DOC)).resolves.toEqual({
      userId: "person-1",
      access: "read",
      apiKeyId: KEY,
    });
    // Reused.
    await expect(claimRoomTicket(db, ticket, DOC)).resolves.toBeNull();
    await expect(peekRoomTicket(db, ticket)).resolves.toBeNull();
  });

  it("refuses an expired ticket", async () => {
    const madeAt = new Date(Date.now() - ROOM_TICKET_TTL_MS - 1_000);
    const { ticket, expiresAt } = await mint({ now: madeAt });
    expect(expiresAt.getTime() - madeAt.getTime()).toBe(ROOM_TICKET_TTL_MS);
    await expect(peekRoomTicket(db, ticket)).resolves.toBeNull();
    await expect(claimRoomTicket(db, ticket, DOC)).resolves.toBeNull();
  });

  it("refuses a forged or malformed ticket", async () => {
    await expect(
      claimRoomTicket(db, `synap_rt_${"x".repeat(43)}`, DOC)
    ).resolves.toBeNull();
    await expect(claimRoomTicket(db, "synap_rt_", DOC)).resolves.toBeNull();
    await expect(peekRoomTicket(db, "tok-kratos")).resolves.toBeNull();
  });

  it("peek names the person and consumes nothing", async () => {
    const { ticket } = await mint();
    await expect(peekRoomTicket(db, ticket)).resolves.toEqual({
      userId: "person-1",
      documentId: DOC,
      access: "edit",
    });
    await expect(claimRoomTicket(db, ticket, DOC)).resolves.not.toBeNull();
  });

  it("making a ticket clears the expired ones", async () => {
    const old = await mint({ now: new Date(Date.now() - 3_600_000) });
    await mint();
    const { rows } = await pg.query(
      `SELECT 1 FROM realtime_room_tickets WHERE ticket_hash = $1`,
      [hashRoomTicket(old.ticket)]
    );
    expect(rows).toHaveLength(0);
  });
});

describe("which connections still stand", () => {
  const key = async (over: {
    userId?: string;
    keyType?: string;
    instanceId?: string | null;
    isActive?: boolean;
    expiresAt?: Date | null;
  }) => {
    const id = randomUUID();
    await pg.query(
      `INSERT INTO api_keys (id, user_id, key_type, instance_id, is_active, expires_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        over.userId ?? "person-1",
        over.keyType ?? "app_person",
        over.instanceId ?? null,
        over.isActive ?? true,
        over.expiresAt ?? null,
        over.isActive === false ? new Date() : null,
      ]
    );
    return id;
  };
  const everyone = async () => true;
  const hour = () => new Date(Date.now() + 3_600_000);

  it("a live key stands; a revoked or expired one does not", async () => {
    const liveKey = await key({ expiresAt: hour() });
    const revoked = await key({ isActive: false });
    const expired = await key({ expiresAt: new Date(Date.now() - 1_000) });
    const live = await liveTicketConnections(db, [liveKey, revoked, expired], {
      holdsAccess: everyone,
    });
    expect([...live]).toEqual([liveKey]);
  });

  it("a pod app's rotated key stands while its slot has a live successor", async () => {
    const slot = `oauth:https://app.example/client:${randomUUID()}`;
    const rotated = await key({ instanceId: slot, isActive: false });
    await key({ instanceId: slot, expiresAt: hour() });
    const otherSlot = await key({
      instanceId: `oauth:https://app.example/client:${randomUUID()}`,
      isActive: false,
    });
    // The same slot name held by ANOTHER person is not this connection.
    const strangerSlot = `oauth:https://app.example/client:${randomUUID()}`;
    const mine = await key({ instanceId: strangerSlot, isActive: false });
    await key({
      userId: "person-2",
      instanceId: strangerSlot,
      expiresAt: hour(),
    });
    const live = await liveTicketConnections(db, [rotated, otherSlot, mine], {
      holdsAccess: everyone,
    });
    expect([...live]).toEqual([rotated]);
  });

  it("a revoked key of another type is not saved by a live sibling", async () => {
    const slot = `slot-${randomUUID()}`;
    const revoked = await key({
      keyType: "user_pat",
      instanceId: slot,
      isActive: false,
    });
    await key({ keyType: "user_pat", instanceId: slot, expiresAt: hour() });
    const live = await liveTicketConnections(db, [revoked], {
      holdsAccess: everyone,
    });
    expect(live.size).toBe(0);
  });

  it("a person who lost access to the pod loses every connection", async () => {
    const gone = await key({ userId: "person-gone", expiresAt: hour() });
    const live = await liveTicketConnections(db, [gone], {
      holdsAccess: async (u) => u !== "person-gone",
    });
    expect(live.size).toBe(0);
  });
});
