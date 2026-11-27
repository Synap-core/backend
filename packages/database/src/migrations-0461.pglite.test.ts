/**
 * REAL-POSTGRES (PGlite) test for migration 0461 — the devices registry
 * (devices plan 767a5978 §3, P1; decision 78fc3fa1):
 *   - creates `devices` with exactly the drizzle schema's columns, and
 *     `compute_leases.device_id`;
 *   - backfills ONE computer device per machine user that has a person
 *     behind it: kind computer, connection agent, its name and whose it is,
 *     its identity read from `agent_metadata`;
 *   - leaves people, agents and orphan machines alone;
 *   - runs twice to the same rows (idempotent), and one principal can never
 *     hold two devices;
 *   - refuses a kind that is not a slug or a connection mode it does not
 *     know, and accepts a NEW kind slug (no migration for a new kind);
 *   - the baseline carries the table and the boot coherence list names it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { devices } from "./schema/devices.js";
import { computeLeases } from "./schema/compute-leases.js";
import { REQUIRED_COLUMNS } from "./utils/schema-coherence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) =>
  readFileSync(resolve(HERE, "../migrations", f), "utf8");
const M0461 = read("0461_devices.sql");
const BASELINE = read("0000_baseline_schema.sql");

let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE users (
      id text PRIMARY KEY,
      name text,
      agent_type text,
      created_by_user_id text,
      agent_metadata jsonb,
      computer_belongs_to text,
      created_at timestamptz DEFAULT now()
    );
    CREATE TABLE compute_leases (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    INSERT INTO users (id, name, agent_type, created_by_user_id, agent_metadata, computer_belongs_to) VALUES
      ('person', 'Ada', NULL, NULL, NULL, NULL),
      ('mac', 'Mac', 'machine', 'person',
        '{"hostname":"mac.local","platform":"darwin","arch":"arm64","runsScripts":true}', 'person'),
      ('devbox', '  ', 'machine', 'person',
        '{"hostname":"devbox","platform":"linux"}', 'shared'),
      ('bare', NULL, 'machine', 'person', NULL, NULL),
      ('orphan', 'lost', 'machine', NULL, '{"hostname":"x"}', NULL),
      ('claude', 'Claude Code', 'claude-code', 'person', '{"hostname":"mac"}', NULL);
  `);
  await pg.exec(M0461);
  await pg.exec(M0461);
}, 60_000);
afterAll(async () => {
  await pg.close();
});

describe("migration 0461 — devices", () => {
  it("creates devices with the drizzle columns, and compute_leases.device_id", async () => {
    const cols = await pg.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'devices'`
    );
    expect(cols.rows.map((r) => r.column_name).sort()).toEqual(
      getTableConfig(devices)
        .columns.map((c) => c.name)
        .sort()
    );
    const lease = await pg.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'compute_leases' AND column_name = 'device_id'`
    );
    expect(lease.rows).toHaveLength(1);
    expect(getTableConfig(computeLeases).columns.map((c) => c.name)).toContain(
      "device_id"
    );
  });

  it("backfills one computer per machine user with a person, and only those", async () => {
    const { rows } = await pg.query<{
      principal_user_id: string;
      owner_user_id: string;
      kind: string;
      name: string;
      belongs_to: string;
      connection: { mode: string };
      manifest: { manifestVersion: number; identity: Record<string, string> };
      last_report_at: string | null;
    }>(
      `SELECT principal_user_id, owner_user_id, kind, name, belongs_to,
              connection, manifest, last_report_at
       FROM devices ORDER BY principal_user_id`
    );
    // Ran twice: still one row per computer, none for people, agents or
    // a machine nobody owns.
    expect(rows.map((r) => r.principal_user_id)).toEqual([
      "bare",
      "devbox",
      "mac",
    ]);
    const mac = rows.find((r) => r.principal_user_id === "mac")!;
    expect(mac).toMatchObject({
      owner_user_id: "person",
      kind: "computer",
      name: "Mac",
      belongs_to: "person",
      connection: { mode: "agent" },
      last_report_at: null,
    });
    expect(mac.manifest).toEqual({
      manifestVersion: 1,
      identity: { hostname: "mac.local", os: "darwin", arch: "arm64" },
    });
    const devbox = rows.find((r) => r.principal_user_id === "devbox")!;
    // A blank name falls back to the hostname; whose it is is copied.
    expect(devbox).toMatchObject({ name: "devbox", belongs_to: "shared" });
    expect(devbox.manifest.identity).toEqual({ hostname: "devbox", os: "linux" });
    const bare = rows.find((r) => r.principal_user_id === "bare")!;
    expect(bare).toMatchObject({ name: "Computer", belongs_to: "person" });
    expect(bare.manifest.identity).toEqual({});
  });

  it("holds one device per principal", async () => {
    await expect(
      pg.query(
        `INSERT INTO devices (owner_user_id, kind, name, principal_user_id, connection)
         VALUES ('person', 'computer', 'twin', 'mac', '{"mode":"agent"}')`
      )
    ).rejects.toThrow(/devices_principal_uidx/);
  });

  it("refuses a kind that is not a slug and a mode it does not know; a new kind slug passes", async () => {
    const insert = (kind: string, connection: string) =>
      pg.query(
        `INSERT INTO devices (owner_user_id, kind, name, connection)
         VALUES ('person', $1, 'thing', $2::jsonb)`,
        [kind, connection]
      );
    await expect(insert("Printer!", '{"mode":"manual"}')).rejects.toThrow(
      /devices_kind_check/
    );
    await expect(insert("printer", '{"mode":"usb"}')).rejects.toThrow(
      /devices_connection_mode_check/
    );
    await expect(insert("drone", '{"mode":"manual"}')).resolves.toBeDefined();
  });

  it("the baseline carries the table and the lease column; the boot check names them", () => {
    expect(BASELINE).toContain('CREATE TABLE IF NOT EXISTS "devices"');
    expect(BASELINE).toContain(
      'ALTER TABLE "compute_leases" ADD COLUMN IF NOT EXISTS "device_id" uuid'
    );
    expect(BASELINE).toContain('"devices_principal_uidx"');
    const named = REQUIRED_COLUMNS.filter(
      (c) => c.addedBy === "0461_devices.sql"
    ).map((c) => `${c.table}.${c.column}`);
    expect(named).toEqual(
      expect.arrayContaining([
        "devices.principal_user_id",
        "compute_leases.device_id",
      ])
    );
  });
});
