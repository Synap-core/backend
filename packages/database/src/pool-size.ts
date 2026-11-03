/**
 * The cap of this process's postgres.js/Drizzle pool, from `DB_POOL_SIZE`.
 *
 * A value that does not parse to a positive integer (unset, "", "abc", "0",
 * "-3") falls back to the default. It used to reach postgres.js as is: `NaN` or `0`, a
 * pool the connection budget (deploy/__tests__/pg-connection-budget.test.sh)
 * never counted. Same rule as `pgBossPoolSize` (packages/events boss.ts).
 */
export const DEFAULT_DB_POOL_SIZE = 50;

export function dbPoolSize(raw = process.env.DB_POOL_SIZE): number {
  const n = parseInt(raw || "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DB_POOL_SIZE;
}
