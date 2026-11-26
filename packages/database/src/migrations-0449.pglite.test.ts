/**
 * REAL-POSTGRES (PGlite) test for migration 0449 — renderer bundle updates
 * (plan ad703ccd L2):
 *   - it applies twice on top of 0436 (idempotent), and the baseline (0436
 *     and 0449 lines together) applies on top of both;
 *   - a bundle installed before 0449 keeps its row, with no digest yet;
 *   - one kept definition per (slug, version), and an update state row per
 *     slug that exists with no bundle installed;
 *   - the baseline carries the same lines; the boot coherence list names
 *     each new column.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { REQUIRED_COLUMNS } from "./utils/schema-coherence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) =>
  readFileSync(resolve(HERE, "../migrations", f), "utf8");
const FILE = "0449_renderer_bundle_updates.sql";
const M0436 = read("0436_renderer_bundles.sql");
const M0449 = read(FILE);
const BASELINE = read("0000_baseline_schema.sql");

let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(M0436);
  // A bundle installed before 0449.
  await pg.exec(
    `INSERT INTO renderer_bundles (slug, version, set_sha256, react_version, source, installed_by)
     VALUES ('synap-renderers', 'h-0123456789ab', '${"a".repeat(64)}', '19.2.3', 'synap', 'u-1')`
  );
  await pg.exec(M0449);
  await pg.exec(M0449);
}, 60_000);
afterAll(async () => {
  await pg.close();
});

describe("migration 0449 — renderer bundle updates", () => {
  it("keeps a bundle installed before it, with no digest yet", async () => {
    const { rows } = await pg.query<{ version: string; content_hash: null }>(
      `SELECT version, content_hash FROM renderer_bundles`
    );
    expect(rows).toEqual([{ version: "h-0123456789ab", content_hash: null }]);
  });

  it("one kept definition per slug and version", async () => {
    const insert = `INSERT INTO renderer_bundle_versions (slug, version, content_hash, definition)
      VALUES ('synap-renderers', 'h-1', '${"c".repeat(64)}', '{}'::jsonb)`;
    await pg.exec(insert);
    await expect(pg.exec(insert)).rejects.toThrow(/duplicate key/);
  });

  it("an update state row exists with no bundle installed", async () => {
    await pg.exec(
      `INSERT INTO renderer_bundle_updates (slug, refusal_code, refused_at)
       VALUES ('not-installed', 'renderer_bundle_plan_required', now())`
    );
    const { rows } = await pg.query<{ installed_retired: boolean }>(
      `SELECT installed_retired FROM renderer_bundle_updates WHERE slug = 'not-installed'`
    );
    expect(rows).toEqual([{ installed_retired: false }]);
  });

  it("the baseline carries the same lines and the boot check names the columns", async () => {
    for (const line of [
      'ALTER TABLE "renderer_bundles" ADD COLUMN IF NOT EXISTS "content_hash" text;',
      'CREATE TABLE IF NOT EXISTS "renderer_bundle_versions" (',
      'CREATE TABLE IF NOT EXISTS "renderer_bundle_updates" (',
      '"apply_after"         timestamptz,',
    ]) {
      expect(M0449).toContain(line);
      expect(BASELINE).toContain(line);
    }
    for (const [table, column] of [
      ["renderer_bundles", "content_hash"],
      ["renderer_bundle_versions", "definition"],
      ["renderer_bundle_updates", "apply_after"],
    ]) {
      expect(REQUIRED_COLUMNS).toContainEqual({ table, column, addedBy: FILE });
    }
    // The baseline's renderer section applies over a migrated database.
    const from = BASELINE.indexOf("-- Renderer bundles (0436)");
    const to = BASELINE.indexOf("-- Account recovery codes (0294)");
    expect(from).toBeGreaterThan(0);
    await pg.exec(BASELINE.slice(from, to));
  });
});
