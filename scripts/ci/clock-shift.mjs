#!/usr/bin/env node
/**
 * NIGHTLY SHIFTED-CLOCK RUN (.github/workflows/clock-shift.yml).
 *
 * A test that hard-codes a date and reads the real clock is a time bomb: it
 * passes today and goes red on a fixed day with no code change (hold.test.ts,
 * fixed in #996, turned main red for ~4 h). This script finds them early: it
 * runs the test files that contain a 2026+ date literal with the clock moved
 * forward (`CLOCK_SHIFT_DAYS`, see clock-shift.setup.ts) and reports a file
 * only when it PASSES unshifted and FAILS shifted.
 *
 *   node scripts/ci/clock-shift.mjs run --days 45 [--packages packages/types,...]
 *   node scripts/ci/clock-shift.mjs list [--packages ...]
 *
 * THE SET IS DERIVED, never listed: `git grep` for a date literal in every
 * test file, grouped by package. Only SUPPORTED_PACKAGES (suites that load
 * with no database) run.
 *
 * NO EXISTING CONFIG CHANGES: per package a wrapper config is generated into
 * $RUNNER_TEMP; it imports the package's own vitest config and adds the setup
 * file. The wrapper is the only thing that knows about the shift.
 *
 * UNSHIFTED RULE: a file that fails with the clock shifted is re-run at +0 in
 * the same job; one that also fails there is "failing already" (a stale local
 * build, a missing sibling), not a time bomb, and is listed but never fails
 * the run (`classify`).
 *
 * KNOWN GAPS: PGlite / Postgres `now()` inside SQL is not moved by a JS Date
 * override (HYPOTHESIS, untested); suites that need a database (packages/
 * database, apps/pod-admin, the DB-bound part of packages/api) are not run;
 * `vi.useFakeTimers()` tests pin their own clock and are unaffected by design.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  appendFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);
export const SETUP_FILE = join(
  REPO_ROOT,
  "scripts",
  "ci",
  "clock-shift.setup.ts"
);

/** A 2026..2039 ISO date literal: the file names a date that is "the future". */
export const DATE_PATTERN = "20(2[6-9]|3[0-9])-[01][0-9]-[0-3][0-9]";

/**
 * Packages whose test files load without a database. v1 is packages/types only:
 * packages/jobs ran clean at +45 locally but mixes PGlite suites (SQL now() is
 * not shifted, so a shifted JS clock beside an unshifted DB clock could report
 * a false bomb); packages/api is ~880 dated files, DB- and dist-bound.
 */
export const SUPPORTED_PACKAGES = ["packages/types"];

export const DEFAULT_DAYS = 45;

/** `git grep -l` output lines -> Map<package dir, repo-relative test files>. */
export function selectTestFiles(lines, packages = SUPPORTED_PACKAGES) {
  const byPackage = new Map();
  for (const line of lines) {
    const file = line.trim();
    if (!/\.test\.tsx?$/.test(file)) continue;
    const pkg = packages.find((p) => file.startsWith(`${p}/`));
    if (!pkg) continue;
    if (!byPackage.has(pkg)) byPackage.set(pkg, []);
    byPackage.get(pkg).push(file);
  }
  for (const files of byPackage.values()) files.sort();
  return new Map([...byPackage].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * The unshifted-first rule, pure. `shifted` and `unshifted` are the sets of
 * test keys that FAILED in each pass (unshifted only needs the shifted failures).
 * A time bomb fails shifted and passes unshifted. The unit is a TEST (a file
 * whose suite did not load counts as one unit), so a file already red at +0
 * cannot hide a second bomb.
 */
export function classify({ shifted, unshifted }) {
  const bad = new Set(unshifted);
  const bombs = [];
  const failingAlready = [];
  for (const f of [...shifted].sort())
    (bad.has(f) ? failingAlready : bombs).push(f);
  return { bombs, failingAlready };
}

/** Wrapper config source: the package's own config plus the setup file. */
export function wrapperConfigSource({ baseConfigPath, setupPath }) {
  const imp = baseConfigPath
    ? `import base from ${JSON.stringify(baseConfigPath)};`
    : "const base = {};";
  return `${imp}
export default async (env) => {
  const cfg = typeof base === "function" ? await base(env) : base;
  const test = cfg.test ?? {};
  return {
    ...cfg,
    test: {
      ...test,
      setupFiles: [...[].concat(test.setupFiles ?? []), ${JSON.stringify(setupPath)}],
    },
  };
};
`;
}

export function findBaseConfig(pkgDir, exists = existsSync) {
  for (const n of [
    "vitest.config.ts",
    "vitest.config.mts",
    "vitest.config.mjs",
    "vitest.config.js",
  ]) {
    const p = join(pkgDir, n);
    if (exists(p)) return p;
  }
  return null;
}

function gitGrepFiles() {
  const r = spawnSync(
    "git",
    ["grep", "-lE", DATE_PATTERN, "--", "*.test.ts", "*.test.tsx"],
    { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  if (r.status !== 0 && r.status !== 1)
    throw new Error(`git grep failed: ${r.stderr}`);
  return r.stdout.split("\n").filter(Boolean);
}

/** Run vitest over `files` in `pkg`; return the failed tests (see keys below). */
function runVitest({ pkg, files, config, days, workDir, tag }) {
  const out = join(workDir, `${tag}.json`);
  const env = { ...process.env };
  if (days) env.CLOCK_SHIFT_DAYS = String(days);
  else delete env.CLOCK_SHIFT_DAYS;
  const pkgDir = join(REPO_ROOT, pkg);
  const r = spawnSync(
    "npx",
    [
      "vitest",
      "run",
      "--root",
      pkgDir,
      "--config",
      config,
      "--reporter=json",
      `--outputFile=${out}`,
      ...files.map((f) => relative(pkg, f)),
    ],
    {
      cwd: pkgDir,
      env,
      stdio: ["ignore", "ignore", "inherit"],
      maxBuffer: 64 * 1024 * 1024,
    }
  );
  if (!existsSync(out))
    throw new Error(`${pkg} ${tag}: vitest wrote no report (exit ${r.status})`);
  const report = JSON.parse(readFileSync(out, "utf8"));
  // One key per failed TEST (`file :: name`), or the bare file when the suite
  // failed to load: a file already red at +0 must not hide a second bomb.
  const failed = new Set();
  for (const t of report.testResults) {
    const file = relative(REPO_ROOT, t.name);
    const tests = (t.assertionResults ?? []).filter(
      (a) => a.status === "failed"
    );
    if (tests.length)
      for (const a of tests) failed.add(`${file} :: ${a.fullName}`);
    else if (t.status === "failed") failed.add(file);
  }
  return { failed, total: report.testResults.length };
}

function arg(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? "" : (argv[i + 1] ?? "");
}

function main(argv) {
  const [cmd] = argv;
  const only = arg(argv, "packages")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const packages = SUPPORTED_PACKAGES.filter(
    (p) => only.length === 0 || only.includes(p)
  );
  const selected = selectTestFiles(gitGrepFiles(), packages);
  if (cmd === "list") {
    for (const files of selected.values()) console.log(files.join("\n"));
    return 0;
  }
  if (cmd !== "run") {
    console.error(
      "usage: clock-shift.mjs run|list [--days N] [--packages a,b]"
    );
    return 2;
  }
  const days = Number(arg(argv, "days") || DEFAULT_DAYS);
  if (!Number.isFinite(days) || days <= 0)
    throw new Error(`bad --days: ${arg(argv, "days")}`);
  const total = [...selected.values()].reduce((n, f) => n + f.length, 0);
  // Non-vacuity: an empty selection would pass by not looking.
  if (total === 0)
    throw new Error(
      "clock-shift: no dated test files selected; the grep or the package list is broken"
    );

  const workDir = join(
    process.env.RUNNER_TEMP || tmpdir(),
    `clock-shift-${days}`
  );
  mkdirSync(workDir, { recursive: true });
  const rows = [];
  const allBombs = [];
  for (const [pkg, files] of selected) {
    const slug = pkg.replace(/\W+/g, "-");
    const config = join(workDir, `${slug}.vitest.config.ts`);
    writeFileSync(
      config,
      wrapperConfigSource({
        baseConfigPath: findBaseConfig(join(REPO_ROOT, pkg)),
        setupPath: SETUP_FILE,
      })
    );
    const shifted = runVitest({
      pkg,
      files,
      config,
      days,
      workDir,
      tag: `${slug}-shifted`,
    });
    let verdict = { bombs: [], failingAlready: [] };
    if (shifted.failed.size > 0) {
      const base = runVitest({
        pkg,
        files: [...new Set([...shifted.failed].map((k) => k.split(" :: ")[0]))],
        config,
        days: 0,
        workDir,
        tag: `${slug}-unshifted`,
      });
      verdict = classify({ shifted: shifted.failed, unshifted: base.failed });
    }
    rows.push({ pkg, ran: shifted.total, ...verdict });
    allBombs.push(...verdict.bombs);
  }

  const lines = [
    `## Shifted clock: +${days} days`,
    "",
    "| package | files run | time bombs (tests) | failing unshifted too |",
    "|---|---|---|---|",
  ];
  for (const r of rows)
    lines.push(
      `| ${r.pkg} | ${r.ran} | ${r.bombs.length} | ${r.failingAlready.length} |`
    );
  if (allBombs.length)
    lines.push(
      "",
      `### Pass today, fail at +${days} days`,
      ...allBombs.map((f) => `- \`${f}\``)
    );
  for (const r of rows)
    if (r.failingAlready.length)
      lines.push(
        "",
        `Not counted (fail at +0 too) in ${r.pkg}:`,
        ...r.failingAlready.map((f) => `- \`${f}\``)
      );
  const text = lines.join("\n") + "\n";
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  return allBombs.length ? 1 : 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exit(main(process.argv.slice(2)));
}
