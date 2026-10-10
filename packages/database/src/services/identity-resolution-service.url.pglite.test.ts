/**
 * URL identity atom, end to end on a real Postgres (PGlite): the REAL
 * extractor → the REAL write door (`registerIdentitySignals`) → the REAL
 * resolver (`resolveIdentity`). Nothing hand-normalised in between.
 *
 * Pinned (D8):
 *  - two captures of `https://www.x.com/a?utm_source=y#z` and `https://x.com/a`
 *    resolve to the SAME bookmark;
 *  - a person carrying a `url` property registers no identity, so a bookmark
 *    of that URL does not resolve onto the person;
 *  - a `linkedin_url` stored in the pre-canonical form (with `www.`) still
 *    resolves (read-compat — rows are never rewritten).
 *
 * ENGINE: PGlite, tables built from their drizzle definitions (enums as text,
 * constraints dropped; the (type, value) unique key added back — the write
 * door's onConflictDoNothing depends on it).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "../schema/index.js";
import { entities, entityIdentitySignals } from "../schema/index.js";
import {
  extractIdentitySignals,
  registerIdentitySignals,
  resolveIdentity,
} from "./identity-resolution-service.js";

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

const USER = "url-identity-user";
let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;

beforeAll(async () => {
  pg = new PGlite();
  for (const t of [entities, entityIdentitySignals]) {
    await pg.exec(ddlFor(t as unknown as PgTable));
  }
  await pg.exec(
    `CREATE UNIQUE INDEX entity_identity_signals_type_value_idx
       ON entity_identity_signals (signal_type, signal_value);`
  );
  db = drizzle(pg, { schema });
}, 120_000);

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  await pg.exec(`delete from entity_identity_signals; delete from entities;`);
});

async function insertEntity(type: string, title: string): Promise<string> {
  const id = randomUUID();
  await pg.query(
    `insert into entities (id, user_id, type, title, properties)
       values ($1, $2, $3, $4, '{}'::jsonb)`,
    [id, USER, type, title]
  );
  return id;
}

/** One capture: the write door registers what the extractor yields. */
async function captureAs(
  kind: string,
  title: string,
  properties: Record<string, unknown>
): Promise<string> {
  const id = await insertEntity(kind, title);
  await registerIdentitySignals(
    db,
    id,
    extractIdentitySignals(properties, { kind }),
    "test"
  );
  return id;
}

function lookup(kind: string, properties: Record<string, unknown>) {
  return resolveIdentity(db, {
    userId: USER,
    kindSlug: kind,
    signals: extractIdentitySignals(properties, { kind }),
  });
}

describe("url identity atom — resolution on a real Postgres", () => {
  it("the same URL captured twice (www/utm/fragment vs bare) resolves to the first bookmark", async () => {
    const first = await captureAs("bookmark", "X", {
      url: "https://www.x.com/a?utm_source=y#z",
    });
    const second = await lookup("bookmark", { url: "https://x.com/a" });
    expect(second.match).toBe("strong");
    expect(second.entity?.id).toBe(first);
  });

  it("a child of the bookmark family (article) resolves onto the same subject", async () => {
    const first = await captureAs("article", "A", {
      url: "https://blog.x.com/post/",
    });
    const res = await lookup("article", {
      url: "https://blog.x.com/post?fbclid=abc",
    });
    expect(res.entity?.id).toBe(first);
  });

  it("different YouTube videos stay different subjects (v= is identity)", async () => {
    await captureAs("bookmark", "V1", {
      url: "https://www.youtube.com/watch?v=AAA",
    });
    const res = await lookup("bookmark", {
      url: "https://www.youtube.com/watch?v=BBB",
    });
    expect(res.match).toBeNull();
  });

  it("a person's url property is not identity: a bookmark of it does not resolve onto the person", async () => {
    await captureAs("person", "Pat", { url: "https://x.com/a" });
    const rows = await pg.query(`select * from entity_identity_signals`);
    expect(rows.rows).toHaveLength(0);
    const res = await lookup("bookmark", { url: "https://x.com/a" });
    expect(res.match).toBeNull();
  });

  it("a linkedin_url stored in the pre-canonical form still resolves", async () => {
    const id = await insertEntity("person", "Bob");
    await pg.query(
      `insert into entity_identity_signals (entity_id, signal_type, signal_value, source)
         values ($1, 'linkedin_url', 'https://www.linkedin.com/in/bob', 'legacy')`,
      [id]
    );
    const res = await lookup("person", {
      linkedinUrl: "https://www.linkedin.com/in/Bob/",
    });
    expect(res.match).toBe("strong");
    expect(res.entity?.id).toBe(id);
  });
});
