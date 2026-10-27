/**
 * test-ratchet-shards.mjs — split the Full suite across parallel CI jobs.
 *
 * Measured 2026-10-27 (Full suite job 122274134527): of the ratchet's ~38 min,
 * packages/api (1,950 files) was the whole critical path; every other package
 * finished in its shadow. So only packages/api is split, with vitest's own
 * `--shard=k/N`; the other packages and the root tripwires run once, in shard 1.
 *
 * Each shard job writes its reports; one final job ("Full suite") reads them
 * all with `test-ratchet.mjs --reports=DIR --shards=N` and judges exactly as a
 * single run would. A missing shard report reads as no report: the judge goes
 * red (`no-report`), never green on a partial run.
 *
 * Self-contained (no imports) so the judge job needs no `pnpm install`.
 */

/** Packages split across shards; every other package runs in shard 1. */
export const SHARDED_DIRS = ["packages/api"];

/** "2/4" → { k: 2, n: 4 }; undefined → null; anything else throws. */
export function parseShard(value) {
  if (value === undefined) return null;
  const m = /^(\d+)\/(\d+)$/.exec(value);
  const k = m && Number(m[1]);
  const n = m && Number(m[2]);
  if (!m || n < 1 || k < 1 || k > n)
    throw new Error(`--shard must be k/N with 1 <= k <= N, got "${value}"`);
  return { k, n };
}

/**
 * The runs one shard executes. `runs` are the ratchet's package runs; a
 * sharded package gets `--shard=k/N` and a per-shard report id.
 */
export function runsForShard(runs, shard) {
  if (!shard) return runs;
  return runs.flatMap((r) => {
    if (SHARDED_DIRS.includes(r.dir))
      return [
        {
          ...r,
          reportId: shardReportId(r.id, shard.k),
          args: [...r.args, `--shard=${shard.k}/${shard.n}`],
        },
      ];
    return shard.k === 1 ? [r] : [];
  });
}

export const shardReportId = (id, k) => `${id}#shard${k}`;

/**
 * One vitest JSON report from a sharded package's N reports, or null when any
 * shard's report is missing (the suite crashed or the shard never ran).
 */
export function mergeShardReports(reports) {
  if (reports.length === 0 || reports.some((r) => !r)) return null;
  return {
    testResults: reports.flatMap((r) => r.testResults ?? []),
    numTotalTests: reports.reduce((s, r) => s + (r.numTotalTests ?? 0), 0),
    numPassedTests: reports.reduce((s, r) => s + (r.numPassedTests ?? 0), 0),
  };
}
