/**
 * REAL-POSTGRES (PGlite) test for migration 0272: every project that followed
 * a method through the proto-track (`projects.settings.stages`, written by the
 * old `instantiateFromPlaybook`) becomes EXACTLY ONE track — and re-running the
 * migration changes nothing, not even for a track someone has since archived.
 *
 * Applies the real migration file (once, again, then a third time after an archive)
 * against minimal `projects` / `playbooks` / `focus_sessions` tables.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { PGlite } from "@electric-sql/pglite";

const MIGRATION = readFileSync(
  join(__dirname, "../../../../../database/migrations/0272_project_tracks.sql"),
  "utf8"
);

const PB = "11111111-1111-4111-8111-111111111111";
const GONE_PB = "22222222-2222-4222-8222-222222222222";
const P = {
  bound: "a0000000-0000-4000-8000-000000000001",
  malformedSource: "a0000000-0000-4000-8000-000000000002",
  deletedSource: "a0000000-0000-4000-8000-000000000003",
  emptyStages: "a0000000-0000-4000-8000-000000000004",
  noSettings: "a0000000-0000-4000-8000-000000000005",
};
const STAGES = [
  { key: "discover", name: "Discover" },
  { key: "build", name: "Build" },
];

let pg: PGlite;

async function tracks() {
  return (
    await pg.query<{
      project_id: string;
      playbook_id: string | null;
      name: string;
      method_version: string;
      current_stage: string | null;
      status: string;
      definition_snapshot: { stages: Array<{ key: string }> };
    }>(`SELECT * FROM project_tracks ORDER BY project_id`)
  ).rows;
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE projects (id uuid PRIMARY KEY, user_id text NOT NULL, phase text, settings jsonb);
    CREATE TABLE playbooks (id uuid PRIMARY KEY, name text NOT NULL, version integer NOT NULL DEFAULT 1);
    CREATE TABLE focus_sessions (id uuid PRIMARY KEY);
  `);
  await pg.query(
    `INSERT INTO playbooks (id, name, version) VALUES ($1, 'Client Engagement', 4)`,
    [PB]
  );
  const rows: Array<[string, string | null, unknown]> = [
    [
      P.bound,
      "build",
      {
        stages: STAGES,
        sourcePlaybookId: PB,
        sourcePlaybookVersion: 3,
        other: 1,
      },
    ],
    [
      P.malformedSource,
      "whatever we call it",
      { stages: STAGES, sourcePlaybookId: "not-a-uuid" },
    ],
    [P.deletedSource, null, { stages: STAGES, sourcePlaybookId: GONE_PB }],
    [P.emptyStages, "build", { stages: [] }],
    [P.noSettings, "build", null],
  ];
  for (const [id, phase, settings] of rows) {
    await pg.query(
      `INSERT INTO projects (id, user_id, phase, settings) VALUES ($1, 'owner', $2, $3::jsonb)`,
      [id, phase, settings === null ? null : JSON.stringify(settings)]
    );
  }
  await pg.exec(MIGRATION);
}, 120_000);

afterAll(async () => {
  await pg?.close();
});

describe("migration 0272: project_tracks backfill from the proto-track", () => {
  it("creates exactly one track per project that carried stages — and none for the rest", async () => {
    const rows = await tracks();
    expect(rows.map((r) => r.project_id).sort()).toEqual(
      [P.bound, P.malformedSource, P.deletedSource].sort()
    );
  });

  it("a bound project keeps its method, its pinned version and its stage", async () => {
    const t = (await tracks()).find((r) => r.project_id === P.bound)!;
    expect(t).toMatchObject({
      playbook_id: PB,
      name: "Client Engagement",
      // The version the PROJECT copied (3), not the method's current one (4).
      method_version: "3",
      current_stage: "build",
      status: "active",
    });
    expect(t.definition_snapshot.stages.map((s) => s.key)).toEqual([
      "discover",
      "build",
    ]);
  });

  it("an unusable source id never reaches the uuid cast; the track keeps its history", async () => {
    const byProject = new Map((await tracks()).map((r) => [r.project_id, r]));
    expect(byProject.get(P.malformedSource)).toMatchObject({
      playbook_id: null,
      name: "Method",
      // A free-text phase names no stage → no current stage is invented.
      current_stage: null,
    });
    expect(byProject.get(P.deletedSource)).toMatchObject({
      playbook_id: null,
      name: "Method",
    });
  });

  it("is idempotent — and never resurrects a track that was archived", async () => {
    // Re-run inside the test (not in beforeAll) so a non-idempotent migration
    // fails THIS assertion by name instead of skipping the suite.
    await pg.exec(MIGRATION);
    expect(await tracks()).toHaveLength(3);
    await pg.query(
      `UPDATE project_tracks SET status = 'archived' WHERE project_id = $1`,
      [P.bound]
    );
    await pg.exec(MIGRATION);
    const rows = await tracks();
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.project_id === P.bound)!.status).toBe("archived");
  });

  it("adds focus_sessions.track_id with its FK", async () => {
    const { rows } = await pg.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = 'focus_sessions_track_id_fkey'`
    );
    expect(rows).toHaveLength(1);
  });
});
