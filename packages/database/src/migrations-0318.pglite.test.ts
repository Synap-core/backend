/**
 * REAL-POSTGRES (PGlite) proof for migration 0318 — the visible backfill
 * before deny by default (P5): every key that NEVER had a grant row gets one
 * explicit `{"*"}` "Full access (before limits)" grant; nothing else moves.
 *
 * Runs the SQL files themselves (0305 grants + 0307 role_id + 0318) over a
 * minimal api_keys table and asserts:
 *   - a never-granted key gets exactly one `*` grant carrying the key's
 *     expiry, holder, human (linked_user_id) and creator;
 *   - a key with a LIVE grant, and a key whose grants were all REVOKED, get
 *     nothing (the revoked one stays deny-all — never widened);
 *   - a revoked key's backfilled grant is revoked with it;
 *   - re-running it inserts nothing.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const HERE = dirname(fileURLToPath(import.meta.url));
const sqlFile = (name: string) =>
  readFileSync(resolve(HERE, "../migrations", name), "utf8");
const M0318 = sqlFile("0318_grants_backfill_full_access.sql");

const PLAIN = "00000000-0000-4000-8000-000000000001";
const AGENT = "00000000-0000-4000-8000-000000000002";
const LIVE = "00000000-0000-4000-8000-000000000003";
const ENDED = "00000000-0000-4000-8000-000000000004";
const REVOKED_KEY = "00000000-0000-4000-8000-000000000005";
const EXPIRES = "2027-01-01T00:00:00.000Z";

let pg: PGlite;

interface GrantRow {
  api_key_id: string;
  principal_user_id: string;
  on_behalf_of: string;
  permissions: string[];
  workspace_ids: string[] | null;
  project_ids: string[] | null;
  entity_ids: string[] | null;
  expires_at: Date | null;
  label: string | null;
  client_id: string | null;
  role_id: string | null;
  created_by: string;
  revoked_at: Date | null;
  revoked_by: string | null;
}

const grantsOf = async (keyId: string) =>
  (
    await pg.query<GrantRow>(
      `SELECT * FROM grants WHERE api_key_id = $1 ORDER BY created_at`,
      [keyId]
    )
  ).rows;
const total = async () =>
  (await pg.query<{ n: number }>(`SELECT count(*)::int n FROM grants`)).rows[0]
    .n;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE api_keys (
      id uuid PRIMARY KEY,
      user_id text NOT NULL,
      linked_user_id text,
      expires_at timestamptz,
      revoked_at timestamptz,
      revoked_by text
    );
  `);
  await pg.exec(sqlFile("0305_grants.sql"));
  await pg.exec(sqlFile("0307_grant_roles.sql"));
  await pg.query(
    `INSERT INTO api_keys (id, user_id, linked_user_id, expires_at, revoked_at, revoked_by) VALUES
      ($1, 'human-1', NULL, $6, NULL, NULL),
      ($2, 'agent-1', 'human-1', NULL, NULL, NULL),
      ($3, 'human-1', NULL, NULL, NULL, NULL),
      ($4, 'human-1', NULL, NULL, NULL, NULL),
      ($5, 'human-2', NULL, NULL, now(), 'human-2')`,
    [PLAIN, AGENT, LIVE, ENDED, REVOKED_KEY, EXPIRES]
  );
  await pg.query(
    `INSERT INTO grants (api_key_id, principal_user_id, on_behalf_of, permissions, created_by, revoked_at)
     VALUES ($1, 'human-1', 'human-1', ARRAY['entity.read'], 'human-1', NULL),
            ($2, 'human-1', 'human-1', ARRAY['entity.read'], 'human-1', now())`,
    [LIVE, ENDED]
  );
  await pg.exec(M0318);
});

describe("migration 0318 — backfill Full access for never-granted keys", () => {
  it("a never-granted key gets ONE explicit `*` grant with the key's expiry", async () => {
    const rows = await grantsOf(PLAIN);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      principal_user_id: "human-1",
      on_behalf_of: "human-1",
      permissions: ["*"],
      workspace_ids: null,
      project_ids: null,
      entity_ids: null,
      label: "Full access (before limits)",
      client_id: null,
      role_id: null,
      created_by: "human-1",
      revoked_at: null,
    });
    expect(new Date(rows[0].expires_at!).toISOString()).toBe(EXPIRES);
  });

  it("an agent key's grant is on behalf of its human, held by the agent", async () => {
    const [row] = await grantsOf(AGENT);
    expect(row).toMatchObject({
      principal_user_id: "agent-1",
      on_behalf_of: "human-1",
      created_by: "agent-1",
      expires_at: null,
    });
  });

  // Rules out: backfilling a key whose grants all ended — that would turn a
  // revocation into a widening.
  it("keys that already hold rows (live OR revoked) get nothing", async () => {
    expect((await grantsOf(LIVE)).map((g) => g.permissions)).toEqual([
      ["entity.read"],
    ]);
    const ended = await grantsOf(ENDED);
    expect(ended).toHaveLength(1);
    expect(ended[0].permissions).toEqual(["entity.read"]);
    expect(ended[0].revoked_at).not.toBeNull();
  });

  it("a revoked key's backfilled grant is revoked with it", async () => {
    const [row] = await grantsOf(REVOKED_KEY);
    expect(row.permissions).toEqual(["*"]);
    expect(row.revoked_at).not.toBeNull();
    expect(row.revoked_by).toBe("human-2");
  });

  it("is idempotent: a second run inserts nothing", async () => {
    const before = await total();
    expect(before).toBe(5);
    await pg.exec(M0318);
    expect(await total()).toBe(before);
  });
});
