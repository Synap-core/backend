/**
 * REAL-POSTGRES (PGlite) test for migration 0344 — the track lifecycle
 * (open · active · paused · done · lost) and the verdict columns.
 *
 * The table is built by the REAL 0272 and 0317 migrations (the shape and the
 * live-name index pods hold today), seeded with one track per old status,
 * then 0344 runs TWICE. What is asserted:
 *   - a `completed` track reads verdict `met`; an `archived` one keeps NULL;
 *     who/when stay NULL (unknown, never guessed);
 *   - the new open statuses are admitted;
 *   - the live-name index keeps its NAME (the boot guard checks names) and now
 *     covers open tracks; a closed track's name stays free;
 *   - the verdict CHECK refuses a close with no verdict, a close with a lost
 *     verdict, a verdict on a live track, and impossible / replaced without a
 *     reason.
 * The service writes that use the columns run through the real door on
 * PGlite in api `services/tracks/__tests__/tracks.pglite.test.ts`.
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

const P = "00000000-0000-4000-8000-000000000344";
const T = {
  active: "a0000000-0000-4000-8000-000000000001",
  paused: "a0000000-0000-4000-8000-000000000002",
  completed: "a0000000-0000-4000-8000-000000000003",
  archived: "a0000000-0000-4000-8000-000000000004",
};

let pg: PGlite;

async function row(id: string) {
  return (
    await pg.query<{
      status: string;
      verdict: string | null;
      verdict_reason: string | null;
      verdict_by: string | null;
      verdict_at: string | null;
    }>(
      `SELECT status, verdict, verdict_reason, verdict_by, verdict_at
         FROM project_tracks WHERE id = $1`,
      [id]
    )
  ).rows[0];
}

async function insert(
  name: string,
  status: string,
  extra: { verdict?: string; reason?: string } = {}
) {
  await pg.query(
    `INSERT INTO project_tracks (project_id, user_id, name, status, verdict, verdict_reason)
     VALUES ($1, 'u', $2, $3, $4, $5)`,
    [P, name, status, extra.verdict ?? null, extra.reason ?? null]
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
  for (const [status, id] of Object.entries(T)) {
    await pg.query(
      `INSERT INTO project_tracks (id, project_id, user_id, name, status)
       VALUES ($1, $2, 'u', $3, $4)`,
      [id, P, `Goal ${status}`, status]
    );
  }
}, 120_000);

afterAll(async () => {
  await pg?.close();
});

describe("migration 0344 — track lifecycle + verdict", () => {
  it("applies twice (idempotent) and adds the four nullable columns", async () => {
    await pg.exec(M0344);
    await pg.exec(M0344);
    const cols = await pg.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'project_tracks' AND column_name LIKE 'verdict%'
        ORDER BY column_name`
    );
    expect(cols.rows).toEqual([
      { column_name: "verdict", is_nullable: "YES" },
      { column_name: "verdict_at", is_nullable: "YES" },
      { column_name: "verdict_by", is_nullable: "YES" },
      { column_name: "verdict_reason", is_nullable: "YES" },
    ]);
  });

  it("maps completed → met; archived and live tracks keep no verdict; who/when stay unknown", async () => {
    expect(await row(T.completed)).toMatchObject({
      status: "completed",
      verdict: "met",
      verdict_by: null,
      verdict_at: null,
    });
    for (const id of [T.archived, T.active, T.paused]) {
      expect((await row(id))!.verdict).toBeNull();
    }
  });

  it("keeps the live-name index's NAME (the boot guard reads names) with the new live set", async () => {
    const idx = await pg.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'uniq_project_tracks_live_name'`
    );
    expect(idx.rows).toHaveLength(1);
    for (const s of ["proposed", "agreed", "ready", "active", "paused"]) {
      expect(idx.rows[0]!.indexdef).toContain(`'${s}'`);
    }
    expect(idx.rows[0]!.indexdef).not.toContain("'completed'");
  });

  it("admits the open statuses, and an open goal HOLDS its name", async () => {
    await insert("Shaped goal", "proposed");
    await insert("Agreed goal", "agreed");
    await insert("Ready goal", "ready");
    // Rule ruled out: the 0317 predicate (active, paused) — under it a second
    // live goal could share a proposed goal's name.
    await expect(insert("shaped goal ", "active")).rejects.toThrow(
      /uniq_project_tracks_live_name/
    );
    // A closed goal's name is free: the new version may take it.
    await insert("Goal completed", "active");
  });

  it("refuses a close with no verdict, or with the other ending's verdict", async () => {
    await expect(insert("C1", "completed")).rejects.toThrow(
      /project_tracks_verdict_check/
    );
    await expect(
      insert("C2", "completed", { verdict: "no_longer_needed" })
    ).rejects.toThrow(/project_tracks_verdict_check/);
    await expect(insert("C3", "archived", { verdict: "met" })).rejects.toThrow(
      /project_tracks_verdict_check/
    );
    await insert("C4", "completed", { verdict: "partly_met" });
    await insert("C5", "archived", { verdict: "mistake" });
  });

  it("refuses a verdict on a live goal, and impossible / replaced without a reason", async () => {
    await expect(insert("L1", "active", { verdict: "met" })).rejects.toThrow(
      /project_tracks_verdict_check/
    );
    for (const v of ["impossible", "replaced"]) {
      await expect(
        insert(`R-${v}`, "archived", { verdict: v, reason: "  " })
      ).rejects.toThrow(/project_tracks_verdict_check/);
      await insert(`R-${v}-ok`, "archived", { verdict: v, reason: "why" });
    }
  });

  it("refuses a status outside the lifecycle", async () => {
    await expect(insert("X", "in_review")).rejects.toThrow(
      /project_tracks_status_check/
    );
  });
});
