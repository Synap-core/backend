/**
 * test-ratchet-retry.mjs — re-run a NEW failure once, in the same job, before
 * the ratchet counts it.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 * 2026-10-28: a flaky test (conversation-change-feed.pglite.test.ts, finding
 * bf1e2ca6) turned the Full suite judge red through the ratchet's new-failure
 * rule, and its re-run cost a whole 20-minute shard. Prior art (pod document
 * da67c51b §4: Meta's PFS, Chromium's CQ): retry only the failed files, once,
 * in the same job; a pass after the retry is a FLAKE, reported, never a clean
 * green; a second failure is final.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────
 * A file is FLAKY only when all of these hold:
 *   - it failed in the first run (failed, or collected zero tests),
 *   - it is not in the baseline (baseline files are judged as today: a pass is
 *     `fixed`, a failure is expected),
 *   - the retry report CONTAINS it and says it passed with at least one test.
 * Anything else stays red: no retry report, a retry report without the file, a
 * second failure, a retry that collected nothing.
 * More than MAX_RETRY_FILES new failures in one job are not retried at all:
 * that many reds at once is a real break (or a broken environment), and a
 * retry would double the job's cost to say so.
 *
 * ── WHAT IT CANNOT SEE ──────────────────────────────────────────────────────
 * A test that fails only when run beside other files (shared database state,
 * ordering) and passes alone is reported FLAKY, not red. That is what a flake
 * is from the outside; it is listed in the judge summary so someone owns it.
 *
 * Self-contained (no imports): the judge job reads it without an install.
 */

export const MAX_RETRY_FILES = 10;

/** The report id of a run's retry. */
export const retryReportId = (reportId) => `${reportId}#retry`;

/**
 * vitest argv for re-running `files` (relative to the run's dir) under the
 * run's own configuration: every flag of the package script is kept, every
 * positional filter and the `--shard=` flag are dropped, the files are added.
 * Every package `test` script today is `vitest run` plus flags only
 * (`--passWithNoTests`); a tripwire run's args are its files.
 */
export function retryArgs(args, files) {
  return [
    ...args.filter((a) => a.startsWith("-") && !a.startsWith("--shard")),
    ...files,
  ];
}

/**
 * The files of one classified report (Map file → {ok}) that failed and are
 * not in the baseline.
 */
export function newFailures(files, baseline) {
  return [...files]
    .filter(([f, v]) => !v.ok && !baseline.has(f))
    .map(([f]) => f);
}

/**
 * Apply a retry to the first run's results. `files` is the first run (Map
 * file → {ok, reason}), `retried` the retry report's (same shape) or null when
 * there is none. Returns the results the ratchet judges and the flaky list.
 * Pure: neither input is mutated.
 */
export function applyRetry(files, retried, baseline) {
  const out = new Map(files);
  const flaky = [];
  if (!retried) return { files: out, flaky };
  for (const f of newFailures(files, baseline)) {
    const second = retried.get(f);
    if (second?.ok === true) {
      flaky.push({ file: f, firstReason: files.get(f).reason });
      out.set(f, { ok: true, reason: "", flaky: true });
    }
  }
  return { files: out, flaky };
}
