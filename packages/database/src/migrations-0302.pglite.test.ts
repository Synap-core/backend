/**
 * REAL-POSTGRES (PGlite) test for migration 0302 — `project_tracks.direction`
 * + `project_tracks.kpi`. The repository writes that use them
 * (`patchDirection`, `appendStage`) are exercised through the real service on
 * PGlite in api `services/tracks/__tests__/track-direction.pglite.test.ts` —
 * never replayed here as copied SQL.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const HERE = dirname(fileURLToPath(import.meta.url));
const M0302 = readFileSync(
  resolve(HERE, "../migrations/0302_track_direction_and_kpi.sql"),
  "utf8"
);

const ID = "00000000-0000-4000-8000-000000000302";
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  // The 0272/0274 shape the migration alters (only the columns it touches).
  await pg.exec(`
    CREATE TABLE project_tracks (
      id uuid PRIMARY KEY,
      definition_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
      params jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    INSERT INTO project_tracks (id, definition_snapshot)
      VALUES ('${ID}', '{"stages":[{"key":"a","name":"A"}]}'::jsonb);
  `);
}, 120_000);

describe("migration 0302 — track direction + kpi", () => {
  it("adds both columns, nullable, and is idempotent", async () => {
    await pg.exec(M0302);
    await pg.exec(M0302);
    const cols = await pg.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'project_tracks' AND column_name IN ('direction','kpi')
        ORDER BY column_name`
    );
    expect(cols.rows).toEqual([
      { column_name: "direction", data_type: "text", is_nullable: "YES" },
      { column_name: "kpi", data_type: "jsonb", is_nullable: "YES" },
    ]);
    const row = await pg.query<{ direction: unknown; kpi: unknown }>(
      `SELECT direction, kpi FROM project_tracks WHERE id = '${ID}'`
    );
    // An existing track steers by nothing until someone says so.
    expect(row.rows[0]).toEqual({ direction: null, kpi: null });
  });
});
