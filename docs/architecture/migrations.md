# Database migrations

> Verified against code on 2026-10-20 (backend@cc4b2d81). Migrated from Synap's
> internal team docs on 2026-10-20.

Every schema change to a pod lands as a hand-written, numbered `.sql` file.
This page is the contract the runner enforces and the rules a new migration
must follow.

## Where migrations live

- `packages/database/migrations/` is the one migration directory. Files are
  applied in plain alphabetical order of the full filename, so the numeric
  prefix sets the order. A few prefixes are shared by two files (for example
  `0009_`, `0216_`, `0328_`); the rest of the filename then decides.
- `0000_baseline_schema.sql` creates the whole schema from scratch with
  idempotent statements, and at its end records the legacy migration filenames
  it folds in, so an existing pod does not re-run them. It replaced the older
  `0099_schema_reconciliation.sql` catch-up file.
- The `migrations/` folder at the repository root is legacy. New migrations do
  not go there.

## Rules for a new migration

- **Never use `drizzle-kit push` or `drizzle-kit generate`.** drizzle-kit was
  abandoned after migration 0003. The Drizzle schema in
  `packages/database/src/schema/` describes the tables; the `.sql` files change
  them.
- **Write every statement so it can run twice:** `ADD COLUMN IF NOT EXISTS`,
  `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `DROP ... IF EXISTS`,
  and `DO $$ ... EXCEPTION WHEN duplicate_object` for types.
- **Check every column you reference.** If a `WHERE`, `ON` or index clause names a
  column, confirm an earlier migration (or the baseline) creates it:
  `rg -l "column_name" packages/database/migrations/`. If none does, add it at the
  top of your migration with `ADD COLUMN IF NOT EXISTS`.
- **A new column or table also goes into the baseline and the coherence check:**
  add it to `0000_baseline_schema.sql` so a fresh pod gets it, and add critical
  columns to `REQUIRED_COLUMNS` in `packages/database/src/utils/schema-coherence.ts`.
- **Never change a live pod's schema by hand** (an ad-hoc `ALTER TABLE`). It
  drifts from the migration history and breaks later migrations.
- **Never drop or edit `_migrations` by hand** outside the recovery steps the
  runner prints.

## What the runner guarantees

The runner is `packages/database/src/scripts/migrate.ts` (shipped as a single
`migrate.js`, because desktop packaging copies that one file). In Compose it runs
as the one-shot `backend-migrate` service before the backend starts
(`deploy/docker-compose.yml`).

- Each migration runs in its own transaction. An error rolls it back, it is
  never recorded as applied, and the runner exits non-zero. There is no
  "recoverable error" skip.
- Applied filenames are recorded in `_migrations (filename)`.
- **Populated-database guard.** If `_migrations` reads as empty while `users`,
  `workspaces` or `entities` hold rows, the runner refuses to apply anything and
  prints recovery steps. An empty history over live data is lost or mis-read
  history, not a fresh pod.
- **Probed reads.** Each guard query carries a literal `probe` label and checks
  it comes back, so a desynchronised connection that returns another query's
  result fails instead of being believed. A failed read of `_migrations` is a
  refusal, never "no history".
- If no migrations directory is found, or it has no `.sql` files, the runner
  refuses to start rather than boot against an empty schema.

## Schema coherence at boot

After migrations and before the HTTP server listens, `apps/api/src/index.ts`
calls `validateSchemaCoherence()` (`packages/database/src/utils/schema-coherence.ts`).
It checks a list of required columns, enum values and indexes and throws if any
is missing, so the pod exits non-zero instead of serving a schema the code does
not match. It is a tripwire for known at-risk columns, not a full schema diff.
`checkSchemaCoherence()` is the non-throwing variant; the public
`GET /status/release` endpoint reports its result together with the applied
migrations, so a deploy can be checked in one call.

Migrations that need behavioural proof have PGlite tests next to the schema:
`packages/database/src/migrations-<number>.pglite.test.ts`, and the guard itself
is tested in `packages/database/src/scripts/migrate-guard.pglite.test.ts`.

## History

- Until 2026-04 (when the source of this page was last edited), migrations were split across `migrations-drizzle/` and
  `migrations-custom/`, with `0099_schema_reconciliation.sql` as the catch-up
  file. Both directories were merged into `packages/database/migrations/` and the
  catch-up folded into `0000_baseline_schema.sql`; the runner upgrades the old
  two-directory `_migrations` table in place.
- 2026-10-05: a desynchronised database connection made the runner read an
  empty history on a populated pod and re-apply the baseline. The
  populated-database guard and probed reads were added in response.
