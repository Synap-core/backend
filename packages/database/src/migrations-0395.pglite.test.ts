/**
 * REAL-POSTGRES (PGlite) test for migration 0395 — agents inside a computer
 * (plan "Computer once, agents inside" rev 3, pod document 31470fd5, D1):
 * `users.host_seat`, `users.agent_role`, folded into 0320's identity index,
 * and the device request's new fields.
 *
 * Pinned: on a pod at 0320 with agents on computers, the migration runs
 * twice, builds the new index over existing rows without a collision, and
 * drops 0320's; afterwards two OS users (seats) and two jobs (roles) of one
 * engine on one computer coexist, a true duplicate is refused, and computers
 * stay outside the index. The baseline and the migration match the drizzle
 * schema on both tables, and the boot coherence list names every column.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { users } from "./schema/users.js";
import { deviceAuthRequests } from "./schema/device-auth-requests.js";
import { REQUIRED_COLUMNS } from "./utils/schema-coherence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) =>
  readFileSync(resolve(HERE, "../migrations", f), "utf8");
const M0395 = read("0395_agents_inside_a_computer.sql");
const M0320_INDEX = read("0320_machine_identity.sql").match(
  /CREATE UNIQUE INDEX IF NOT EXISTS idx_users_service_agent_creator_type_host_unique[\s\S]*?;/
)![0];
const BASELINE = read("0000_baseline_schema.sql");

const USERS_BLOCK = BASELINE.slice(
  BASELINE.indexOf("-- ─── 1. users"),
  BASELINE.indexOf("-- ─── 2. workspaces")
);
const DEVICE_BLOCK = BASELINE.slice(
  BASELINE.indexOf("-- device_auth_requests — the device door"),
  BASELINE.indexOf("-- key_requests — the CLI's door to a key")
);
const NEW_DEVICE_COLUMNS = [
  "seat",
  "seat_id",
  "held",
  "requested_rows",
  "agent_actions",
];

/** The same blocks as a pod before 0395 had them. */
const before = (block: string) =>
  block
    .split("\n")
    .filter(
      (l) =>
        !l.includes("host_seat") &&
        !l.includes("agent_role") &&
        !l.startsWith("-- 0395") &&
        !l.startsWith("-- (person, type, computer, seat, role)") &&
        !NEW_DEVICE_COLUMNS.some((c) => l.trim().startsWith(`"${c}" `))
    )
    .join("\n");

/** What 0038 / 0228 / 0320 added to users that the baseline's block predates. */
const AGENT_COLUMNS = `
  ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "agent_type" text;
  ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "agent_template" text;
  ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_personal_agent" boolean DEFAULT false;
  ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "created_by_user_id" text;
`;

const columns = async (client: PGlite, table: string) =>
  (
    await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
      [table]
    )
  ).rows.map((r) => r.column_name);

const indexes = async (client: PGlite) =>
  (
    await client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'users'`
    )
  ).rows.map((r) => r.indexname);

async function podAt0320(): Promise<PGlite> {
  const pg = new PGlite();
  await pg.exec(before(USERS_BLOCK));
  await pg.exec(AGENT_COLUMNS);
  await pg.exec(before(DEVICE_BLOCK));
  await pg.exec(M0320_INDEX);
  // devbox with two agents of the person (Claude Code, Codex), the same
  // engine with no computer, and the computer itself.
  await pg.exec(`
    INSERT INTO users (id, email, user_type, agent_type, created_by_user_id, host_user_id) VALUES
      ('p', 'p@x', 'human', NULL, NULL, NULL),
      ('m-devbox', 'm@x', 'agent', 'machine', 'p', NULL),
      ('a-crm', 'a1@x', 'agent', 'claude-code', 'p', 'm-devbox'),
      ('a-codex', 'a2@x', 'agent', 'codex', 'p', 'm-devbox'),
      ('a-nohost', 'a3@x', 'agent', 'claude-code', 'p', NULL);
  `);
  return pg;
}

const insertAgent = (
  pg: PGlite,
  id: string,
  seat: string | null,
  role: string | null,
  type = "claude-code"
) =>
  pg.query(
    `INSERT INTO users (id, email, user_type, agent_type, created_by_user_id, host_user_id, host_seat, agent_role)
     VALUES ($1, $1 || '@x', 'agent', $2, 'p', 'm-devbox', $3, $4)`,
    [id, type, seat, role]
  );

describe("migration 0395 — agents inside a computer", () => {
  it("builds the new identity index over existing agents, twice, and drops 0320's", async () => {
    const pg = await podAt0320();
    expect(await columns(pg, "users")).not.toContain("host_seat");
    await pg.exec(M0395);
    await pg.exec(M0395);
    const idx = await indexes(pg);
    expect(idx).toContain("idx_users_service_agent_identity_unique");
    expect(idx).not.toContain(
      "idx_users_service_agent_creator_type_host_unique"
    );
    // Nothing moved: every existing row has no seat and no job.
    const { rows } = await pg.query<{ n: number }>(
      `SELECT count(*)::int n FROM users WHERE host_seat IS NOT NULL OR agent_role IS NOT NULL`
    );
    expect(rows[0]!.n).toBe(0);
    for (const c of NEW_DEVICE_COLUMNS)
      expect(await columns(pg, "device_auth_requests")).toContain(c);
    await pg.close();
  });

  it("two seats and two jobs of one engine coexist; a true duplicate is refused", async () => {
    const pg = await podAt0320();
    // Before 0395 a second Claude Code on devbox is impossible whatever it is for.
    await pg.exec(M0395);
    await insertAgent(pg, "a-agent-seat", "agent", null);
    await insertAgent(pg, "a-crm-job", "antoine", "crm-worker");
    await insertAgent(pg, "a-dev-job", "antoine", "dev-worker");
    await expect(
      insertAgent(pg, "a-dev-twin", "antoine", "dev-worker")
    ).rejects.toThrow(/idx_users_service_agent_identity_unique/);
    // The seat-less, job-less agent is still one: a second one is refused.
    await expect(insertAgent(pg, "a-crm-twin", null, null)).rejects.toThrow(
      /idx_users_service_agent_identity_unique/
    );
    // Computers stay out of the index: a person has several.
    await pg.exec(
      `INSERT INTO users (id, email, user_type, agent_type, created_by_user_id) VALUES ('m-2', 'm2@x', 'agent', 'machine', 'p')`
    );
    await pg.close();
  });

  it("the baseline and the migration match the schema, and the coherence list names every column", async () => {
    const userCols = getTableConfig(users).columns.map((c) => c.name);
    const deviceCols = getTableConfig(deviceAuthRequests).columns.map(
      (c) => c.name
    );
    expect(userCols).toEqual(
      expect.arrayContaining(["host_seat", "agent_role"])
    );
    expect(deviceCols).toEqual(expect.arrayContaining(NEW_DEVICE_COLUMNS));
    const base = new PGlite();
    await base.exec(USERS_BLOCK);
    await base.exec(AGENT_COLUMNS);
    await base.exec(DEVICE_BLOCK);
    expect(await columns(base, "users")).toEqual(
      expect.arrayContaining(["host_seat", "agent_role"])
    );
    expect(await columns(base, "device_auth_requests")).toEqual(
      expect.arrayContaining(NEW_DEVICE_COLUMNS)
    );
    await base.exec(M0395);
    await base.close();
    for (const [table, column] of [
      ["users", "host_seat"],
      ["users", "agent_role"],
      ...NEW_DEVICE_COLUMNS.map((c) => ["device_auth_requests", c] as const),
    ])
      expect(
        REQUIRED_COLUMNS.some(
          (r) =>
            r.table === table &&
            r.column === column &&
            r.addedBy === "0395_agents_inside_a_computer.sql"
        )
      ).toBe(true);
  });
});
