/**
 * REAL-POSTGRES (PGlite) test for migration 0426 — needs (founder decisions
 * D2 and D3, 16 Nov 2026):
 *   - the `needs` table is created and seeded idempotently, with the drizzle
 *     schema's columns, and its slug CHECK refuses an intent-shaped slug;
 *   - a space's need binding is an `installation_bindings` row with no
 *     installation: it needs a space, holds at most one live row per (space,
 *     need), a revoked row makes room, and a deleted provider leaves the need
 *     empty (SET NULL), never a dangling id;
 *   - an installation's binding keeps its 0409 shape (installation + intent);
 *   - `intent_defaults` is kept (forward-only: its drop is a later contract
 *     step), the code no longer declares it;
 *   - the baseline carries the same lines; the boot coherence list names it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { needs } from "./schema/needs.js";
import { REQUIRED_COLUMNS } from "./utils/schema-coherence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) =>
  readFileSync(resolve(HERE, "../migrations", f), "utf8");
const M0409 = read("0409_installations.sql");
const M0426 = read("0426_needs.sql");
const BASELINE = read("0000_baseline_schema.sql");

let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE capabilities (id uuid PRIMARY KEY);
    CREATE TABLE api_keys (id uuid PRIMARY KEY);
    CREATE TABLE skills (id uuid PRIMARY KEY);
  `);
  await pg.exec(M0409);
  await pg.exec(M0426);
  await pg.exec(M0426);
}, 60_000);
afterAll(async () => {
  await pg.close();
});

const space = (ws: string | null, need: string, provider: string | null) =>
  pg.query<{ id: string }>(
    `INSERT INTO installation_bindings (user_id, workspace_id, need_key, provider_capability_id, state)
     VALUES ('u', $1, $2, $3, 'live') RETURNING id`,
    [ws, need, provider]
  );

describe("migration 0426 — needs filled once per space", () => {
  it("creates and seeds the needs table idempotently, with the drizzle columns", async () => {
    const cols = await pg.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'needs'`
    );
    expect(cols.rows.map((r) => r.column_name).sort()).toEqual(
      getTableConfig(needs)
        .columns.map((c) => c.name)
        .sort()
    );
    const { rows } = await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM needs`
    );
    expect(rows[0]!.n).toBe(12);
    const code = await pg.query<{ intents: string[]; aliases: string[] }>(
      `SELECT intents, aliases FROM needs WHERE slug = 'code-host'`
    );
    expect(code.rows[0]!.intents).toContain("fetch_record");
    expect(code.rows[0]!.aliases).toContain("git-host");
    // An intent-shaped (snake_case) slug is not a need slug.
    await expect(
      pg.query(
        `INSERT INTO needs (slug, label, description) VALUES ('code_host', 'x', 'y')`
      )
    ).rejects.toThrow(/needs_slug_check/);
  });

  it("a space's binding: one live row per (space, need), a revoked row makes room", async () => {
    const cap = randomUUID();
    await pg.query(`INSERT INTO capabilities VALUES ($1)`, [cap]);
    const ws = randomUUID();
    const first = (await space(ws, "code-host", cap)).rows[0]!.id;
    await expect(space(ws, "code-host", cap)).rejects.toThrow(
      /uq_installation_bindings_space_need/
    );
    // Another need, or another space: its own seat.
    await space(ws, "gate", cap);
    await space(randomUUID(), "code-host", cap);
    await pg.query(
      `UPDATE installation_bindings SET state = 'revoked', revoked_at = now() WHERE id = $1`,
      [first]
    );
    await space(ws, "code-host", cap);
  });

  it("a space's binding needs a space; an installation's binding keeps its intent", async () => {
    await expect(space(null, "payments", null)).rejects.toThrow(
      /installation_bindings_scope_check/
    );
    const inst = await pg.query<{ id: string }>(
      `INSERT INTO installations (user_id, kind, capability_key, machine_user_id)
       VALUES ('u', 'service', 'hyperframes', 'm') RETURNING id`
    );
    await expect(
      pg.query(
        `INSERT INTO installation_bindings (installation_id, user_id, need_key)
         VALUES ($1, 'u', 'studio_url')`,
        [inst.rows[0]!.id]
      )
    ).rejects.toThrow(/installation_bindings_scope_check/);
    // Two live bindings of one installation's need stay allowed (a rebind
    // holds the old one live until the new one is).
    for (let i = 0; i < 2; i++) {
      await pg.query(
        `INSERT INTO installation_bindings (installation_id, user_id, workspace_id, need_key, intent)
         VALUES ($1, 'u', $2, 'studio_url', 'expose_http')`,
        [inst.rows[0]!.id, randomUUID()]
      );
    }
  });

  it("a deleted provider leaves the need empty, never a dangling id", async () => {
    const cap = randomUUID();
    await pg.query(`INSERT INTO capabilities VALUES ($1)`, [cap]);
    const ws = randomUUID();
    await space(ws, "analytics", cap);
    await pg.query(`DELETE FROM capabilities WHERE id = $1`, [cap]);
    const b = await pg.query<{ p: string | null }>(
      `SELECT provider_capability_id AS p FROM installation_bindings WHERE workspace_id = $1`,
      [ws]
    );
    expect(b.rows).toEqual([{ p: null }]);
  });

  it("keeps intent_defaults: its drop is a later contract step (forward-only)", async () => {
    const t = await pg.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'intent_defaults'`
    );
    expect(t.rows).toHaveLength(1);
    expect(M0426).not.toMatch(/DROP TABLE[^;]*intent_defaults/);
  });

  it("the baseline carries the same lines and the boot check names the table", () => {
    const create = M0426.slice(
      M0426.indexOf('CREATE TABLE IF NOT EXISTS "needs" ('),
      M0426.indexOf('ON CONFLICT ("slug") DO NOTHING;')
    );
    expect(create.length).toBeGreaterThan(500);
    expect(BASELINE).toContain(create.trim());
    for (const line of [
      `ALTER TABLE "installation_bindings" ALTER COLUMN "installation_id" DROP NOT NULL;`,
      `ALTER TABLE "installation_bindings" ALTER COLUMN "intent" DROP NOT NULL;`,
      `"installation_bindings_scope_check"`,
      `"uq_installation_bindings_space_need"`,
    ]) {
      expect(M0426).toContain(line);
      expect(BASELINE).toContain(line);
    }
    expect(REQUIRED_COLUMNS.some((c) => c.table === "needs")).toBe(true);
    expect(REQUIRED_COLUMNS.some((c) => c.table === "intent_defaults")).toBe(
      false
    );
  });
});
