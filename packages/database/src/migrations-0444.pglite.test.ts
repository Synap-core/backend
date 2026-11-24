/**
 * REAL-POSTGRES (PGlite) test for migration 0444: a cron rule whose stored zone
 * Postgres does not know loses that zone (it fires in UTC, as before 0441), and
 * a rule the self-heal parked as 'error' for that zone goes back to active with
 * no stamp. A known zone, any case, and an error for another reason are kept.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const HERE = dirname(fileURLToPath(import.meta.url));
const M0444 = readFileSync(
  resolve(HERE, "../migrations/0444_cron_drop_unknown_timezone.sql"),
  "utf8"
);

const STAMP = "2026-11-21T06:50:00.000Z";
const zoneError = (expr: string, tz: string) =>
  `Unparseable cron schedule: "${expr}" in time zone "${tz}". Only 5-field cron (minute hour day-of-month month day-of-week) in an IANA time zone is supported.`;

const ROWS: Array<{
  id: string;
  triggerType: string;
  status: string;
  config: Record<string, unknown>;
  error?: string;
  stamp?: string | null;
}> = [
  {
    id: "paris",
    triggerType: "cron",
    status: "active",
    config: { expression: "50 6 * * *", timezone: "Europe/Paris" },
  },
  {
    id: "lower-paris",
    triggerType: "cron",
    status: "active",
    config: { expression: "50 6 * * *", timezone: "europe/paris" },
  },
  {
    id: "typo-live",
    triggerType: "cron",
    status: "active",
    config: { expression: "50 6 * * *", timezone: "Paris" },
    stamp: null,
  },
  {
    id: "local-paused",
    triggerType: "cron",
    status: "paused",
    config: { expression: "50 6 * * *", timezone: "local" },
  },
  {
    id: "typo-parked",
    triggerType: "cron",
    status: "error",
    config: { expression: "50 6 * * *", timezone: "Paris" },
    error: zoneError("50 6 * * *", "Paris"),
    stamp: null,
  },
  {
    id: "bad-expr",
    triggerType: "cron",
    status: "error",
    config: { expression: "@daily", timezone: "Europe/Paris" },
    error: zoneError("@daily", "Europe/Paris"),
    stamp: null,
  },
  {
    id: "other-error",
    triggerType: "cron",
    status: "error",
    config: { expression: "50 6 * * *", timezone: "Paris" },
    error: "Executor failed",
    stamp: null,
  },
  {
    id: "event",
    triggerType: "event",
    status: "active",
    config: { eventPattern: "entity.create.completed", timezone: "Paris" },
  },
];

let pg: PGlite;

async function rows(): Promise<
  Record<
    string,
    {
      status: string;
      tz: string | null;
      error: string | null;
      stamp: string | null;
    }
  >
> {
  const res = await pg.query<{
    id: string;
    status: string;
    tz: string | null;
    error_message: string | null;
    next_run_at: Date | null;
  }>(
    `SELECT id, status, trigger_config->>'timezone' AS tz, error_message, next_run_at FROM automations ORDER BY id`
  );
  return Object.fromEntries(
    res.rows.map((r) => [
      r.id,
      {
        status: r.status,
        tz: r.tz,
        error: r.error_message,
        stamp: r.next_run_at ? new Date(r.next_run_at).toISOString() : null,
      },
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
      error_message text,
      next_run_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  for (const r of ROWS) {
    await pg.query(
      `INSERT INTO automations (id, trigger_type, trigger_config, status, error_message, next_run_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6)`,
      [
        r.id,
        r.triggerType,
        JSON.stringify(r.config),
        r.status,
        r.error ?? null,
        r.stamp === undefined ? STAMP : r.stamp,
      ]
    );
  }
});

afterAll(async () => {
  await pg.close();
});

describe("0444: an unknown cron zone is dropped; a rule parked for it is live again", () => {
  const expected = {
    paris: { status: "active", tz: "Europe/Paris", error: null, stamp: STAMP },
    "lower-paris": {
      status: "active",
      tz: "europe/paris",
      error: null,
      stamp: STAMP,
    },
    "typo-live": { status: "active", tz: null, error: null, stamp: null },
    "local-paused": { status: "paused", tz: null, error: null, stamp: STAMP },
    "typo-parked": { status: "active", tz: null, error: null, stamp: null },
    "bad-expr": {
      status: "error",
      tz: "Europe/Paris",
      error: zoneError("@daily", "Europe/Paris"),
      stamp: null,
    },
    "other-error": {
      status: "error",
      tz: null,
      error: "Executor failed",
      stamp: null,
    },
    event: { status: "active", tz: "Paris", error: null, stamp: STAMP },
  };

  it("repairs only the cron rows whose zone Postgres does not know", async () => {
    await pg.exec(M0444);
    expect(await rows()).toEqual(expected);
  });

  it("runs twice with the same result", async () => {
    await pg.exec(M0444);
    expect(await rows()).toEqual(expected);
  });
});
