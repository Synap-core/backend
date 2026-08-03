import { defineConfig } from "vitest/config";

/**
 * DB-FREE unit lane for @synap/database.
 *
 * DISCOVERY, NOT A HAND-LIST. This config used to carry a hand-maintained
 * `include` list of ~25 globs. That list is exactly the failure mode documented
 * in `tripwires-lose-coverage-silently`: a new DB-free test file is silently
 * OUTSIDE the lane until someone remembers to add it, and nothing ever goes red
 * to tell you. Measured on 2026-08-03: 10 files / 98 passing tests were sitting
 * outside the list.
 *
 * So the polarity is inverted: the lane is `src/**` MINUS an explicit, justified
 * DB-REQUIRING deny-list. A new test file now defaults INTO the lane. If it
 * genuinely needs Postgres it fails loudly here and gets added below with a
 * reason — a stale deny-list fails LOUD, a stale allow-list fails SILENT.
 */

// Files that genuinely need a live Postgres (they open a real connection via a
// repository/service, not a mock). Verified individually on 2026-08-03 by
// running each file with no setupFiles against no local DB — each one produced
// 0 passing tests (skipped or errored). They run in the DB lane
// (`vitest.config.ts`, which loads `src/__tests__/setup.ts`).
const DB_REQUIRING = [
  "src/__tests__/reconcile-workspace-from-definition.test.ts",
  "src/__tests__/knowledge-repository.test.ts",
  "src/__tests__/vector-repository.test.ts",
  "src/__tests__/conversation-repository.test.ts",
  "src/__tests__/property-index-drift.test.ts",
  "src/__tests__/event-repository.test.ts",
];

// PGlite (@electric-sql/pglite) boots a real Postgres compiled to WASM, in
// process — and these three files boot a FRESH instance inside EVERY `it`.
// That is far more than vitest's default 5s testTimeout / 10s hookTimeout can
// absorb once the machine is busy, so the lane was PROVEN flaky: three
// back-to-back runs with file parallelism on gave 330 / 328 / 317 passing
// (5 / 7 / 18 failures) with ZERO code changes — every extra failure was one of
// these three files aborting at describe level. Serialising them gave
// 331 / 331 / 331.
//
// Two config-level mitigations, both needed:
//   1. their own project with `fileParallelism: false`, so they never contend
//      with EACH OTHER (rather than switching the whole lane to
//      `--no-file-parallelism`, which costs 16.5s -> 40s);
//   2. generous timeouts, because they still run concurrently with the other
//      project and with whatever else the machine is doing. A WASM Postgres
//      boot is not a 5-second operation under load.
// The real fix is one shared PGlite instance per file instead of per test —
// that lives in the test sources, which are not this config's to edit.
const PGLITE_SERIAL = [
  "src/conversions/engine.integration.test.ts",
  "src/conversions/merge-cross-scope.test.ts",
  "src/conversions/move-base-property-to-facet.test.ts",
];

const shared = {
  globals: true,
  environment: "node" as const,
  // No setupFiles for unit tests to avoid DB connection
  setupFiles: [],
  env: {
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/synap_test", // Dummy URL for config validation
  },
};

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
    },
    projects: [
      {
        test: {
          ...shared,
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: [
            "**/node_modules/**",
            "**/dist/**",
            "**/__tests__/setup.ts",
            ...DB_REQUIRING,
            ...PGLITE_SERIAL,
          ],
        },
      },
      {
        test: {
          ...shared,
          name: "pglite-serial",
          include: PGLITE_SERIAL,
          exclude: ["**/node_modules/**", "**/dist/**"],
          fileParallelism: false,
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
