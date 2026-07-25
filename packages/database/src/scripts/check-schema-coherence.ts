/**
 * Schema Coherence CI Gate
 *
 * Runs `validateSchemaCoherence()` (see ../utils/schema-coherence.ts) against
 * a live database and exits non-zero on drift, so a migration that fails to
 * add a column the runtime requires is caught in CI — not at pod boot.
 *
 * Requires DATABASE_URL to point at a Postgres instance with migrations
 * already applied (run `pnpm --filter @synap/database migrate` first).
 */

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck - This script is executed by tsx, not compiled
import { validateSchemaCoherence } from "../utils/schema-coherence.js";
import { sql } from "../client-pg.js";

validateSchemaCoherence()
  .then(() => {
    console.log("✅ Schema coherence check passed\n");
    process.exit(0);
  })
  .catch((error) => {
    console.error(error?.message ?? error);
    process.exit(1);
  })
  .finally(() => {
    sql.end().catch(() => {});
  });
