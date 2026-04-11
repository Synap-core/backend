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

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("❌ ERROR: DATABASE_URL environment variable is required");
  process.exit(1);
}

console.log("📦 PostgreSQL Migration Runner\n");
console.log(`Database: ${databaseUrl.replace(/:[^:]*@/, ":****@")}\n`);

const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });

/**
 * Initialize the _migrations tracking table.
 *
 * Breaking change: if the old two-column schema (type + filename) is detected
 * the table is dropped and recreated. All migrations re-run — they are all
 * idempotent (IF NOT EXISTS / IF EXISTS throughout).
 */
async function initMigrationsTable(): Promise<void> {
  const tableExists = await sql`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = '_migrations'
  `;

  if (tableExists.length > 0) {
    // Check for old schema (has 'type' column = pre-consolidation)
    const hasTypeCol = await sql`
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name   = '_migrations'
        AND column_name  = 'type'
    `;

    if (hasTypeCol.length > 0) {
      console.log(
        "⚠️  Old two-directory _migrations schema detected — resetting for clean single-directory run..."
      );
      await sql`DROP TABLE _migrations CASCADE`;
    } else {
      console.log("✅ Migrations tracking table ready\n");
      return;
    }
  }

  await sql`
    CREATE TABLE _migrations (
      id         SERIAL PRIMARY KEY,
      filename   TEXT        NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  console.log("✅ Migrations tracking table created\n");
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
      await tx`INSERT INTO _migrations (filename) VALUES (${filename})`;
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

    // Resolve migrations directory
    const candidates = [
      "/app/migrations", // Docker
      path.join(__dirname, "../../migrations"), // Dev + Prod (src/scripts/ or dist/scripts/)
      path.join(process.cwd(), "migrations"), // CWD fallback
    ];
    const migrationsDir = candidates.find(existsSync) ?? candidates[0];
    console.log(`📂 Migrations directory: ${migrationsDir}\n`);

    await initMigrationsTable();

    // Load applied set
    const appliedRows = await sql`SELECT filename FROM _migrations`;
    const applied = new Set(appliedRows.map((r) => r.filename as string));
    console.log(`📊 Already applied: ${applied.size}\n`);

    // Collect and sort pending migrations
    const allFiles = existsSync(migrationsDir)
      ? readdirSync(migrationsDir)
          .filter((f) => f.endsWith(".sql"))
          .sort()
      : [];
    const pending = allFiles.filter((f) => !applied.has(f));

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
    console.error("❌ Migration failed:", error);
    process.exit(1);
  }
}

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
