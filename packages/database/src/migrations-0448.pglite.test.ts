/**
 * Migration 0448 on PGlite: `space_access`, the expand step taking over from
 * `profile_workspace_access`.
 *  - existing kind grants are copied as `object_type = 'profile'` rows,
 *    twice-run safe; the old table stays (forward-only);
 *  - kind grants stay equal in both tables, whichever side writes them (a
 *    previous release writes the old table), and the mirror stops after one hop;
 *  - one object can be granted to a space once per type;
 *  - deleting a profile, playbook or skill removes its grants, and only its own;
 *  - the baseline carries both tables; the boot coherence list names the new
 *    columns.
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
const M0448 = read("0448_space_access.sql");
const BASELINE = read("0000_baseline_schema.sql");

const WS = "11111111-1111-4111-8111-111111111111";
const WS2 = "22222222-2222-4222-8222-222222222222";
const KIND = "33333333-3333-4333-8333-333333333333";
const KIND2 = "44444444-4444-4444-8444-444444444444";
const PB = "55555555-5555-4555-8555-555555555555";
const SKILL = "66666666-6666-4666-8666-666666666666";

let pg: PGlite;
const rows = async <T>(sql: string) => (await pg.query<T>(sql)).rows;

beforeAll(async () => {
  pg = new PGlite();
  // The tables as they stood before 0448.
  await pg.exec(`
    CREATE TABLE "workspaces" ("id" uuid PRIMARY KEY);
    CREATE TABLE "profiles" ("id" uuid PRIMARY KEY);
    CREATE TABLE "playbooks" ("id" uuid PRIMARY KEY);
    CREATE TABLE "skills" ("id" uuid PRIMARY KEY);
    CREATE TABLE "profile_workspace_access" (
      "profile_id"   uuid NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
      "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE,
      "granted_at"   timestamp with time zone NOT NULL DEFAULT now(),
      PRIMARY KEY ("profile_id", "workspace_id")
    );
    INSERT INTO workspaces VALUES ('${WS}'), ('${WS2}');
    INSERT INTO profiles VALUES ('${KIND}'), ('${KIND2}');
    INSERT INTO playbooks VALUES ('${PB}');
    INSERT INTO skills VALUES ('${SKILL}');
    INSERT INTO profile_workspace_access (profile_id, workspace_id) VALUES ('${KIND}', '${WS}');
  `);
  await pg.exec(M0448);
  await pg.exec(M0448);
}, 60_000);
afterAll(async () => {
  await pg.close();
});

describe("migration 0448 — space_access (expand)", () => {
  it("copies every kind grant as a profile row and keeps the old table", async () => {
    expect(
      await rows(
        `SELECT object_type, object_id, workspace_id FROM space_access ORDER BY object_id`
      )
    ).toEqual([{ object_type: "profile", object_id: KIND, workspace_id: WS }]);
    expect(
      await rows(`SELECT profile_id FROM profile_workspace_access`)
    ).toEqual([{ profile_id: KIND }]);
  });

  it("mirrors kind grants both ways, one hop, whichever side writes", async () => {
    // A previous release grants through the old table…
    await pg.exec(
      `INSERT INTO profile_workspace_access (profile_id, workspace_id) VALUES ('${KIND2}', '${WS2}')`
    );
    expect(
      await rows(
        `SELECT object_id FROM space_access WHERE object_type = 'profile' AND workspace_id = '${WS2}'`
      )
    ).toEqual([{ object_id: KIND2 }]);
    // …this release through the new one.
    await pg.exec(
      `INSERT INTO space_access (object_type, object_id, workspace_id) VALUES ('profile', '${KIND}', '${WS2}')`
    );
    expect(
      await rows(
        `SELECT profile_id FROM profile_workspace_access WHERE workspace_id = '${WS2}' ORDER BY profile_id`
      )
    ).toEqual([{ profile_id: KIND }, { profile_id: KIND2 }]);
    // A revoke on either side reaches the other.
    await pg.exec(
      `DELETE FROM space_access WHERE object_id = '${KIND}' AND workspace_id = '${WS2}'`
    );
    await pg.exec(
      `DELETE FROM profile_workspace_access WHERE profile_id = '${KIND2}'`
    );
    expect(
      await rows(`SELECT object_id, workspace_id FROM space_access`)
    ).toEqual([{ object_id: KIND, workspace_id: WS }]);
    expect(
      await rows(
        `SELECT profile_id, workspace_id FROM profile_workspace_access`
      )
    ).toEqual([{ profile_id: KIND, workspace_id: WS }]);
  });

  it("grants a playbook and a skill beside the kinds, once each, never into the old table", async () => {
    await pg.exec(`
      INSERT INTO space_access (object_type, object_id, workspace_id, granted_by)
      VALUES ('playbook', '${PB}', '${WS2}', 'u-1'), ('skill', '${SKILL}', '${WS2}', 'u-1');
    `);
    await expect(
      pg.exec(
        `INSERT INTO space_access (object_type, object_id, workspace_id) VALUES ('playbook', '${PB}', '${WS2}')`
      )
    ).rejects.toThrow();
    expect(
      await rows(`SELECT count(*)::int AS n FROM profile_workspace_access`)
    ).toEqual([{ n: 1 }]);
  });

  it("a deleted object takes its grants with it, and only its own", async () => {
    await pg.exec(`DELETE FROM playbooks WHERE id = '${PB}'`);
    await pg.exec(`DELETE FROM profiles WHERE id = '${KIND}'`);
    expect(
      await rows(`SELECT object_type, object_id FROM space_access`)
    ).toEqual([{ object_type: "skill", object_id: SKILL }]);
    await pg.exec(`DELETE FROM skills WHERE id = '${SKILL}'`);
    expect(await rows(`SELECT 1 FROM space_access`)).toEqual([]);
  });

  it("the baseline carries both tables; the coherence list names the new columns", () => {
    expect(BASELINE).toContain('CREATE TABLE IF NOT EXISTS "space_access"');
    expect(BASELINE).toContain(
      'CREATE TABLE IF NOT EXISTS "profile_workspace_access"'
    );
    const listed = REQUIRED_COLUMNS.filter(
      (c) => c.table === "space_access"
    ).map((c) => c.column);
    expect(listed).toEqual(["object_type", "object_id", "granted_by"]);
  });
});
