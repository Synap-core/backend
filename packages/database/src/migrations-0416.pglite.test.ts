/**
 * REAL-POSTGRES (PGlite) test for migration 0416 — who runs a playbook, the
 * tools it needs, and every kept version of its definition (spec 7111934d
 * slice 1):
 *   - `playbooks.runner` (NULL = nobody named) and `playbooks.requires`
 *     (`[]`, never NULL) are added idempotently;
 *   - `playbook_versions` is created and BACKFILLED with each existing
 *     playbook's current version, so a step can pin any playbook of today;
 *     re-running keeps one row per (playbook, version);
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
const FILE = "0416_playbook_runner_and_versions.sql";
const M0416 = read(FILE);
const BASELINE = read("0000_baseline_schema.sql");
const PB = "33333333-3333-4333-8333-333333333333";

let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  // A playbook as it stood before 0416 (the columns the backfill reads).
  await pg.exec(`
    CREATE TABLE "playbooks" (
      "id" uuid PRIMARY KEY,
      "name" text NOT NULL,
      "description" text,
      "goal_template" text NOT NULL,
      "params" jsonb NOT NULL DEFAULT '[]',
      "input_strategy" jsonb NOT NULL DEFAULT '{"kind":"none"}',
      "channel_spec" jsonb NOT NULL DEFAULT '{}',
      "expected_outputs" jsonb NOT NULL DEFAULT '[]',
      "stages" jsonb NOT NULL DEFAULT '[]',
      "criteria" jsonb NOT NULL DEFAULT '[]',
      "required_intents" jsonb NOT NULL DEFAULT '[]',
      "guidance" jsonb NOT NULL DEFAULT '[]',
      "subject_profile" jsonb,
      "executor" text NOT NULL DEFAULT 'is-agent',
      "scope" text,
      "version" integer NOT NULL DEFAULT 1,
      "created_by" text NOT NULL,
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO "playbooks" ("id", "name", "goal_template", "stages", "version", "created_by")
    VALUES ('${PB}', 'Edit a video', 'Edit {take}',
            '[{"key":"cut","name":"Cut","category":"started"}]', 4, 'u-1');
  `);
  await pg.exec(M0416);
  await pg.exec(M0416);
}, 60_000);
afterAll(async () => {
  await pg.close();
});

describe("migration 0416 — runner, requires, kept versions", () => {
  it("an existing playbook names no runner and requires nothing; requires is never NULL", async () => {
    const { rows } = await pg.query<{ runner: unknown; requires: unknown }>(
      `SELECT runner, requires FROM playbooks`
    );
    expect(rows).toEqual([{ runner: null, requires: [] }]);
    await expect(
      pg.query(
        `INSERT INTO playbooks (id, name, goal_template, created_by, requires)
         VALUES (gen_random_uuid(), 'x', 'x', 'u', NULL)`
      )
    ).rejects.toThrow();
  });

  it("keeps each playbook's CURRENT version, once, with its definition", async () => {
    const { rows } = await pg.query<{
      playbook_id: string;
      version: number;
      definition: Record<string, unknown>;
      created_by: string | null;
    }>(
      `SELECT playbook_id, version, definition, created_by FROM playbook_versions`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      playbook_id: PB,
      version: 4,
      created_by: "u-1",
    });
    expect(rows[0]!.definition).toMatchObject({
      name: "Edit a video",
      goalTemplate: "Edit {take}",
      stages: [{ key: "cut", name: "Cut", category: "started" }],
      runner: null,
      requires: [],
    });
  });

  it("a kept version cannot be written twice", async () => {
    await expect(
      pg.query(
        `INSERT INTO playbook_versions (playbook_id, version, definition)
         VALUES ('${PB}', 4, '{}')`
      )
    ).rejects.toThrow();
  });

  it("the baseline carries the same lines and the boot check names them", () => {
    for (const line of [
      'ALTER TABLE "playbooks" ADD COLUMN IF NOT EXISTS "runner" jsonb;',
      'ALTER TABLE "playbooks" ADD COLUMN IF NOT EXISTS "requires" jsonb NOT NULL DEFAULT \'[]\'::jsonb;',
      'CREATE TABLE IF NOT EXISTS "playbook_versions" (',
    ]) {
      expect(M0416).toContain(line);
      expect(BASELINE).toContain(line);
    }
    for (const [table, column] of [
      ["playbooks", "runner"],
      ["playbooks", "requires"],
      ["playbook_versions", "definition"],
    ] as const) {
      expect(REQUIRED_COLUMNS).toContainEqual(
        expect.objectContaining({ table, column, addedBy: FILE })
      );
    }
  });
});
