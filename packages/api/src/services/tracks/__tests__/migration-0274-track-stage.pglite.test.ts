/**
 * REAL-POSTGRES (PGlite) test for migration 0274: the columns land, every
 * track standing on a stage gets ONE backfilled history entry (dated at its
 * creation, attributed to its starter), a stageless track gets none, and a
 * re-run changes nothing — not even a history that has grown since.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { PGlite } from "@electric-sql/pglite";

const MIGRATION = readFileSync(
  join(
    __dirname,
    "../../../../../database/migrations/0274_track_stage_and_params.sql"
  ),
  "utf8"
);

const STAGED = "a0000000-0000-4000-8000-000000000001";
const STAGELESS = "a0000000-0000-4000-8000-000000000002";

let pg: PGlite;

async function history(id: string) {
  const { rows } = await pg.query<{
    stage_history: unknown[];
    params: unknown;
  }>(`SELECT stage_history, params FROM project_tracks WHERE id = $1`, [id]);
  return rows[0]!;
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE project_tracks (id uuid PRIMARY KEY, user_id text NOT NULL, current_stage text, created_at timestamptz NOT NULL DEFAULT '2026-09-01T10:00:00Z');
    CREATE TABLE focus_sessions (id uuid PRIMARY KEY, track_id uuid);
  `);
  await pg.query(
    `INSERT INTO project_tracks (id, user_id, current_stage) VALUES ($1, 'owner', 'build'), ($2, 'owner', NULL)`,
    [STAGED, STAGELESS]
  );
  await pg.exec(MIGRATION);
}, 120_000);

afterAll(async () => {
  await pg?.close();
});

describe("migration 0274", () => {
  it("adds focus_sessions.track_stage and the (track_id, track_stage) index", async () => {
    await pg.query(`SELECT track_stage FROM focus_sessions`);
    const { rows } = await pg.query(
      `SELECT 1 FROM pg_indexes WHERE indexname = 'idx_focus_sessions_track_stage'`
    );
    expect(rows).toHaveLength(1);
  });

  it("backfills ONE entry for a staged track, none for a stageless one; params default {}", async () => {
    const staged = await history(STAGED);
    expect(staged.params).toEqual({});
    expect(staged.stage_history).toEqual([
      {
        stageKey: "build",
        fromStage: null,
        enteredAt: "2026-09-01T10:00:00.000Z",
        actor: "owner",
      },
    ]);
    expect((await history(STAGELESS)).stage_history).toEqual([]);
  });

  it("is idempotent — a re-run never duplicates or rewrites a grown history", async () => {
    // Re-run INSIDE the test so a non-idempotent migration fails by name.
    await pg.exec(MIGRATION);
    expect((await history(STAGED)).stage_history).toHaveLength(1);
    await pg.query(
      `UPDATE project_tracks SET stage_history = stage_history || '[{"stageKey":"ship","fromStage":"build","enteredAt":"x","actor":"a"}]'::jsonb WHERE id = $1`,
      [STAGED]
    );
    await pg.exec(MIGRATION);
    expect((await history(STAGED)).stage_history).toHaveLength(2);
  });
});
