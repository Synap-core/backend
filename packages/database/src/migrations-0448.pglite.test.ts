/**
 * Migration 0448 on PGlite: `profile_workspace_access` becomes `space_access`.
 *  - existing kind grants survive as `object_type = 'profile'` rows, twice-run
 *    safe;
 *  - one object can be granted to a space once per type (the new key);
 *  - deleting a profile, playbook or skill removes its grants (the trigger
 *    that replaces the old cascade), and only that object's;
 *  - the baseline creates the same table and triggers; the boot coherence
 *    list names the new columns.
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
    CREATE INDEX "profile_workspace_access_workspace_idx"
      ON "profile_workspace_access" ("workspace_id");
    INSERT INTO workspaces VALUES ('${WS}'), ('${WS2}');
    INSERT INTO profiles VALUES ('${KIND}'), ('${KIND2}');
    INSERT INTO playbooks VALUES ('${PB}');
    INSERT INTO skills VALUES ('${SKILL}');
    INSERT INTO profile_workspace_access (profile_id, workspace_id)
      VALUES ('${KIND}', '${WS}'), ('${KIND2}', '${WS2}');
  `);
  await pg.exec(M0448);
  await pg.exec(M0448);
}, 60_000);
afterAll(async () => {
  await pg.close();
});

describe("migration 0448 — space_access", () => {
  it("keeps every kind grant as a profile row", async () => {
    const { rows } = await pg.query<{
      object_type: string;
      object_id: string;
      workspace_id: string;
    }>(
      `SELECT object_type, object_id, workspace_id FROM space_access ORDER BY object_id`
    );
    expect(rows).toEqual([
      { object_type: "profile", object_id: KIND, workspace_id: WS },
      { object_type: "profile", object_id: KIND2, workspace_id: WS2 },
    ]);
    const old = await pg.query<{ t: string | null }>(
      `SELECT to_regclass('public.profile_workspace_access')::text AS t`
    );
    expect(old.rows[0]!.t).toBeNull();
  });

  it("grants a playbook and a skill beside the kinds, once each", async () => {
    await pg.exec(`
      INSERT INTO space_access (object_type, object_id, workspace_id, granted_by)
      VALUES ('playbook', '${PB}', '${WS2}', 'u-1'), ('skill', '${SKILL}', '${WS2}', 'u-1');
    `);
    await expect(
      pg.exec(
        `INSERT INTO space_access (object_type, object_id, workspace_id) VALUES ('playbook', '${PB}', '${WS2}')`
      )
    ).rejects.toThrow();
    await expect(
      pg.exec(
        `INSERT INTO space_access (object_id, workspace_id) VALUES ('${PB}', '${WS}')`
      )
    ).rejects.toThrow();
  });

  it("a deleted object takes its grants with it, and only its own", async () => {
    await pg.exec(`DELETE FROM playbooks WHERE id = '${PB}'`);
    await pg.exec(`DELETE FROM profiles WHERE id = '${KIND}'`);
    const { rows } = await pg.query<{ object_type: string; object_id: string }>(
      `SELECT object_type, object_id FROM space_access ORDER BY object_type`
    );
    expect(rows).toEqual([
      { object_type: "profile", object_id: KIND2 },
      { object_type: "skill", object_id: SKILL },
    ]);
    await pg.exec(`DELETE FROM skills WHERE id = '${SKILL}'`);
    const after = await pg.query(
      `SELECT 1 FROM space_access WHERE object_type = 'skill'`
    );
    expect(after.rows).toEqual([]);
  });

  it("the baseline creates the same table and triggers; the coherence list names it", () => {
    expect(BASELINE).toContain('CREATE TABLE IF NOT EXISTS "space_access"');
    expect(BASELINE).not.toContain('profile_workspace_access"');
    for (const t of ["profiles", "playbooks", "skills"]) {
      expect(BASELINE).toContain(`trg_${t}_forget_space_access`);
    }
    const listed = REQUIRED_COLUMNS.filter(
      (c) => c.table === "space_access"
    ).map((c) => c.column);
    expect(listed).toEqual(["object_type", "object_id", "granted_by"]);
  });
});
