/**
 * REAL-POSTGRES (PGlite) test for migration 0350 — the goal's loop (W4).
 *
 * The table is built by the REAL 0272, 0317, 0344 and 0345 migrations, seeded
 * with a track, then 0350 runs TWICE. What is asserted: one nullable column,
 * existing rows untouched (NULL = never set = off), and only an object (or
 * NULL) is admitted. The writes run through the real door on PGlite in api
 * `services/tracks/__tests__/goal-loop.pglite.test.ts`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) =>
  readFileSync(resolve(HERE, "../migrations", f), "utf8");
const M0272 = read("0272_project_tracks.sql");
const M0317 = read("0317_project_tracks_live_name_unique.sql");
const M0344 = read("0344_track_lifecycle_and_verdict.sql");
const M0345 = read("0345_track_goal_content.sql");
const M0350 = read("0350_track_goal_loop.sql");

const P = "00000000-0000-4000-8000-000000000350";
const T = "a0000000-0000-4000-8000-000000000350";

let pg: PGlite;

async function setLoop(value: unknown) {
  return pg.query(`UPDATE project_tracks SET loop = $1::jsonb WHERE id = $2`, [
    value === null ? null : JSON.stringify(value),
    T,
  ]);
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE projects (id uuid PRIMARY KEY, user_id text NOT NULL, phase text, settings jsonb);
    CREATE TABLE playbooks (id uuid PRIMARY KEY, name text NOT NULL, version integer NOT NULL DEFAULT 1);
    CREATE TABLE focus_sessions (id uuid PRIMARY KEY);
  `);
  await pg.query(`INSERT INTO projects (id, user_id) VALUES ($1, 'u')`, [P]);
  await pg.exec(M0272);
  await pg.exec(M0317);
  await pg.exec(M0344);
  await pg.exec(M0345);
  await pg.query(
    `INSERT INTO project_tracks (id, project_id, user_id, name, status) VALUES ($1, $2, 'u', 'Goal', 'active')`,
    [T, P]
  );
}, 120_000);

afterAll(async () => {
  await pg?.close();
});

describe("migration 0350 — the goal's loop", () => {
  it("applies twice (idempotent), adds one nullable column, leaves existing rows NULL", async () => {
    await pg.exec(M0350);
    await pg.exec(M0350);
    const cols = await pg.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'project_tracks' AND column_name = 'loop'`
    );
    expect(cols.rows).toEqual([{ column_name: "loop", is_nullable: "YES" }]);
    const r = await pg.query<{ loop: unknown }>(
      `SELECT loop FROM project_tracks WHERE id = $1`,
      [T]
    );
    expect(r.rows[0]!.loop).toBeNull();
  });

  it("admits an object or NULL, refuses anything else", async () => {
    await setLoop({ on: true, perWeek: 3 });
    await setLoop(null);
    await expect(setLoop([true])).rejects.toThrow(
      /project_tracks_loop_object_check/
    );
    await expect(setLoop(true)).rejects.toThrow(
      /project_tracks_loop_object_check/
    );
  });
});
