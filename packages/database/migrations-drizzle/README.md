# Auto-Generated Migrations (Drizzle Kit)

This directory contains **auto-generated** SQL migrations created by Drizzle Kit from your TypeScript schema.

## ⚠️ Do NOT Edit These Files

These files are generated automatically. Your changes will be overwritten.

## How to Generate Migrations

When you modify the TypeScript schema in `src/schema/`:

```bash
# Generate migration from schema changes
pnpm drizzle-kit generate

# This will create a new file here like:
# 0001_create_users_table.sql
```

## What Drizzle Can Generate

Drizzle Kit can auto-generate migrations for:

- ✅ Tables (CREATE TABLE, ALTER TABLE)
- ✅ Columns (ADD COLUMN, DROP COLUMN, ALTER COLUMN)
- ✅ Primary keys and foreign keys
- ✅ Indexes (basic)
- ✅ Unique constraints
- ✅ Check constraints

## What Drizzle Cannot Generate

For these, use custom migrations in `../migrations-custom/`:

- ❌ PostgreSQL extensions (vector, timescaledb)
- ❌ PL/pgSQL functions
- ❌ TimescaleDB hypertables
- ❌ Complex data transformations
- ❌ Advanced indexes (GIN, GIST, ivfflat)

## Workflow

1. **Modify schema**: Edit files in `src/schema/`
2. **Generate migration**: `pnpm drizzle-kit generate`
3. **Review SQL**: Check the generated `.sql` file
4. **Apply migration**: `pnpm db:migrate`

If you need custom SQL (extensions, functions), create a file in `../migrations-custom/`.

