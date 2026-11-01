/**
 * REAL-POSTGRES (PGlite) test for migration 0388 — `users.computer_belongs_to`
 * (whose computer it is, computers plan v2 §4 K3) and the approver's pending
 * choice on `device_auth_requests`.
 *
 * Pinned: the migration runs twice; every existing computer reads 'person'
 * and no other row is touched; the CHECK refuses any other value; the
 * baseline and the migration both match the drizzle schema on both tables,
 * and the boot coherence list names both columns.
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
const M0388 = read("0388_computer_belongs_to.sql");
const BASELINE = read("0000_baseline_schema.sql");

const USERS_BLOCK = BASELINE.slice(
  BASELINE.indexOf("-- ─── 1. users"),
  BASELINE.indexOf("-- ─── 2. workspaces")
);
const DEVICE_BLOCK = BASELINE.slice(
  BASELINE.indexOf("-- device_auth_requests — the device door"),
  BASELINE.indexOf("-- key_requests — the CLI's door to a key")
);

/** The same blocks as a pod before 0388 had them. */
const withoutNewColumn = (block: string) =>
  block
    .replace(/-- 0388:[\s\S]*?END \$\$;\n/, "")
    .split("\n")
    .filter((l) => !l.includes("computer_belongs_to"))
    .join("\n");

const columns = async (client: PGlite, table: string) =>
  (
    await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
      [table]
    )
  ).rows.map((r) => r.column_name);

describe("migration 0388 — users.computer_belongs_to", () => {
  it("backfills every computer to 'person', touches nothing else, twice without error", async () => {
    const pg = new PGlite();
    await pg.exec(withoutNewColumn(USERS_BLOCK));
    // 0038 promoted agent_type to a column; the baseline's users block predates it.
    await pg.exec(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "agent_type" text`
    );
    await pg.exec(withoutNewColumn(DEVICE_BLOCK));
    expect(await columns(pg, "users")).not.toContain("computer_belongs_to");
    await pg.exec(`
      INSERT INTO users (id, email, user_type, agent_type) VALUES
        ('m-mac', 'm1@synap.agent', 'agent', 'machine'),
        ('m-devbox', 'm2@synap.agent', 'agent', 'machine'),
        ('a-claude', 'a@synap.agent', 'agent', 'claude-code'),
        ('p-person', 'p@example.com', 'human', NULL);
    `);

    await pg.exec(M0388);
    await pg.exec(M0388);

    const { rows } = await pg.query<{
      id: string;
      computer_belongs_to: string | null;
    }>(`SELECT id, computer_belongs_to FROM users ORDER BY id`);
    expect(rows).toEqual([
      { id: "a-claude", computer_belongs_to: null },
      { id: "m-devbox", computer_belongs_to: "person" },
      { id: "m-mac", computer_belongs_to: "person" },
      { id: "p-person", computer_belongs_to: null },
    ]);
    expect(await columns(pg, "device_auth_requests")).toContain(
      "computer_belongs_to"
    );
    await pg.close();
  });

  it("refuses a value that is not person, agent or shared", async () => {
    const pg = new PGlite();
    await pg.exec(USERS_BLOCK);
    await pg.exec(
      `INSERT INTO users (id, email, computer_belongs_to) VALUES ('m', 'm@x', 'agent')`
    );
    await expect(
      pg.exec(
        `INSERT INTO users (id, email, computer_belongs_to) VALUES ('n', 'n@x', 'own')`
      )
    ).rejects.toThrow(/users_computer_belongs_to_check/);
    await pg.close();
  });

  it("the baseline and the migration match the schema, and the coherence list names both columns", async () => {
    for (const [table, block, cols] of [
      ["users", USERS_BLOCK, getTableConfig(users).columns],
      [
        "device_auth_requests",
        DEVICE_BLOCK,
        getTableConfig(deviceAuthRequests).columns,
      ],
    ] as const) {
      expect(cols.map((c) => c.name)).toContain("computer_belongs_to");
      const base = new PGlite();
      await base.exec(USERS_BLOCK);
      await base.exec(
        `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "agent_type" text`
      );
      if (table !== "users") await base.exec(block);
      expect(await columns(base, table)).toContain("computer_belongs_to");
      await base.exec(M0388);
      await base.close();
      expect(
        REQUIRED_COLUMNS.some(
          (r) =>
            r.table === table &&
            r.column === "computer_belongs_to" &&
            r.addedBy === "0388_computer_belongs_to.sql"
        )
      ).toBe(true);
    }
  });
});
