/**
 * CLI: the data-conversion runner, inside the backend container.
 *
 *   node dist/scripts/run-conversions.js                       DRY RUN (default): counts only, no writes
 *   node dist/scripts/run-conversions.js --only <opKey>        dry run of the named op(s)
 *   node dist/scripts/run-conversions.js --apply --only <opKey>
 *   node dist/scripts/run-conversions.js --apply --destructive-tail --only <opKey>
 *
 * The same runner as `pnpm --filter @synap/database conversions`, which needs a
 * source checkout with linked workspace packages; the image ships this instead.
 * DATABASE_URL is already set in the container. Run a dry run first and read it
 * before `--apply`.
 */

import "dotenv/config";
import { runConversionsCli } from "@synap/database";

runConversionsCli(process.argv.slice(2), process.env).then(
  (code) => process.exit(code),
  (error) => {
    console.error("[run-conversions] failed:", error);
    process.exit(1);
  }
);
