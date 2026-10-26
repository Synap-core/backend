/**
 * REAL-POSTGRES (PGlite) test for migration 0345 — what a goal holds (end
 * state, criteria, drop conditions, kind of work, uncertainty, who confirmed
 * the kind).
 *
 * The table is built by the REAL 0272, 0317 and 0344 migrations, seeded with
 * a track, then 0345 runs TWICE. What is asserted:
 *   - seven nullable columns, existing rows untouched (all NULL);
 *   - the kind-of-work and uncertainty CHECKs admit every value of the shared
 *     sets and NULL, and refuse anything else;
 *   - criteria and drop conditions must be JSON LISTS.
 * The writes run through the real door on PGlite in api
 * `services/tracks/__tests__/tracks.pglite.test.ts`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
  PROJECT_TRACK_UNCERTAINTY_LEVELS,
  PROJECT_TRACK_WORK_KINDS,
} from "./schema/project-tracks.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) =>
  readFileSync(resolve(HERE, "../migrations", f), "utf8");
const M0272 = read("0272_project_tracks.sql");
const M0317 = read("0317_project_tracks_live_name_unique.sql");
const M0344 = read("0344_track_lifecycle_and_verdict.sql");
const M0345 = read("0345_track_goal_content.sql");

const P = "00000000-0000-4000-8000-000000000345";
const T = "a0000000-0000-4000-8000-000000000345";
const COLS = [
  "criteria",
  "drop_conditions",
  "end_state",
  "kind_confirmed_at",
  "kind_confirmed_by",
  "uncertainty",
  "work_kind",
];

let pg: PGlite;

async function set(col: string, value: unknown, cast = "") {
  return pg.query(
    `UPDATE project_tracks SET ${col} = $1${cast} WHERE id = $2`,
    [value, T]
  );
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
  await pg.query(
    `INSERT INTO project_tracks (id, project_id, user_id, name, status) VALUES ($1, $2, 'u', 'Goal', 'active')`,
    [T, P]
  );
}, 120_000);

afterAll(async () => {
  await pg?.close();
});

describe("migration 0345 — what a goal holds", () => {
  it("applies twice (idempotent), adds seven nullable columns, leaves existing rows NULL", async () => {
    await pg.exec(M0345);
    await pg.exec(M0345);
    const cols = await pg.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'project_tracks' AND column_name = ANY($1)
        ORDER BY column_name`,
      [COLS]
    );
    expect(cols.rows).toEqual(
      COLS.map((column_name) => ({ column_name, is_nullable: "YES" }))
    );
    const r = await pg.query<Record<string, unknown>>(
      `SELECT ${COLS.join(", ")} FROM project_tracks WHERE id = $1`,
      [T]
    );
    expect(Object.values(r.rows[0]!).every((v) => v === null)).toBe(true);
  });

  it("the kind and uncertainty CHECKs admit exactly the shared sets (and NULL)", async () => {
    for (const k of PROJECT_TRACK_WORK_KINDS) await set("work_kind", k);
    for (const u of PROJECT_TRACK_UNCERTAINTY_LEVELS)
      await set("uncertainty", u);
    await set("work_kind", null);
    await set("uncertainty", null);
    await expect(set("work_kind", "epic")).rejects.toThrow(
      /project_tracks_work_kind_check/
    );
    await expect(set("uncertainty", "simple")).rejects.toThrow(
      /project_tracks_uncertainty_check/
    );
  });

  it("criteria and drop conditions must be lists", async () => {
    await set("criteria", JSON.stringify([{ key: "a" }]), "::jsonb");
    await set("drop_conditions", JSON.stringify(["x"]), "::jsonb");
    await expect(
      set("criteria", JSON.stringify({ key: "a" }), "::jsonb")
    ).rejects.toThrow(/project_tracks_criteria_array_check/);
    await expect(
      set("drop_conditions", JSON.stringify("x"), "::jsonb")
    ).rejects.toThrow(/project_tracks_drop_conditions_array_check/);
  });
});
