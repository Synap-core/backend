/**
 * REAL-POSTGRES (PGlite) test for migration 0411 — a playbook declares the
 * rules it follows (`playbooks.guidance`, design b199a3a4):
 *   - the migration adds the column, idempotently, defaulting every existing
 *     playbook to `[]` (declares nothing), never NULL;
 *   - the baseline carries the same column line; the boot coherence list
 *     names it.
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
const FILE = "0411_playbook_guidance.sql";
const M0411 = read(FILE);
const BASELINE = read("0000_baseline_schema.sql");
const COLUMN_LINE =
  'ALTER TABLE "playbooks" ADD COLUMN IF NOT EXISTS "guidance" jsonb NOT NULL DEFAULT \'[]\'::jsonb;';

let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  // A playbook that existed before 0411.
  await pg.exec(
    `CREATE TABLE "playbooks" ("id" uuid PRIMARY KEY, "name" text NOT NULL);
     INSERT INTO "playbooks" VALUES ('33333333-3333-4333-8333-333333333333', 'Old');`
  );
  await pg.exec(M0411);
  await pg.exec(M0411);
}, 60_000);
afterAll(async () => {
  await pg.close();
});

describe("migration 0411 — the rules a playbook follows", () => {
  it("adds the column idempotently; an existing playbook declares nothing", async () => {
    const { rows } = await pg.query<{ guidance: unknown }>(
      `SELECT guidance FROM playbooks`
    );
    expect(rows).toEqual([{ guidance: [] }]);
    await expect(
      pg.query(
        `INSERT INTO playbooks (id, name, guidance) VALUES (gen_random_uuid(), 'x', NULL)`
      )
    ).rejects.toThrow();
  });

  it("the baseline carries the same column and the boot check names it", () => {
    expect(M0411).toContain(COLUMN_LINE);
    expect(BASELINE).toContain(COLUMN_LINE);
    expect(REQUIRED_COLUMNS).toContainEqual(
      expect.objectContaining({
        table: "playbooks",
        column: "guidance",
        addedBy: FILE,
      })
    );
  });
});
