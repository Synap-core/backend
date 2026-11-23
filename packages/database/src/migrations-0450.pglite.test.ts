/**
 * Migration 0450 on PGlite: agents hold no membership.
 *  - every agent `workspace_members` and `project_members` row is deleted; a
 *    person's rows stay;
 *  - a pending workspace join an agent filed ends `expired` with the
 *    `data.ended` stamp, its own data kept; other proposals are untouched;
 *  - a second run changes nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const HERE = dirname(fileURLToPath(import.meta.url));
const M0450 = readFileSync(
  resolve(HERE, "../migrations/0450_agents_hold_no_membership.sql"),
  "utf8"
);

const WS = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const JOIN = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";
const DECIDED_JOIN = "55555555-5555-4555-8555-555555555555";

let pg: PGlite;
const rows = async <T>(sql: string) => (await pg.query<T>(sql)).rows;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE "users" ("id" text PRIMARY KEY, "user_type" text NOT NULL);
    CREATE TABLE "workspace_members" (
      "id" serial PRIMARY KEY, "workspace_id" uuid NOT NULL,
      "user_id" text NOT NULL, "role" text NOT NULL
    );
    CREATE TABLE "project_members" (
      "id" serial PRIMARY KEY, "project_id" uuid NOT NULL,
      "user_id" text NOT NULL, "role" text NOT NULL
    );
    CREATE TABLE "proposals" (
      "id" uuid PRIMARY KEY, "status" text NOT NULL, "target_type" text,
      "proposal_type" text, "data" jsonb, "updated_at" timestamptz
    );
    INSERT INTO users VALUES ('person', 'human'), ('agent', 'agent'), ('capture', 'agent');
    INSERT INTO workspace_members (workspace_id, user_id, role) VALUES
      ('${WS}', 'person', 'owner'), ('${WS}', 'agent', 'admin'), ('${WS}', 'capture', 'editor');
    INSERT INTO project_members (project_id, user_id, role) VALUES
      ('${PROJECT}', 'person', 'editor'), ('${PROJECT}', 'agent', 'editor');
    INSERT INTO proposals (id, status, target_type, proposal_type, data) VALUES
      ('${JOIN}', 'pending', 'workspace', 'join', '{"role":"editor"}'),
      ('${OTHER}', 'pending', 'entity', 'create', '{}'),
      ('${DECIDED_JOIN}', 'approved', 'workspace', 'join', '{}');
  `);
  await pg.exec(M0450);
}, 60_000);
afterAll(async () => {
  await pg.close();
});

describe("migration 0450 — agents hold no membership", () => {
  it("deletes every agent seat and keeps the person's", async () => {
    expect(
      await rows(`SELECT user_id, role FROM workspace_members ORDER BY user_id`)
    ).toEqual([{ user_id: "person", role: "owner" }]);
    expect(await rows(`SELECT user_id FROM project_members`)).toEqual([
      { user_id: "person" },
    ]);
  });

  it("ends a pending agent join as expired, stamped, its data kept", async () => {
    const byId = new Map(
      (
        await rows<{ id: string; status: string; data: unknown }>(
          `SELECT id, status, data FROM proposals`
        )
      ).map((r) => [r.id, r])
    );
    expect(byId.get(JOIN)?.status).toBe("expired");
    expect(byId.get(JOIN)?.data).toMatchObject({
      role: "editor",
      ended: { reason: "lapsed", by: "system" },
    });
    expect(byId.get(OTHER)?.status).toBe("pending");
    expect(byId.get(DECIDED_JOIN)?.status).toBe("approved");
  });

  it("is idempotent", async () => {
    const before = await rows(
      `SELECT 'wm' AS t, user_id, role FROM workspace_members
       UNION ALL SELECT 'p', id::text, status FROM proposals ORDER BY 1, 2`
    );
    await pg.exec(M0450);
    expect(
      await rows(
        `SELECT 'wm' AS t, user_id, role FROM workspace_members
         UNION ALL SELECT 'p', id::text, status FROM proposals ORDER BY 1, 2`
      )
    ).toEqual(before);
  });
});
