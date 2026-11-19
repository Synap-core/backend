/**
 * REAL-POSTGRES (PGlite) test for migration 0436 — renderer bundles:
 *   - it applies twice (idempotent);
 *   - the host modules may be written BEFORE their bundle row inside one
 *     transaction (the FK is checked at commit), and a commit with no bundle
 *     row is refused;
 *   - ONE host-module set per pod: a second slug's `react` is refused;
 *   - deleting a bundle removes its modules;
 *   - the baseline carries the same lines; the boot coherence list names them.
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
const FILE = "0436_renderer_bundles.sql";
const M0436 = read(FILE);
const BASELINE = read("0000_baseline_schema.sql");

const bundle = (slug: string) =>
  `INSERT INTO renderer_bundles (slug, version, set_sha256, react_version, source, installed_by)
   VALUES ('${slug}', '1.0.0', '${"a".repeat(64)}', '19.2.3', 'synap', 'u-1')`;
const mod = (slug: string, name: string) =>
  `INSERT INTO renderer_host_modules (bundle_slug, module, source, sha256, byte_length)
   VALUES ('${slug}', '${name}', 'export {}', '${"b".repeat(64)}', 9)`;

let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(M0436);
  await pg.exec(M0436);
}, 60_000);
afterAll(async () => {
  await pg.close();
});

describe("migration 0436 — renderer bundles", () => {
  it("modules first, bundle row last, in one transaction", async () => {
    await pg.exec(
      `BEGIN; ${mod("synap-renderers", "react")}; ${mod("synap-renderers", "kit")}; ${bundle("synap-renderers")}; COMMIT;`
    );
    const { rows } = await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM renderer_host_modules WHERE bundle_slug = 'synap-renderers'`
    );
    expect(rows[0]!.n).toBe(2);
  });

  it("a commit that leaves modules without their bundle row is refused", async () => {
    await expect(
      pg.exec(`BEGIN; ${mod("orphan", "reactDom")}; COMMIT;`)
    ).rejects.toThrow(/renderer_host_modules_bundle_fk/);
    await pg.exec("ROLLBACK").catch(() => undefined);
    const { rows } = await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM renderer_host_modules WHERE bundle_slug = 'orphan'`
    );
    expect(rows[0]!.n).toBe(0);
  });

  it("a second slug's host set is refused at the database", async () => {
    await expect(
      pg.exec(`BEGIN; ${bundle("other")}; ${mod("other", "react")}; COMMIT;`)
    ).rejects.toThrow(/renderer_host_modules_one_set/);
    await pg.exec("ROLLBACK").catch(() => undefined);
  });

  it("deleting a bundle deletes its modules", async () => {
    await pg.exec(
      `DELETE FROM renderer_bundles WHERE slug = 'synap-renderers'`
    );
    const { rows } = await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM renderer_host_modules`
    );
    expect(rows[0]!.n).toBe(0);
  });

  it("the baseline carries the same lines and the boot check names the tables", () => {
    for (const line of [
      'CREATE TABLE IF NOT EXISTS "renderer_bundles" (',
      'CREATE TABLE IF NOT EXISTS "renderer_host_modules" (',
      "ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;",
      'CREATE UNIQUE INDEX IF NOT EXISTS "renderer_host_modules_one_set"',
    ]) {
      expect(M0436).toContain(line);
      expect(BASELINE).toContain(line);
    }
    for (const table of ["renderer_bundles", "renderer_host_modules"]) {
      expect(REQUIRED_COLUMNS).toContainEqual(
        expect.objectContaining({ table, addedBy: FILE })
      );
    }
  });
});
