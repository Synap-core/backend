/**
 * REAL-POSTGRES (PGlite) test for `focus_sessions.title` (0262): the migration
 * adds the column the Drizzle schema declares, idempotently, bounded at 200;
 * the boot-time coherence check REPORTS a pod that skipped it; and the fresh-DB
 * baseline declares the same column.
 *
 * `checkSchemaCoherence` reads through `client-pg`'s `sql` — swapped here for a
 * postgres.js-shaped tagged-template shim over one PGlite per file.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";

const h = vi.hoisted(() => ({ pg: null as null | PGlite }));

vi.mock("../client-pg.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce(
      (acc, s, i) => acc + s + (i < values.length ? `$${i + 1}` : ""),
      ""
    );
    return (await h.pg!.query(text, values)).rows;
  };
  return { ...actual, sql };
});

import { checkSchemaCoherence } from "./schema-coherence.js";
import { focusSessions } from "../schema/focus-sessions.js";

const MIGRATIONS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../migrations"
);
const MIGRATION = readFileSync(
  resolve(MIGRATIONS, "0262_focus_sessions_title.sql"),
  "utf8"
);
const BASELINE = readFileSync(
  resolve(MIGRATIONS, "0000_baseline_schema.sql"),
  "utf8"
);

const titleMissing = async () =>
  (await checkSchemaCoherence()).missing.some(
    (m) => m.table === "focus_sessions" && m.column === "title"
  );

beforeAll(async () => {
  h.pg = new PGlite();
  await h.pg.exec(
    `CREATE TABLE focus_sessions (id uuid PRIMARY KEY, goal text NOT NULL);`
  );
}, 120_000);

afterAll(async () => {
  await h.pg?.close();
});

describe("focus_sessions.title — migration 0262 + coherence", () => {
  it("self-check: the Drizzle schema declares title as varchar(200)", () => {
    const col = getTableConfig(focusSessions).columns.find(
      (c) => c.name === "title"
    );
    expect(col?.getSQLType()).toBe("varchar(200)");
    expect(col?.notNull).toBe(false);
  });

  it("a pod that skipped 0262 is reported by the coherence check", async () => {
    await expect(titleMissing()).resolves.toBe(true);
  });

  it("0262 adds the column, re-runs cleanly, and the report clears", async () => {
    await h.pg!.exec(MIGRATION);
    await h.pg!.exec(MIGRATION); // IF NOT EXISTS — a re-run must not fail
    const { rows } = await h.pg!.query<{
      data_type: string;
      character_maximum_length: number;
      is_nullable: string;
    }>(
      `SELECT data_type, character_maximum_length, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'focus_sessions' AND column_name = 'title'`
    );
    expect(rows).toEqual([
      {
        data_type: "character varying",
        character_maximum_length: 200,
        is_nullable: "YES",
      },
    ]);
    await expect(titleMissing()).resolves.toBe(false);
  });

  it("the column refuses a 201-character title", async () => {
    await expect(
      h.pg!.query(
        `INSERT INTO focus_sessions (id, goal, title) VALUES (gen_random_uuid(), 'g', $1)`,
        ["x".repeat(201)]
      )
    ).rejects.toThrow();
  });

  it("the fresh-DB baseline declares the same column", () => {
    expect(BASELINE).toMatch(
      /ALTER TABLE "focus_sessions" ADD COLUMN IF NOT EXISTS "title" varchar\(200\);/
    );
  });
});
