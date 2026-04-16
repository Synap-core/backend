# Database Migration Rules

> These rules also belong in `.claude/rules/backend-rules.md` under the "Migration rules (strict)" section. If you land new schema changes, keep both files in sync.

Migrations are strict. Follow these rules for every schema change.

## Hard rules

- Schema changes land via numbered `.sql` files in `packages/database/migrations/`. `drizzle-kit push` and `drizzle-kit generate` are forbidden — every column change MUST land through a numbered migration file.
- When writing a new .sql migration that references a column in a `WHERE`/`ON`/`INDEX` clause, verify the column exists in a prior .sql migration, OR add it defensively at the top of your own migration with `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...`.
- Migrations are atomic and strict. Each migration runs inside a transaction, and any failure aborts the runner (non-zero exit, subsequent migrations blocked). Never rely on the migration runner's silent-skip behavior — it has been removed.
- Write defensively: `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, `DROP ... IF EXISTS`. Migrations must be idempotent and safe to re-run.
- After writing a migration, verify every column it depends on exists somewhere in the migration history:
  ```
  rg -l "column_name" packages/database/migrations/*.sql
  ```
  If it doesn't, add it to your migration with `ADD COLUMN IF NOT EXISTS` at the top.
- If you add a new column or table to `src/schema/*.ts`, you MUST also update `src/utils/schema-coherence.ts` (the startup tripwire) with the new critical column.
- New schema columns added via `drizzle-kit push` or ad-hoc `ALTER TABLE` on a live pod are forbidden — they cause silent drift from the schema and recurring migration failures.

## Background

See `src/scripts/migrate.ts` for the runner. The "recoverable errors" silent-skip behavior has been removed — failed migrations are now logged loudly and block the runner. See `src/utils/schema-coherence.ts` for the startup tripwire that runs after migrations and before the HTTP server starts listening.
