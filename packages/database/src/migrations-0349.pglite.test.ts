/**
 * REAL-POSTGRES (PGlite) test for migration 0349 — the done verdict
 * `retired` (an operation ends retired, never met — R6).
 *
 * The table is built by the REAL 0272, 0317, 0344 and 0345 migrations, then
 * 0349 runs TWICE. What is asserted:
 *   - a closed goal may now carry `retired`; every 0344 done verdict still
 *     closes;
 *   - `retired` is still refused on a drop and on a live goal (it is a DONE
 *     verdict), and the rest of 0344's rule holds (a close needs a verdict);
 *   - the CHECK spells exactly the shared done set (`PROJECT_TRACK_VERDICTS`
 *     minus the lost ones).
 * Which kind may close with `retired` is the status door's rule, run through
 * the real door on PGlite in api `services/tracks/__tests__/tracks.pglite.test.ts`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PROJECT_TRACK_VERDICTS } from "./schema/project-tracks.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) =>
  readFileSync(resolve(HERE, "../migrations", f), "utf8");
const M0272 = read("0272_project_tracks.sql");
const M0317 = read("0317_project_tracks_live_name_unique.sql");
const M0344 = read("0344_track_lifecycle_and_verdict.sql");
const M0345 = read("0345_track_goal_content.sql");
const M0349 = read("0349_track_verdict_retired.sql");

const P = "00000000-0000-4000-8000-000000000349";
const LOST = ["no_longer_needed", "impossible", "replaced", "mistake"];

let pg: PGlite;
let n = 0;

async function insert(
  status: string,
  verdict: string | null,
  kind = "operation"
) {
  n += 1;
  await pg.query(
    `INSERT INTO project_tracks (project_id, user_id, name, status, verdict, verdict_reason, work_kind)
     VALUES ($1, 'u', $2, $3, $4, 'why', $5)`,
    [P, `Goal ${n}`, status, verdict, kind]
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
  await pg.exec(M0345);
}, 120_000);

afterAll(async () => {
  await pg?.close();
});

describe("migration 0349 — an operation ends retired", () => {
  it("before 0349 the CHECK refuses retired (the migration is what admits it)", async () => {
    await expect(insert("completed", "retired")).rejects.toThrow(
      /project_tracks_verdict_check/
    );
  });

  it("applies twice (idempotent); a closed goal may carry retired, and every done verdict still closes", async () => {
    await pg.exec(M0349);
    await pg.exec(M0349);
    await insert("completed", "retired");
    for (const v of ["met", "partly_met", "not_met"]) {
      await insert("completed", v, "project");
    }
  });

  it("retired is a DONE verdict: refused on a drop and on a live goal; a close still needs a verdict", async () => {
    await expect(insert("archived", "retired")).rejects.toThrow(
      /project_tracks_verdict_check/
    );
    await expect(insert("active", "retired")).rejects.toThrow(
      /project_tracks_verdict_check/
    );
    await expect(insert("completed", null)).rejects.toThrow(
      /project_tracks_verdict_check/
    );
    await expect(insert("completed", "no_longer_needed")).rejects.toThrow(
      /project_tracks_verdict_check/
    );
  });

  it("the CHECK admits exactly the shared done set", async () => {
    for (const v of PROJECT_TRACK_VERDICTS.filter((v) => !LOST.includes(v))) {
      await insert("completed", v, "flow");
    }
    for (const v of LOST) await insert("archived", v);
    await expect(insert("completed", "achieved")).rejects.toThrow(
      /project_tracks_verdict_check/
    );
  });
});
