/**
 * REAL-POSTGRES (PGlite) test for migration 0415: hosted verb runs queue
 * beside an installation's check. After 0409 + 0415, an installation holds at
 * most ONE open LIFECYCLE job (install, update, remove, verify, provider op)
 * and any number of open `verb` runs; the old index is gone; re-running is a
 * no-op; the baseline carries the same index.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) =>
  readFileSync(resolve(HERE, "../migrations", f), "utf8");
const M0409 = read("0409_installations.sql");
const M0415 = read("0415_host_jobs_verb_runs.sql");
const BASELINE = read("0000_baseline_schema.sql");

const STUBS = `
  CREATE TABLE capabilities (id uuid PRIMARY KEY);
  CREATE TABLE api_keys (id uuid PRIMARY KEY);
  CREATE TABLE skills (id uuid PRIMARY KEY);
`;

async function migrated(): Promise<{ pg: PGlite; inst: string }> {
  const pg = new PGlite();
  await pg.exec(STUBS);
  await pg.exec(M0409);
  await pg.exec(M0415);
  await pg.exec(M0415);
  const r = await pg.query<{ id: string }>(
    `INSERT INTO installations (user_id, kind, capability_key, machine_user_id)
     VALUES ('u', 'tool', 'media-ffmpeg', 'm') RETURNING id`
  );
  return { pg, inst: r.rows[0]!.id };
}

const queue = (pg: PGlite, inst: string, kind: string, status = "queued") =>
  pg.query(
    `INSERT INTO host_jobs (kind, installation_id, user_id, machine_user_id, spec, status)
     VALUES ($1, $2, 'u', 'm', '{}'::jsonb, $3)`,
    [kind, inst, status]
  );

describe("migration 0415 — hosted verb runs queue beside a check", () => {
  it("several open runs, and a check beside them", async () => {
    const { pg, inst } = await migrated();
    await queue(pg, inst, "verb");
    await queue(pg, inst, "verb", "leased");
    await queue(pg, inst, "verb", "running");
    await queue(pg, inst, "verify");
    const n = await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM host_jobs WHERE installation_id = $1`,
      [inst]
    );
    expect(n.rows[0]!.n).toBe(4);
    await pg.close();
  }, 60_000);

  it("still at most ONE open lifecycle job per installation", async () => {
    const { pg, inst } = await migrated();
    await queue(pg, inst, "install", "running");
    for (const kind of ["verify", "update", "remove", "provider_op"]) {
      await expect(queue(pg, inst, kind), kind).rejects.toThrow(
        /uq_host_jobs_one_open_lifecycle_per_installation/
      );
    }
    await queue(pg, inst, "verb");
    await pg.close();
  }, 60_000);

  it("drops the old index, and the baseline declares the new one the same way", async () => {
    const { pg } = await migrated();
    const idx = await pg.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'host_jobs'`
    );
    const names = idx.rows.map((r) => r.indexname);
    expect(names).not.toContain("uq_host_jobs_one_open_per_installation");
    expect(names).toContain("uq_host_jobs_one_open_lifecycle_per_installation");
    expect(BASELINE).not.toContain('"uq_host_jobs_one_open_per_installation"');
    const create = M0415.slice(M0415.indexOf("CREATE UNIQUE INDEX")).trim();
    expect(BASELINE).toContain(create);
    await pg.close();
  }, 60_000);
});
