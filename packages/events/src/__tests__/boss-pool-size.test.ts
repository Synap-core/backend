import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * PGBOSS_POOL_SIZE must reach the `pg.Pool` pg-boss opens, or the pod's
 * Postgres connection budget (deploy/docker-compose.yml, summed by
 * deploy/__tests__/pg-connection-budget.test.sh) counts a number nothing
 * enforces: the update canary would still open pg-pool's default 10.
 *
 * pg-boss 10 builds its Db from the constructor config and hands that same
 * object to `new pg.Pool(config)` on start (node_modules/pg-boss/src/db.js),
 * so `getDb().config.max` is the cap the pool gets. No connection is opened:
 * the pool is created only by `start()`.
 */
const GLOBAL_KEY = "__synap_pg_boss__";

async function bossPoolMax(raw: string | undefined): Promise<unknown> {
  if (raw === undefined) delete process.env.PGBOSS_POOL_SIZE;
  else process.env.PGBOSS_POOL_SIZE = raw;
  delete (globalThis as Record<string, unknown>)[GLOBAL_KEY];
  vi.resetModules();
  const { getBoss } = await import("../boss.js");
  const db = getBoss().getDb() as unknown as { config: { max?: unknown } };
  return db.config.max;
}

describe("pg-boss pool size reaches pg-boss", () => {
  const saved = {
    url: process.env.DATABASE_URL,
    size: process.env.PGBOSS_POOL_SIZE,
  };

  beforeEach(() => {
    process.env.DATABASE_URL = "postgresql://u:p@127.0.0.1:1/none";
  });

  afterEach(() => {
    for (const [k, v] of [
      ["DATABASE_URL", saved.url],
      ["PGBOSS_POOL_SIZE", saved.size],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete (globalThis as Record<string, unknown>)[GLOBAL_KEY];
  });

  it("an explicit PGBOSS_POOL_SIZE is the pool's max", async () => {
    expect(await bossPoolMax("7")).toBe(7);
  });

  it("unset or invalid falls back to 10, the value the budget counts", async () => {
    expect(await bossPoolMax(undefined)).toBe(10);
    expect(await bossPoolMax("")).toBe(10);
    expect(await bossPoolMax("ten")).toBe(10);
    expect(await bossPoolMax("0")).toBe(10);
  });
});
