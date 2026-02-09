/**
 * PostgreSQL Migration Script - Hybrid Approach
 *
 * Applies both auto-generated (Drizzle) and custom (manual SQL) migrations.
 *
 * Order:
 * 1. Drizzle migrations (migrations-drizzle/)
 * 2. Custom migrations (migrations-custom/)
 */

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck - This script is executed by tsx, not compiled
import postgres from "postgres";
import { readFileSync, readdirSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Get DATABASE_URL from environment
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("❌ ERROR: DATABASE_URL environment variable is required");
  console.log("\nPlease set DATABASE_URL:");
  console.log(
    "  export DATABASE_URL=postgresql://user:password@host:5432/dbname"
  );
  console.log("\nOr use docker-compose:");
  console.log("  docker compose up -d");
  console.log(
    "  export DATABASE_URL=postgresql://postgres:synap_dev_password@localhost:5432/synap"
  );
  process.exit(1);
}

console.log("📦 PostgreSQL Migration Tool (Hybrid)\n");
console.log(`Database: ${databaseUrl.replace(/:[^:]*@/, ":****@")}\n`);

// Create SQL client
const sql = postgres(databaseUrl, {
  max: 1,
  onnotice: () => {},
});

/**
 * Initialize migrations tracking table
 */
async function initMigrationsTable() {
  // Check if old table exists (without 'type' column)
  const oldTableExists = await sql`
    SELECT column_name 
    FROM information_schema.columns 
    WHERE table_name = '_migrations' AND column_name = 'type'
  `;

  if (oldTableExists.length === 0) {
    // Old schema exists - drop and recreate
    console.log("⚠️  Old migrations table schema detected. Upgrading...");
    await sql`DROP TABLE IF EXISTS _migrations CASCADE`;
  }

  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('drizzle', 'custom')),
      filename TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (type, filename)
    )
  `;
  console.log("✅ Migrations tracking table ready\n");
}

/**
 * Get applied migrations
 */
async function getAppliedMigrations(): Promise<Map<string, Set<string>>> {
  const result = await sql`
    SELECT type, filename FROM _migrations ORDER BY id
  `;

  const migrations = new Map<string, Set<string>>();
  migrations.set("drizzle", new Set());
  migrations.set("custom", new Set());

  for (const row of result) {
    migrations.get(row.type as string)?.add(row.filename as string);
  }

  return migrations;
}

/**
 * Apply a migration file
 */
async function applyMigration(
  type: "drizzle" | "custom",
  filename: string,
  filePath: string
): Promise<void> {
  console.log(`⏳ Applying [${type}]: ${filename}`);

  const migrationSQL = readFileSync(filePath, "utf-8");

  try {
    // Execute migration using unsafe() for dynamic SQL
    await sql.unsafe(migrationSQL);

    // Record in tracking table
    await sql`
      INSERT INTO _migrations (type, filename)
      VALUES (${type}, ${filename})
    `;

    console.log(`✅ Applied [${type}]: ${filename}\n`);
  } catch (error) {
    console.error(`❌ ERROR applying [${type}] ${filename}:`);
    console.error(error);
    console.error(
      "\n⚠️  Migration failed. Manual intervention may be required.\n"
    );
    throw error;
  }
}

/**
 * Apply migrations from a directory
 */
async function applyMigrationsFromDir(
  type: "drizzle" | "custom",
  dirPath: string,
  appliedSet: Set<string>
): Promise<number> {
  if (!existsSync(dirPath)) {
    console.log(`⏭️  No ${type} migrations directory found, skipping...\n`);
    return 0;
  }

  const files = readdirSync(dirPath)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // Ensure alphabetical order

  if (files.length === 0) {
    console.log(`⏭️  No ${type} migrations found, skipping...\n`);
    return 0;
  }

  console.log(`📂 Found ${files.length} ${type} migration(s):`);
  files.forEach((f) => {
    const status = appliedSet.has(f) ? "✅" : "⏳";
    console.log(`  ${status} ${f}`);
  });
  console.log("");

  const pending = files.filter((f) => !appliedSet.has(f));

  if (pending.length === 0) {
    console.log(`✅ All ${type} migrations already applied\n`);
    return 0;
  }

  console.log(
    `🚀 Applying ${pending.length} pending ${type} migration(s)...\n`
  );

  for (const filename of pending) {
    const filePath = path.join(dirPath, filename);
    await applyMigration(type, filename, filePath);
  }

  return pending.length;
}

/**
 * Main migration function
 */
async function runMigrations() {
  try {
    // 0. Ensure required extensions (safety fallback)
    console.log("📦 Ensuring required extensions...\n");
    try {
      await sql`CREATE EXTENSION IF NOT EXISTS vector;`;
      await sql`CREATE EXTENSION IF NOT EXISTS pg_stat_statements;`;
      await sql`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`;
      console.log("✅ Extensions ready\n");
    } catch (err) {
      console.error("⚠️  Extension check failed (may need superuser):");
      console.error(err);
      console.log("");
    }

    // 1. Initialize tracking table
    await initMigrationsTable();

    // 2. Get applied migrations
    const appliedMigrations = await getAppliedMigrations();

    const drizzleApplied = appliedMigrations.get("drizzle")!;
    const customApplied = appliedMigrations.get("custom")!;

    console.log(
      `📊 Already applied: ${drizzleApplied.size} drizzle + ${customApplied.size} custom\n`
    );

    // 3. Apply Drizzle migrations first
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("STEP 1: Drizzle Migrations (Auto-Generated)");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

    // Resolve paths - robust handling for Docker, Dev (ts-node/tsx), and Prod (compiled dist)
    const possibleDrizzlePaths = [
      "/app/migrations-drizzle", // Docker absolute path
      path.join(__dirname, "../../../migrations-drizzle"), // Dev: packages/database/src/scripts/../../migrations-drizzle -> packages/database/migrations-drizzle
      path.join(__dirname, "../../../migrations-drizzle"), // Prod: packages/database/dist/scripts/../../../migrations-drizzle -> packages/database/migrations-drizzle
      path.join(process.cwd(), "migrations-drizzle"), // CWD fallback
    ];
    console.log(`Debug: Checking Drizzle paths:`, possibleDrizzlePaths);

    const drizzleDir =
      possibleDrizzlePaths.find((p) => {
        const exists = existsSync(p);
        if (exists) console.log(`  ✅ Path exists: ${p}`);
        return exists;
      }) || possibleDrizzlePaths[0];

    const drizzleCount = await applyMigrationsFromDir(
      "drizzle",
      drizzleDir,
      drizzleApplied
    );

    // 4. Apply custom migrations second
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("STEP 2: Custom Migrations (Manual SQL)");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

    const possibleCustomPaths = [
      "/app/migrations-custom",
      path.join(__dirname, "../migrations-custom"),
      path.join(__dirname, "../../migrations-custom"),
      path.join(process.cwd(), "migrations-custom"),
    ];
    console.log(`Debug: Checking Custom paths:`, possibleCustomPaths);

    const customDir =
      possibleCustomPaths.find((p) => {
        const exists = existsSync(p);
        if (exists) console.log(`  ✅ Path exists: ${p}`);
        return exists;
      }) || possibleCustomPaths[0];

    const customCount = await applyMigrationsFromDir(
      "custom",
      customDir,
      customApplied
    );

    // 5. Summary
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("Migration Complete!");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

    if (drizzleCount === 0 && customCount === 0) {
      console.log("✅ All migrations were already applied. Nothing to do!\n");
    } else {
      console.log(
        `✅ Applied ${drizzleCount} drizzle + ${customCount} custom migration(s)\n`
      );
    }

    // 6. Verify tables
    const tables = await sql`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name
    `;

    console.log("📊 Database tables:");
    tables.forEach((table) => console.log(`  - ${table.table_name}`));
    console.log("");
  } catch (error) {
    console.error("❌ Migration failed:");
    console.error(error);
    process.exit(1);
  }
}

// Run migrations
runMigrations()
  .then(() => {
    console.log("✅ Migration complete!\n");
    // Always exit with 0 on success (even if no migrations were needed)
    process.exit(0);
  })
  .catch((error) => {
    console.error("❌ Fatal error:");
    console.error(error);
    // Only exit with 1 on actual errors
    process.exit(1);
  })
  .finally(() => {
    // Ensure database connection is closed
    sql.end().catch(() => {
      // Ignore errors on close
    });
  });
