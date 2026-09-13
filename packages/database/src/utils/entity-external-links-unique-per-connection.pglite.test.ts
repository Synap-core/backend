/**
 * REAL-POSTGRES (PGlite) test for migration 0261: one external link per
 * external record PER CONNECTION.
 *
 * Starts from the PRE-0261 shape (the old UNIQUE (provider, external_id) key and
 * a nullable connection column, as an older pod's defensive ADD COLUMN left it),
 * applies the real migration file twice inside a transaction (the runner's
 * `sql.begin`), then drives the writes the sync door relies on:
 *   - two members' connections link the SAME shared record → both rows insert;
 *   - the same connection linking it twice → unique violation;
 *   - `ON CONFLICT (provider, external_id, nango_connection_id)` — the target
 *     writers must use — is accepted and de-duplicates;
 *   - a pre-existing NULL connection id is backfilled to the `direct-import`
 *     sentinel and the column is NOT NULL afterwards;
 *   - the boot check `findMissingIndexes` reports the new key missing before the
 *     migration and nothing after.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { PGlite } from "@electric-sql/pglite";
import { findMissingIndexes } from "./schema-coherence.js";

const MIGRATION = readFileSync(
  join(
    __dirname,
    "../../migrations/0261_entity_external_links_unique_per_connection.sql"
  ),
  "utf8"
);

let pg: PGlite;

/** postgres.js `sql\`…\`` shape over PGlite: interpolations become $n params. */
function queryOver(db: PGlite) {
  return async <T>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T> => {
    const text = strings.reduce(
      (acc, s, i) => acc + s + (i < values.length ? `$${i + 1}` : ""),
      ""
    );
    return (await db.query(text, values)).rows as T;
  };
}

async function link(provider: string, externalId: string, conn: string | null) {
  await pg.query(
    `INSERT INTO entity_external_links (provider, external_id, nango_connection_id)
     VALUES ($1, $2, $3)`,
    [provider, externalId, conn]
  );
}

beforeAll(async () => {
  pg = new PGlite();
  // PRE-0261 shape: old 2-column unique key, connection column still nullable,
  // plus every other index the drizzle schema declares.
  await pg.exec(`
    CREATE TABLE entity_external_links (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_id uuid,
      provider text NOT NULL,
      external_id text NOT NULL,
      nango_connection_id text,
      status text NOT NULL DEFAULT 'active',
      sync_hash text,
      url text,
      last_synced_at timestamptz NOT NULL DEFAULT now(),
      disconnected_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX entity_external_links_provider_external_id_idx
      ON entity_external_links (provider, external_id);
    CREATE INDEX entity_external_links_entity_id_idx ON entity_external_links (entity_id);
    CREATE INDEX entity_external_links_provider_idx ON entity_external_links (provider);
    CREATE INDEX entity_external_links_nango_connection_id_idx ON entity_external_links (nango_connection_id);
    CREATE INDEX entity_external_links_status_idx ON entity_external_links (status);
  `);
  // A legacy row with no connection id at all.
  await link("github", "legacy-1", null);
}, 120_000);

afterAll(async () => {
  await pg?.close();
});

describe("0261 — entity_external_links unique per connection", () => {
  it("before the migration, the boot check reports the per-connection key missing", async () => {
    await expect(findMissingIndexes(queryOver(pg))).resolves.toEqual([
      {
        table: "entity_external_links",
        missing: ["entity_external_links_provider_external_id_connection_idx"],
      },
    ]);
  });

  it("applies idempotently inside a transaction (runner semantics)", async () => {
    await pg.transaction(async (tx) => {
      await tx.exec(MIGRATION);
    });
    await pg.transaction(async (tx) => {
      await tx.exec(MIGRATION);
    });
    await expect(findMissingIndexes(queryOver(pg))).resolves.toEqual([]);
  });

  it("backfills a NULL connection id to the direct-import sentinel and pins NOT NULL", async () => {
    const row = await pg.query<{ c: string }>(
      `SELECT nango_connection_id AS c FROM entity_external_links WHERE external_id = 'legacy-1'`
    );
    expect(row.rows[0]?.c).toBe("direct-import");
    await expect(link("github", "legacy-2", null)).rejects.toThrow(
      /null value/i
    );
  });

  it("two members' connections can each link the SAME shared record", async () => {
    await link("google", "evt-shared", "conn-alice");
    await link("google", "evt-shared", "conn-bob");
    const n = await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM entity_external_links WHERE external_id = 'evt-shared'`
    );
    expect(n.rows[0]?.n).toBe(2);
  });

  it("the same connection linking the same record twice is a unique violation", async () => {
    await expect(link("google", "evt-shared", "conn-alice")).rejects.toThrow(
      /duplicate key/i
    );
  });

  it("the writers' conflict target (provider, external_id, nango_connection_id) is accepted and de-duplicates", async () => {
    await pg.query(
      `INSERT INTO entity_external_links (provider, external_id, nango_connection_id, url)
       VALUES ('google', 'evt-shared', 'conn-alice', 'https://calendar.google.com/x')
       ON CONFLICT (provider, external_id, nango_connection_id)
       DO UPDATE SET url = EXCLUDED.url`
    );
    const rows = await pg.query<{ url: string | null }>(
      `SELECT url FROM entity_external_links
        WHERE external_id = 'evt-shared' AND nango_connection_id = 'conn-alice'`
    );
    expect(rows.rows).toEqual([{ url: "https://calendar.google.com/x" }]);
  });

  it("the OLD conflict target (provider, external_id) no longer matches any unique index", async () => {
    await expect(
      pg.query(
        `INSERT INTO entity_external_links (provider, external_id, nango_connection_id)
         VALUES ('google', 'evt-other', 'conn-alice')
         ON CONFLICT (provider, external_id) DO NOTHING`
      )
    ).rejects.toThrow(/no unique or exclusion constraint/i);
  });
});
