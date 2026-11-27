import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * pg-boss retention as pg-boss itself resolves it (decision ce5fb987).
 *
 * pg-boss 10 turns the constructor options into the intervals its maintenance
 * SQL uses (node_modules/pg-boss/src/attorney.js): `deleteAfter` is the
 * interval of `DELETE FROM pgboss.archive WHERE archived_on < now() - …`, and
 * `archiveInterval` the age at which a finished job leaves `pgboss.job`.
 * Reading the resolved config of the real instance (no connection is opened:
 * the pool is created only by `start()`) catches a misspelt option or a
 * pg-boss upgrade that stops reading it, which an echo of our own object
 * would not.
 */
const GLOBAL_KEY = "__synap_pg_boss__";
const SEVEN_DAYS = `${7 * 24 * 60 * 60} seconds`;

async function resolvedConfig(): Promise<Record<string, unknown>> {
  delete (globalThis as Record<string, unknown>)[GLOBAL_KEY];
  vi.resetModules();
  const { getBoss } = await import("../boss.js");
  const db = getBoss().getDb() as unknown as {
    config: Record<string, unknown>;
  };
  return db.config;
}

describe("pg-boss retention reaches pg-boss", () => {
  const saved = process.env.DATABASE_URL;

  beforeEach(() => {
    process.env.DATABASE_URL = "postgresql://u:p@127.0.0.1:1/none";
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved;
    delete (globalThis as Record<string, unknown>)[GLOBAL_KEY];
  });

  it("archived jobs are deleted after 7 days", async () => {
    expect((await resolvedConfig()).deleteAfter).toBe(SEVEN_DAYS);
  });

  it("finished jobs stay 7 days in pgboss.job (health.ts counts on it)", async () => {
    const config = await resolvedConfig();
    expect(config.archiveInterval).toBe(SEVEN_DAYS);
    expect(config.archiveFailedInterval).toBe(SEVEN_DAYS);
  });
});
