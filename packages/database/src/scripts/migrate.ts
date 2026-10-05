/**
 * PostgreSQL Migration Runner
 *
 * Single-directory, single-pass. All migrations live in packages/database/migrations/
 * sorted alphabetically (numeric prefix ensures correct order).
 *
 * Contract:
 *   - Each migration runs inside its own transaction. Any error rolls the migration
 *     back entirely and halts the runner with a non-zero exit.
 *   - A failing migration is NEVER recorded as applied.
 *   - Write all migrations defensively:
 *       ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...
 *       CREATE INDEX IF NOT EXISTS ...
 *       CREATE TABLE IF NOT EXISTS ...
 *       DROP ... IF EXISTS ...
 */

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck - This script is executed by tsx, not compiled
import postgres from "postgres";
import { readFileSync, readdirSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Populated-database guard ────────────────────────────────────────────────
//
// 2026-10-05: a desynchronised connection (PGlite's spare ReadyForQuery, fixed
// in browser 53c01587) made this runner read `_migrations` as missing + empty
// on a pod with 340 rows of history, so it re-ran 0000_baseline_schema.sql and
// every later migration over live data. One run went all the way through.
// History that reads EMPTY over a POPULATED database is never a fresh pod: it is
// lost or mis-read history, and re-applying 245 migrations (backfills
// included) over real data is a data-loss hazard. So the runner refuses.
//
// Kept in THIS file on purpose: desktop packaging ships `migrate.js` as a single
// file (browser/electron-builder.yml, scripts/pack-*.sh), so a sibling module
// would not exist at runtime.

/** Runs one SQL statement and returns its rows (postgres.js `sql.unsafe`, PGlite `query().rows`). */
export type GuardQuery = (
  text: string
) => Promise<ReadonlyArray<Record<string, unknown>>>;

/**
 * Tables whose rows are user data. All three are created by the baseline, so
 * on a fresh pod none exists; their rows are what a re-baseline would put at
 * risk. `to_regclass` reads pg_class directly (no information_schema view).
 */
export const CORE_TABLES = ["users", "workspaces", "entities"] as const;

/** The runner must not proceed. `exitCode` is always non-zero. */
export class MigrationRefusal extends Error {
  readonly exitCode = 1;
  constructor(message: string) {
    super(message);
    this.name = "MigrationRefusal";
  }
}

/**
 * Every guard read carries a literal `probe` label and checks it came back.
 * A connection that hands a query the PREVIOUS query's result (the exact
 * 2026-10-05 failure) then fails here instead of being believed.
 */
async function probedRead(
  q: GuardQuery,
  label: string,
  text: string
): Promise<ReadonlyArray<Record<string, unknown>>> {
  const rows = await q(text);
  for (const row of rows) {
    if (row?.probe !== label) {
      throw new MigrationRefusal(
        `Guard read "${label}" came back with another query's result ` +
          `(probe=${JSON.stringify(row?.probe)}). The database connection is ` +
          "desynchronised — refusing to migrate on answers it cannot trust."
      );
    }
  }
  return rows;
}

/**
 * The applied-migration set. A failed read THROWS — it is never "empty"
 * (an empty history is a fact; a failed read is the absence of one).
 */
export async function readAppliedMigrations(
  q: GuardQuery
): Promise<Set<string>> {
  try {
    const counted = await probedRead(
      q,
      "migrate-guard:history-count",
      `SELECT 'migrate-guard:history-count' AS probe, count(*)::int AS n FROM _migrations`
    );
    if (counted.length !== 1) {
      throw new MigrationRefusal(
        `Guard read "migrate-guard:history-count" returned ${counted.length} rows (expected 1).`
      );
    }
    const expected = Number(counted[0].n);
    const rows = await probedRead(
      q,
      "migrate-guard:history",
      `SELECT 'migrate-guard:history' AS probe, filename FROM _migrations`
    );
    if (rows.length !== expected) {
      throw new MigrationRefusal(
        `_migrations read returned ${rows.length} rows but counts ${expected} — ` +
          "refusing to migrate on an inconsistent history read."
      );
    }
    return new Set(rows.map((r) => String(r.filename)));
  } catch (error: any) {
    if (error instanceof MigrationRefusal) throw error;
    throw new MigrationRefusal(
      `Could not read _migrations (${error?.message ?? error}). A failed read is ` +
        "not an empty history — refusing to migrate."
    );
  }
}

/** Core tables that exist AND hold at least one row. Empty array = nothing to lose. */
export async function detectPopulatedTables(q: GuardQuery): Promise<string[]> {
  const exists = await probedRead(
    q,
    "migrate-guard:core-tables",
    `SELECT 'migrate-guard:core-tables' AS probe, ` +
      CORE_TABLES.map(
        (t) => `to_regclass('public.${t}') IS NOT NULL AS "${t}"`
      ).join(", ")
  );
  if (exists.length !== 1) {
    throw new MigrationRefusal(
      `Guard read "migrate-guard:core-tables" returned ${exists.length} rows (expected 1).`
    );
  }
  const present = CORE_TABLES.filter((t) => exists[0][t] === true);
  if (present.length === 0) return [];
  const filled = await probedRead(
    q,
    "migrate-guard:core-rows",
    `SELECT 'migrate-guard:core-rows' AS probe, ` +
      present
        .map((t) => `EXISTS (SELECT 1 FROM public."${t}") AS "${t}"`)
        .join(", ")
  );
  if (filled.length !== 1) {
    throw new MigrationRefusal(
      `Guard read "migrate-guard:core-rows" returned ${filled.length} rows (expected 1).`
    );
  }
  return present.filter((t) => filled[0][t] === true);
}

/**
 * Pending migrations, or a refusal when the history reads empty over a
 * populated database. A populated DB WITH history applies only what is
 * pending (the normal upgrade path, baseline included when it is pending).
 */
export async function planMigrations(
  q: GuardQuery,
  allFiles: ReadonlyArray<string>
): Promise<{ applied: Set<string>; pending: string[] }> {
  const applied = await readAppliedMigrations(q);
  if (applied.size === 0) {
    const populated = await detectPopulatedTables(q);
    if (populated.length > 0) {
      throw new MigrationRefusal(
        [
          `_migrations is empty, but the database is POPULATED (rows in: ${populated.join(", ")}).`,
          "This is lost or mis-read migration history, not a fresh pod. Applying",
          `${allFiles.length} migrations (0000_baseline_schema.sql first) over live data could`,
          "corrupt or destroy it, so nothing was applied.",
          "",
          "Recovery (manual):",
          "  1. Back up the database first (pg_dump / deploy/backups/postgres).",
          "  2. Check the connection: SELECT count(*) FROM _migrations; — a non-zero count",
          "     means the runner mis-read it (driver/shim desync); fix that, then rerun.",
          "  3. If the history is truly gone, restore _migrations from a backup, or re-insert",
          "     the filenames the schema already reflects (INSERT INTO _migrations (filename) ...),",
          "     then rerun so only genuinely pending migrations apply.",
        ].join("\n")
      );
    }
  }
  return { applied, pending: allFiles.filter((f) => !applied.has(f)) };
}

// ─── Runner ──────────────────────────────────────────────────────────────────

// `sql` is created by main(); the helpers below only run inside it.
let sql: ReturnType<typeof postgres>;

/**
 * Initialize the _migrations tracking table.
 *
 * Upgrade path: if the old two-column schema (type + filename) is detected,
 * the table is migrated in-place — existing rows are preserved so already-applied
 * migrations are not re-run. Only the schema changes (drop type column, update
 * unique constraint from (type, filename) to (filename)).
 */
async function initMigrationsTable(): Promise<void> {
  const tableExists = await sql`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = '_migrations'
  `;

  if (tableExists.length === 0) {
    // IF NOT EXISTS is required for defensiveness: under PGlite (the embedded
    // local pod) the information_schema.tables check above can return empty even
    // when _migrations already exists on disk from a prior launch, so a bare
    // CREATE TABLE would throw "relation _migrations already exists" (surfaced on
    // the next pipelined await). Idempotent create + the upgrade-path checks below
    // still run for real Postgres pods, where the existence check is reliable.
    await sql`
      CREATE TABLE IF NOT EXISTS _migrations (
        id         SERIAL PRIMARY KEY,
        filename   TEXT        NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    console.log("✅ Migrations tracking table created\n");
    return;
  }

  // Check for old schema (has 'type' column = pre-consolidation)
  const hasTypeCol = await sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = '_migrations'
      AND column_name  = 'type'
  `;

  if (hasTypeCol.length > 0) {
    console.log(
      "⚠️  Old two-directory _migrations schema detected — upgrading in place (history preserved)..."
    );

    // Deduplicate: if the same filename was recorded under both types, keep one
    await sql`
      DELETE FROM _migrations a USING _migrations b
      WHERE a.id > b.id AND a.filename = b.filename
    `;

    // Drop the old (type, filename) unique constraint
    await sql`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '_migrations_type_filename_key' AND conrelid = '_migrations'::regclass) THEN
          ALTER TABLE _migrations DROP CONSTRAINT _migrations_type_filename_key;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '_migrations_type_check' AND conrelid = '_migrations'::regclass) THEN
          ALTER TABLE _migrations DROP CONSTRAINT _migrations_type_check;
        END IF;
      END; $$
    `;

    // Add filename unique constraint if not already there
    await sql`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '_migrations_filename_key' AND conrelid = '_migrations'::regclass) THEN
          ALTER TABLE _migrations ADD CONSTRAINT _migrations_filename_key UNIQUE (filename);
        END IF;
      END; $$
    `;

    // Drop the type column
    await sql`ALTER TABLE _migrations DROP COLUMN IF EXISTS type`;

    console.log("✅ _migrations upgraded (history preserved, no re-runs)\n");
  } else {
    console.log("✅ Migrations tracking table ready\n");
  }
}

async function applyMigration(
  filename: string,
  filePath: string
): Promise<void> {
  console.log(`⏳ Applying: ${filename}`);
  const migrationSQL = readFileSync(filePath, "utf-8");

  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(migrationSQL);
      // ON CONFLICT DO NOTHING: on a FRESH pod, 0000_baseline_schema.sql
      // pre-seeds _migrations with the filenames whose DDL it folds in (e.g.
      // 0036_channel_members.sql). Those files are still in `pending` (the
      // applied-set is read once, before baseline runs), so the runner
      // re-applies their defensive IF-NOT-EXISTS DDL (harmless) and would
      // otherwise collide on the unique filename here. Idempotent record.
      await tx`INSERT INTO _migrations (filename) VALUES (${filename}) ON CONFLICT (filename) DO NOTHING`;
    });
    console.log(`✅ Applied: ${filename}\n`);
  } catch (error: any) {
    console.error("");
    console.error(
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    );
    console.error(`❌ MIGRATION FAILED — ${filename}`);
    console.error(
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    );
    console.error(`  File:     ${filePath}`);
    console.error(`  PG code:  ${error?.code ?? "(no code)"}`);
    console.error(`  Position: ${error?.position ?? "(no position)"}`);
    if (error?.detail) console.error(`  Detail:   ${error.detail}`);
    if (error?.hint) console.error(`  Hint:     ${error.hint}`);
    console.error(`  Message:  ${error?.message ?? error}`);
    console.error(
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    );
    console.error(
      "  Fix the migration and redeploy. The runner will not continue."
    );
    console.error(
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    );
    console.error("");
    throw error;
  }
}

async function runMigrations() {
  try {
    // Ensure extensions (best-effort — may need superuser)
    try {
      await sql`CREATE EXTENSION IF NOT EXISTS vector`;
      await sql`CREATE EXTENSION IF NOT EXISTS pg_stat_statements`;
      await sql`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`;
    } catch (err) {
      console.warn("⚠️  Extension setup failed (may need superuser):", err);
    }

    // Resolve migrations directory.
    // Note: __dirname-relative path is last — when running from an installed
    // node_modules package, ../../migrations resolves into the package bundle
    // inside node_modules, not the Dockerfile-copied directory we want.
    const candidates = [
      "/app/migrations", // Dockerfile.api (WORKDIR /app)
      "/app/api/migrations", // deploy/Dockerfile (api sub-dir layout)
      path.join(process.cwd(), "migrations"), // CWD fallback (dev)
      path.join(__dirname, "../../migrations"), // Last resort: src/scripts/ or dist/scripts/
    ];
    const migrationsDir = candidates.find(existsSync);
    if (!migrationsDir) {
      console.error(
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
      );
      console.error("❌ No migrations directory found");
      console.error(
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
      );
      console.error("  Searched:");
      for (const c of candidates) console.error(`    - ${c}`);
      console.error(
        "\n  This usually means the Docker build did not copy packages/database/migrations/"
      );
      console.error(
        "  into the image (see deploy/Dockerfile). Refusing to start — the backend would"
      );
      console.error("  otherwise boot against an empty schema.");
      console.error(
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
      );
      process.exit(1);
    }
    console.log(`📂 Migrations directory: ${migrationsDir}\n`);

    await initMigrationsTable();

    // Collect and sort migrations
    const allFiles = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    if (allFiles.length === 0) {
      console.error(
        `❌ Migrations directory ${migrationsDir} contains no .sql files — refusing to start.`
      );
      process.exit(1);
    }

    // Load applied set — refuses on a failed/desynchronised read, and on an
    // empty history over a populated database (see planMigrations).
    const { applied, pending } = await planMigrations(
      (text) => sql.unsafe(text),
      allFiles
    );
    console.log(`📊 Already applied: ${applied.size}\n`);

    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(
      `Found ${allFiles.length} migrations, ${pending.length} pending`
    );
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    if (pending.length === 0) {
      console.log("✅ All migrations already applied. Nothing to do!\n");
    } else {
      console.log(`🚀 Applying ${pending.length} pending migration(s)...\n`);
      for (const filename of pending) {
        await applyMigration(filename, path.join(migrationsDir, filename));
      }
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`✅ Applied ${pending.length} migration(s)`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    }

    // Print tables for confirmation
    const tables = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name
    `;
    console.log("📊 Database tables:");
    tables.forEach((t) => console.log(`  - ${t.table_name}`));
    console.log("");
  } catch (error) {
    if (error instanceof MigrationRefusal) {
      const bar = "━".repeat(66);
      console.error(
        `\n${bar}\n❌ MIGRATIONS REFUSED — nothing was applied\n${bar}`
      );
      console.error(error.message);
      console.error(`${bar}\n`);
      process.exit(error.exitCode);
    }
    console.error("❌ Migration failed:", error);
    process.exit(1);
  }
}

function main(): void {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("❌ ERROR: DATABASE_URL environment variable is required");
    process.exit(1);
  }

  console.log("📦 PostgreSQL Migration Runner\n");
  console.log(`Database: ${databaseUrl.replace(/:[^:]*@/, ":****@")}\n`);

  sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });

  runMigrations()
    .then(() => {
      console.log("✅ Migration complete!\n");
      process.exit(0);
    })
    .catch((error) => {
      console.error("❌ Fatal error:", error);
      process.exit(1);
    })
    .finally(() => {
      sql.end().catch(() => {});
    });
}

// The runner starts on load (node migrate.js / tsx). Tests import the guard
// with this flag set; nothing else sets it.
if (process.env.SYNAP_MIGRATE_IMPORT_ONLY !== "1") main();
