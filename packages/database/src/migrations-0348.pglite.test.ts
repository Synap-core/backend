/**
 * REAL-POSTGRES (PGlite) test for migration 0348 — who is on a goal
 * (`track_participants`).
 *
 * The tracks table is built by the REAL 0272 / 0317 / 0344 migrations, seeded
 * with goals started by every kind of starter, then 0348 runs TWICE. Asserted:
 *   - BACKFILL: every goal gets exactly ONE owner row, a person — the human
 *     starter; for an agent starter, the human who created the agent; for an
 *     agent no human created, the project's owner; a starter with no users
 *     row keeps its id (nothing better is known). A goal that already had an
 *     owner row keeps it (idempotent second run);
 *   - the CHECKs and indexes: one owner and one judge per goal, owner/judge
 *     are people, a delegate's commitment has a state and nobody else's does,
 *     a report carries its reason and time, a counter its words.
 * The doors that write the rows run on PGlite in api
 * `services/tracks/__tests__/track-participants.pglite.test.ts`.
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
const M0348 = read("0348_track_participants.sql");

const P = "00000000-0000-4000-8000-000000000348";
const T = {
  human: "b0000000-0000-4000-8000-000000000001",
  agent: "b0000000-0000-4000-8000-000000000002",
  orphanAgent: "b0000000-0000-4000-8000-000000000003",
  unknown: "b0000000-0000-4000-8000-000000000004",
  closed: "b0000000-0000-4000-8000-000000000005",
  alreadyOwned: "b0000000-0000-4000-8000-000000000006",
};

let pg: PGlite;

async function owners(trackId: string) {
  return (
    await pg.query<{ principal_id: string; principal_kind: string }>(
      `SELECT principal_id, principal_kind FROM track_participants
        WHERE track_id = $1 AND role = 'owner'`,
      [trackId]
    )
  ).rows;
}

async function insertRow(values: Record<string, string | null>) {
  const cols = Object.keys(values);
  await pg.query(
    `INSERT INTO track_participants (${cols.join(", ")})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
    Object.values(values)
  );
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE projects (id uuid PRIMARY KEY, user_id text NOT NULL, phase text, settings jsonb);
    CREATE TABLE playbooks (id uuid PRIMARY KEY, name text NOT NULL, version integer NOT NULL DEFAULT 1);
    CREATE TABLE focus_sessions (id uuid PRIMARY KEY);
    CREATE TABLE users (id text PRIMARY KEY, user_type text NOT NULL DEFAULT 'human', created_by_user_id text);
  `);
  await pg.query(
    `INSERT INTO projects (id, user_id) VALUES ($1, 'project-owner')`,
    [P]
  );
  await pg.exec(`
    INSERT INTO users (id, user_type, created_by_user_id) VALUES
      ('ana', 'human', NULL),
      ('bob', 'human', NULL),
      ('bob-agent', 'agent', 'bob'),
      ('pod-agent', 'agent', NULL);
  `);
  await pg.exec(M0272);
  await pg.exec(M0317);
  await pg.exec(M0344);
  for (const [key, starter, status] of [
    ["human", "ana", "active"],
    ["agent", "bob-agent", "active"],
    ["orphanAgent", "pod-agent", "paused"],
    ["unknown", "ghost", "active"],
    ["closed", "ana", "archived"],
    ["alreadyOwned", "ana", "active"],
  ] as const) {
    await pg.query(
      `INSERT INTO project_tracks (id, project_id, user_id, name, status)
       VALUES ($1, $2, $3, $4, $5)`,
      [T[key], P, starter, `Goal ${key}`, status]
    );
  }
  // The first run creates the table; a goal given an owner by hand between
  // the runs must keep it on the second.
  await pg.exec(M0348);
  await pg.query(`DELETE FROM track_participants WHERE track_id = $1`, [
    T.alreadyOwned,
  ]);
  await insertRow({
    track_id: T.alreadyOwned,
    principal_kind: "person",
    principal_id: "bob",
    role: "owner",
    decided_by: "bob",
  });
  await pg.exec(M0348);
});

afterAll(async () => {
  await pg.close();
});

describe("0348 backfill — every goal gets one owner, a person", () => {
  it("a human starter owns their goal", async () => {
    expect(await owners(T.human)).toEqual([
      { principal_id: "ana", principal_kind: "person" },
    ]);
  });

  it("an agent starter's goal is owned by the human who created the agent", async () => {
    expect(await owners(T.agent)).toEqual([
      { principal_id: "bob", principal_kind: "person" },
    ]);
  });

  it("an agent no human created: the project's owner", async () => {
    expect(await owners(T.orphanAgent)).toEqual([
      { principal_id: "project-owner", principal_kind: "person" },
    ]);
  });

  it("a starter with no users row keeps its id; a dropped goal is backfilled too", async () => {
    expect(await owners(T.unknown)).toEqual([
      { principal_id: "ghost", principal_kind: "person" },
    ]);
    expect(await owners(T.closed)).toHaveLength(1);
  });

  it("is idempotent: one owner per goal after two runs, a kept owner untouched", async () => {
    const { rows } = await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM project_tracks t
        WHERE (SELECT count(*) FROM track_participants x
                WHERE x.track_id = t.id AND x.role = 'owner') <> 1`
    );
    expect(rows[0]!.n).toBe(0);
    expect(await owners(T.alreadyOwned)).toEqual([
      { principal_id: "bob", principal_kind: "person" },
    ]);
  });
});

describe("0348 constraints", () => {
  const base = { track_id: T.human, decided_by: "ana" };

  it("one owner per goal; at most one judge", async () => {
    await expect(
      insertRow({
        ...base,
        principal_kind: "person",
        principal_id: "bob",
        role: "owner",
      })
    ).rejects.toThrow();
    await insertRow({
      ...base,
      principal_kind: "person",
      principal_id: "bob",
      role: "judge",
    });
    await expect(
      insertRow({
        ...base,
        principal_kind: "person",
        principal_id: "ana",
        role: "judge",
      })
    ).rejects.toThrow();
  });

  it("owner and judge are people", async () => {
    await expect(
      insertRow({
        ...base,
        track_id: T.agent,
        principal_kind: "agent",
        principal_id: "bob-agent",
        role: "judge",
      })
    ).rejects.toThrow(/track_participants_shape_check/);
  });

  it("a delegate's commitment has a state; no other role carries one", async () => {
    await expect(
      insertRow({
        ...base,
        principal_kind: "agent",
        principal_id: "bob-agent",
        role: "delegate",
      })
    ).rejects.toThrow(/track_participants_shape_check/);
    await expect(
      insertRow({
        ...base,
        principal_kind: "person",
        principal_id: "bob",
        role: "integrator",
        commitment_state: "accepted",
      })
    ).rejects.toThrow(/track_participants_shape_check/);
    await insertRow({
      ...base,
      principal_kind: "agent",
      principal_id: "bob-agent",
      role: "delegate",
      commitment: "Draft",
      commitment_state: "proposed",
    });
  });

  it("a report carries its reason and time; a counter its words", async () => {
    await expect(
      insertRow({
        ...base,
        principal_kind: "person",
        principal_id: "bob",
        role: "delegate",
        commitment_state: "reported_impossible",
        reported_at: "2026-10-23T00:00:00Z",
      })
    ).rejects.toThrow(/track_participants_shape_check/);
    await expect(
      insertRow({
        ...base,
        principal_kind: "person",
        principal_id: "bob",
        role: "delegate",
        commitment_state: "countered",
      })
    ).rejects.toThrow(/track_participants_shape_check/);
    await insertRow({
      ...base,
      principal_kind: "person",
      principal_id: "bob",
      role: "delegate",
      commitment_state: "reported_impossible",
      reported_reason: "No access",
      reported_at: "2026-10-23T00:00:00Z",
    });
  });
});
