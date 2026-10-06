/**
 * REAL-POSTGRES (PGlite) test for migration 0309 — the `apps` table (App
 * Connect v1). Proves the hand-written SQL applies, is idempotent, and lands
 * the columns + the (owner, name) idempotency key the register door relies on.
 * The repository/routes are exercised in api
 * `routers/hub-protocol/rest/__tests__/apps.test.ts` — never replayed as
 * copied SQL here.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const HERE = dirname(fileURLToPath(import.meta.url));
const M0309 = readFileSync(
  resolve(HERE, "../migrations/0309_apps.sql"),
  "utf8"
);

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
}, 120_000);

describe("migration 0309 — apps", () => {
  it("creates the table with the spec columns and is idempotent", async () => {
    await pg.exec(M0309);
    await pg.exec(M0309); // idempotent — IF NOT EXISTS throughout

    const cols = await pg.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'apps' ORDER BY column_name`
    );
    const names = cols.rows.map((r) => r.column_name);
    for (const c of [
      "id",
      "owner_user_id",
      "public_id",
      "name",
      "description",
      "logo_url",
      "mode",
      "approved_requests",
      "metadata",
      "last_used_at",
      "created_at",
      "revoked_at",
    ]) {
      expect(names).toContain(c);
    }
  });

  it("enforces ONE app per (owner, name) and a unique public_id", async () => {
    await pg.exec(M0309);
    await pg.exec(
      `INSERT INTO apps (owner_user_id, public_id, name)
         VALUES ('u1', 'app_a', 'Acme');`
    );
    // Same owner + same name → rejected by the idempotency key.
    await expect(
      pg.exec(
        `INSERT INTO apps (owner_user_id, public_id, name)
           VALUES ('u1', 'app_b', 'Acme');`
      )
    ).rejects.toThrow();
    // Same public_id, different owner → rejected by the UNIQUE on public_id.
    await expect(
      pg.exec(
        `INSERT INTO apps (owner_user_id, public_id, name)
           VALUES ('u2', 'app_a', 'Other');`
      )
    ).rejects.toThrow();
  });

  it("defaults mode to 'specific' and metadata to '{}'", async () => {
    await pg.exec(M0309);
    await pg.exec(
      `INSERT INTO apps (owner_user_id, public_id, name) VALUES ('u3', 'app_c', 'C');`
    );
    const row = await pg.query<{ mode: string; metadata: unknown }>(
      `SELECT mode, metadata FROM apps WHERE public_id = 'app_c'`
    );
    expect(row.rows[0].mode).toBe("specific");
    expect(row.rows[0].metadata).toEqual({});
  });
});
