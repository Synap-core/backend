/**
 * The external-link lookup resolves a shared external record only onto the
 * caller's own copy — on a real Postgres, so the SQL predicate itself is tested.
 *
 * A Google Calendar event carries one id on every attendee's calendar. Links are
 * unique per (provider, external_id, nango_connection_id), so each member's
 * connection holds its own row for the record. A second member's sync must
 * never resolve onto the first member's entity (and then refresh its times
 * from the second member's copy).
 *
 * ENGINE: PGlite; `entities`, `entity_external_links`, `entity_identity_signals`
 * and `secrets` are created FROM THEIR DRIZZLE DEFINITIONS (enums mapped to
 * text, constraints dropped — the unique key is added back by hand, matching
 * migration 0261).
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  entities,
  entityExternalLinks,
  entityIdentitySignals,
  secrets,
} from "@synap/database/schema";
import { makeExternalLinkIdempotency } from "./entity-link-idempotency.js";

/** CREATE TABLE from the drizzle definition — columns, types and literal defaults. */
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const columns = cfg.columns.map((c) => {
    let type = c.getSQLType();
    if (/vector/.test(type) || c.columnType === "PgEnumColumn") type = "text";
    let def = "";
    const d = c.default as unknown;
    if (d !== undefined && !(d instanceof SQL)) {
      if (typeof d === "string") def = ` default '${d.replace(/'/g, "''")}'`;
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
      else if (type.endsWith("[]")) def = ` default '{}'`;
      else def = ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
    } else if (type.startsWith("timestamp") && c.hasDefault) {
      def = " default now()";
    } else if (c.primary && type === "uuid") {
      def = " default gen_random_uuid()";
    }
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${columns.join(", ")});`;
}

async function freshDb() {
  const client = new PGlite();
  for (const table of [
    entities,
    entityExternalLinks,
    entityIdentitySignals,
    secrets,
  ]) {
    await client.exec(ddlFor(table as unknown as PgTable));
  }
  await client.exec(
    `create unique index on entity_external_links (provider, external_id, nango_connection_id);`
  );
  return { client, db: drizzle(client) };
}

async function seedEntity(client: PGlite, userId: string): Promise<string> {
  const id = randomUUID();
  await client.query(
    `insert into entities (id, user_id, type, title) values ($1, $2, 'event', 'Acme sync')`,
    [id, userId]
  );
  return id;
}

async function seedLink(
  client: PGlite,
  entityId: string,
  connectionId: string
) {
  await client.query(
    `insert into entity_external_links (entity_id, provider, external_id, nango_connection_id)
     values ($1, 'google', 'ev1', $2)`,
    [entityId, connectionId]
  );
}

async function seedConnection(client: PGlite, userId: string): Promise<string> {
  const id = randomUUID();
  await client.query(`insert into secrets (id, user_id) values ($1, $2)`, [
    id,
    userId,
  ]);
  return id;
}

function doorFor(db: unknown, userId: string) {
  return makeExternalLinkIdempotency(db as never, {
    namespace: "connection-sync",
    provider: "google",
    userId,
  });
}

describe("external-link lookup — a shared event id resolves only onto the caller's copy", () => {
  it("member M2's lookup of member M1's event id misses; M1's own lookup hits", async () => {
    const { client, db } = await freshDb();
    const m1Conn = await seedConnection(client, "M1");
    await seedConnection(client, "M2");
    const m1Event = await seedEntity(client, "M1");
    await seedLink(client, m1Event, m1Conn);

    expect(await doorFor(db, "M2").lookup("google", "ev1")).toBeNull();
    expect(await doorFor(db, "M1").lookup("google", "ev1")).toBe(m1Event);
  });

  it("a link one of the caller's connections produced resolves when someone else approved (owns) the entity", async () => {
    const { client, db } = await freshDb();
    const m1Conn = await seedConnection(client, "M1");
    const approved = await seedEntity(client, "approver");
    await seedLink(client, approved, m1Conn);

    expect(await doorFor(db, "M1").lookup("google", "ev1")).toBe(approved);
    expect(await doorFor(db, "M2").lookup("google", "ev1")).toBeNull();
  });

  it("with both a sentinel link and the caller's connection link, the connection's row wins", async () => {
    const { client, db } = await freshDb();
    const m1Conn = await seedConnection(client, "M1");
    const imported = await seedEntity(client, "M1");
    const mirrored = await seedEntity(client, "M1");
    await seedLink(client, imported, "direct-import");
    await seedLink(client, mirrored, m1Conn);

    expect(await doorFor(db, "M1").lookup("google", "ev1")).toBe(mirrored);
  });

  it("M2 registering its own copy gets its own link row and never re-points M1's", async () => {
    const { client, db } = await freshDb();
    const m1Conn = await seedConnection(client, "M1");
    const m2Conn = await seedConnection(client, "M2");
    const m1Event = await seedEntity(client, "M1");
    const m2Event = await seedEntity(client, "M2");
    await seedLink(client, m1Event, m1Conn);

    await doorFor(db, "M2").register(m2Event, "google", "ev1", {
      connectionId: m2Conn,
    });

    const { rows } = await client.query<{
      entity_id: string;
      nango_connection_id: string;
    }>(
      `select entity_id, nango_connection_id from entity_external_links
       where provider = 'google' and external_id = 'ev1' order by nango_connection_id = $1 desc`,
      [m1Conn]
    );
    expect(rows).toEqual([
      { entity_id: m1Event, nango_connection_id: m1Conn },
      { entity_id: m2Event, nango_connection_id: m2Conn },
    ]);
    expect(await doorFor(db, "M2").lookup("google", "ev1")).toBe(m2Event);
    expect(await doorFor(db, "M1").lookup("google", "ev1")).toBe(m1Event);
  });
});
