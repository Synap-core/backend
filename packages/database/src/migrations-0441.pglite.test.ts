/**
 * REAL-POSTGRES (PGlite) test for migration 0441 — a cron automation fires in
 * the zone it names (ticket 592930c8). A live cron row whose `triggerConfig`
 * names a zone other than UTC loses its UTC-computed `next_run_at`, so the
 * scheduler's self-heal stamps it again in its own zone. Every other row keeps
 * its stamp: a UTC row, a row with no zone, a paused row, an event row.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const HERE = dirname(fileURLToPath(import.meta.url));
const M0441 = readFileSync(
  resolve(HERE, "../migrations/0441_cron_next_run_in_its_timezone.sql"),
  "utf8"
);

const STAMP = "2026-11-21T06:50:00.000Z";

const ROWS: Array<{
  id: string;
  triggerType: string;
  status: string;
  config: Record<string, unknown>;
}> = [
  {
    id: "paris",
    triggerType: "cron",
    status: "active",
    config: { expression: "50 6 * * *", timezone: "Europe/Paris" },
  },
  {
    id: "utc",
    triggerType: "cron",
    status: "active",
    config: { expression: "50 6 * * *", timezone: "UTC" },
  },
  {
    id: "no-zone",
    triggerType: "cron",
    status: "active",
    config: { expression: "50 6 * * *" },
  },
  {
    id: "paused-paris",
    triggerType: "cron",
    status: "paused",
    config: { expression: "50 6 * * *", timezone: "Europe/Paris" },
  },
  {
    id: "event",
    triggerType: "event",
    status: "active",
    config: {
      eventPattern: "entity.create.completed",
      timezone: "Europe/Paris",
    },
  },
];

let pg: PGlite;

async function stamps(): Promise<Record<string, string | null>> {
  const res = await pg.query<{ id: string; next_run_at: Date | null }>(
    `SELECT id, next_run_at FROM automations ORDER BY id`
  );
  return Object.fromEntries(
    res.rows.map((r) => [
      r.id,
      r.next_run_at ? new Date(r.next_run_at).toISOString() : null,
    ])
  );
}

beforeAll(async () => {
  pg = new PGlite();
  // The columns the migration reads and writes, as they stand on main.
  await pg.exec(`
    CREATE TABLE automations (
      id text PRIMARY KEY,
      trigger_type text NOT NULL,
      trigger_config jsonb NOT NULL DEFAULT '{}'::jsonb,
      status text NOT NULL,
      next_run_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  for (const r of ROWS) {
    await pg.query(
      `INSERT INTO automations (id, trigger_type, trigger_config, status, next_run_at)
       VALUES ($1, $2, $3::jsonb, $4, $5)`,
      [r.id, r.triggerType, JSON.stringify(r.config), r.status, STAMP]
    );
  }
});

afterAll(async () => {
  await pg.close();
});

describe("0441 — a live cron row in another zone is handed back to the self-heal", () => {
  it("clears only the live cron row whose zone is not UTC", async () => {
    await pg.exec(M0441);
    expect(await stamps()).toEqual({
      event: STAMP,
      "no-zone": STAMP,
      paris: null,
      "paused-paris": STAMP,
      utc: STAMP,
    });
  });

  it("runs twice with the same result", async () => {
    await pg.exec(M0441);
    expect((await stamps()).paris).toBeNull();
    expect((await stamps()).utc).toBe(STAMP);
  });
});
