#!/usr/bin/env node
/**
 * MINIMUM-PASSING-TEST FLOOR — the gate that makes a green test run mean something.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 * A test suite can report success while executing nothing. Measured in this repo
 * on 2026-08-03:
 *
 *   cd packages/database && npx vitest run --reporter=json
 *   → numTotalTests: 475  numPassedTests: 0  numFailedTests: 0  numPendingTests: 475
 *
 * Zero tests ran. Zero failures were reported. Every tool and every human that
 * reads "failed tests: 0" concludes green — over 475 unexecuted tests. Only the
 * `success: false` flag disagrees, and almost nothing reads it.
 *
 * There are three ways a suite goes silently blind, and `pnpm test`'s exit code
 * catches NONE of them reliably:
 *
 *   1. EVERYTHING SKIPPED — total > 0 but passed === 0 (the 475 case above).
 *   2. A FILE COLLECTED NOTHING — an import error or a bad `vi.mock` makes a file
 *      contribute 0 assertions. vitest does NOT count those toward numFailedTests,
 *      so a file can stop testing anything and the failure count stays 0.
 *      Three such files exist in packages/api right now (see `quarantine` below).
 *   3. TESTS SILENTLY DISAPPEARED — someone narrows an `include` glob, deletes a
 *      describe block, or moves a file out of the lane. Count goes down; nothing
 *      goes red.
 *
 * This script catches all three. It runs each entry in `test-floors.json` with
 * `--reporter=json` and FAILS when:
 *
 *   - numPassedTests < that entry's FLOOR                       (class 3)
 *   - any test file reports assertionResults.length === 0       (class 2)
 *   - numTotalTests > 0 && numPassedTests === 0                 (class 1)
 *   - the runner produced no parseable JSON at all              (suite crashed)
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────────
 * It does not fail merely because tests FAILED. Ordinary failures are already
 * caught loudly by `pnpm test` (vitest's own exit code), which CI runs. Failure
 * counts are printed here for context, not gated on — duplicating that gate would
 * only make this one noisy enough to be ignored.
 *
 * ── USAGE ────────────────────────────────────────────────────────────────────
 *   node scripts/test-floor.mjs               # gate (this is `pnpm test:floor`)
 *   node scripts/test-floor.mjs --record      # re-measure and rewrite the floors
 *   node scripts/test-floor.mjs --only=@synap/jobs
 *   SYNAP_TEST_ALLOW_BLIND=1 node scripts/test-floor.mjs
 *       ↑ downgrades "this entry needs Postgres and executed 0 tests" from an
 *         error to a loud warning. For laptops with no local Postgres ONLY.
 *         CI must never set it — in CI that condition means genuinely broken.
 *
 * ── FLOORS ARE MEASURED, NEVER GUESSED ───────────────────────────────────────
 * Every number in test-floors.json came from an actual run recorded by --record.
 * A floor is a LOWER BOUND, so raising it to paper over a newly-visible failure
 * is backwards: fix the test, then re-record. `floor: null` is a deliberate
 * opt-out for entries whose passing count is environment-dependent — those still
 * get all three structural checks, they just don't pin a number. Every null
 * carries a `floorUnpinnedReason`.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FLOORS_PATH = join(REPO_ROOT, "scripts", "test-floors.json");

const args = process.argv.slice(2);
const RECORD = args.includes("--record");
const ONLY = args.find((a) => a.startsWith("--only="))?.slice("--only=".length);
const ALLOW_BLIND = process.env.SYNAP_TEST_ALLOW_BLIND === "1";

const config = JSON.parse(readFileSync(FLOORS_PATH, "utf8"));
const entries = config.entries.filter((e) => !ONLY || e.id === ONLY);

if (entries.length === 0) {
  console.error(`No entry matches --only=${ONLY}`);
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), "synap-test-floor-"));
const problems = [];
const summary = [];

for (const entry of entries) {
  const out = join(tmp, `${entry.id.replace(/[^a-z0-9]+/gi, "-")}.json`);
  const cwd = join(REPO_ROOT, entry.dir);
  const argv = [
    "vitest",
    "run",
    ...(entry.args ?? []),
    "--reporter=json",
    `--outputFile=${out}`,
  ];

  process.stderr.write(`▶ ${entry.id} … `);
  const started = Date.now();
  spawnSync("npx", argv, { cwd, stdio: "ignore" });
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  let report;
  try {
    report = JSON.parse(readFileSync(out, "utf8"));
  } catch {
    process.stderr.write(`NO JSON (${secs}s)\n`);
    problems.push({
      id: entry.id,
      kind: "no-report",
      detail:
        `the runner produced no parseable JSON report. The suite crashed before ` +
        `it could report. Reproduce with:\n      cd ${entry.dir} && npx ${argv.slice(0, -2).join(" ")}`,
    });
    continue;
  }

  const total = report.numTotalTests ?? 0;
  const passed = report.numPassedTests ?? 0;
  const failed = report.numFailedTests ?? 0;
  const pending = report.numPendingTests ?? 0;
  const files = report.testResults ?? [];

  process.stderr.write(
    `${passed} passed / ${total} total${failed ? `, ${failed} failed` : ""} (${secs}s)\n`
  );
  summary.push({ id: entry.id, total, passed, failed, pending, files: files.length });

  if (RECORD) {
    entry.floor = entry.floor === null ? null : passed;
    entry.measured = { at: new Date().toISOString(), passed, total, failed };
    continue;
  }

  // ── class 1: everything skipped ───────────────────────────────────────────
  if (total > 0 && passed === 0) {
    const needsDb = entry.requires === "postgres";
    const detail = needsDb
      ? `0 of ${total} tests executed. This entry needs Postgres (DATABASE_URL). ` +
        `On a machine without it this run proves NOTHING about those ${total} tests — ` +
        `it is blind, not green. Start Postgres and run migrations, or set ` +
        `SYNAP_TEST_ALLOW_BLIND=1 to acknowledge the blindness locally. CI must never set it.`
      : `0 of ${total} tests executed — every test was skipped. A suite that runs ` +
        `nothing reports 0 failures and looks green. Check the setup/beforeAll hook.`;
    if (needsDb && ALLOW_BLIND) {
      console.warn(`\n⚠ ${entry.id}: ${detail}\n`);
    } else {
      problems.push({ id: entry.id, kind: "zero-executed", detail });
    }
  }

  // ── class 2: a file collected nothing ─────────────────────────────────────
  const quarantine = new Set(entry.quarantine?.map((q) => q.file) ?? []);
  const emptyFiles = [];
  const stillQuarantined = new Set();
  for (const file of files) {
    if ((file.assertionResults?.length ?? 0) > 0) continue;
    const rel = relative(cwd, file.name).replaceAll("\\", "/");
    if (quarantine.has(rel)) {
      stillQuarantined.add(rel);
      continue;
    }
    emptyFiles.push({
      file: rel,
      reason: (file.message ?? "").split("\n")[0].slice(0, 200),
    });
  }
  if (emptyFiles.length > 0) {
    problems.push({
      id: entry.id,
      kind: "empty-file",
      detail:
        `${emptyFiles.length} test file(s) collected ZERO assertions. vitest does ` +
        `not count these toward numFailedTests, so they stop testing anything ` +
        `WITHOUT turning the suite red. Fix the file, or — if it is known debt — ` +
        `add it to this entry's "quarantine" in scripts/test-floors.json WITH a ` +
        `reason, so the next new one still goes red:\n` +
        emptyFiles.map((e) => `      ${e.file}\n        ↳ ${e.reason}`).join("\n"),
    });
  }
  // A quarantine entry that no longer triggers is stale — it must be deleted, or
  // the list silently grows into the same blind spot it was meant to expose.
  const staleQuarantine = (entry.quarantine ?? [])
    .map((q) => q.file)
    .filter((f) => !stillQuarantined.has(f));
  if (staleQuarantine.length > 0) {
    problems.push({
      id: entry.id,
      kind: "stale-quarantine",
      detail:
        `these files are quarantined as "collects nothing" but now collect fine. ` +
        `Delete them from "quarantine" in scripts/test-floors.json:\n` +
        staleQuarantine.map((f) => `      ${f}`).join("\n"),
    });
  }

  // ── class 3: tests silently disappeared ───────────────────────────────────
  if (entry.floor !== null && entry.floor !== undefined && passed < entry.floor) {
    problems.push({
      id: entry.id,
      kind: "below-floor",
      detail:
        `${passed} passing, floor is ${entry.floor} — ${entry.floor - passed} test(s) ` +
        `that used to pass no longer do, or no longer RUN. Do not lower the floor to ` +
        `make this green: find what stopped running (a narrowed include glob, a moved ` +
        `file, a deleted describe) or what started failing. Once genuinely fixed, ` +
        `re-measure with: node scripts/test-floor.mjs --record --only=${entry.id}`,
    });
  }
}

rmSync(tmp, { recursive: true, force: true });

if (RECORD) {
  config.recordedAt = new Date().toISOString();
  writeFileSync(FLOORS_PATH, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`\nRecorded ${entries.length} floor(s) → ${relative(REPO_ROOT, FLOORS_PATH)}`);
  process.exit(0);
}

console.log("\n─── test floor summary ───────────────────────────────────────");
for (const s of summary) {
  console.log(
    `  ${s.id.padEnd(34)} ${String(s.passed).padStart(5)} passed  ` +
      `${String(s.total).padStart(5)} total  ` +
      `${String(s.failed).padStart(4)} failed  ${String(s.files).padStart(4)} files`
  );
}

if (problems.length === 0) {
  console.log("\n✓ test floor OK — every entry executed and met its floor.\n");
  process.exit(0);
}

console.error(`\n✗ TEST FLOOR VIOLATED — ${problems.length} problem(s)\n`);
for (const p of problems) {
  console.error(`  [${p.kind}] ${p.id}`);
  console.error(`      ${p.detail}\n`);
}
console.error(
  "These are the failures that a plain `pnpm test` reports as ZERO failures.\n" +
    "Read scripts/test-floor.mjs's header for what each class means.\n"
);
process.exit(1);
