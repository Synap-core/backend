/**
 * Conversion Runner CLI — Kind + Facets Wave 3A
 *
 * Drives the generic conversion engine (src/conversions/) against a pod.
 * Model: migrate.ts (single dedicated postgres.js connection, structured output,
 * non-zero exit on failure).
 *
 * Usage:
 *   tsx src/scripts/run-conversions.ts                 # DRY RUN (default) — counts only, no writes
 *   tsx src/scripts/run-conversions.ts --apply         # apply for real, records the ledger
 *   tsx src/scripts/run-conversions.ts --apply --destructive-tail
 *                                                      # + deactivate merged-away source profiles
 *   tsx src/scripts/run-conversions.ts --only <opKey>  # restrict to named op(s), manifest order;
 *                                                      # repeatable or comma-separated
 *
 * A pending destructive-tail op (mergeInto / dedupeProfileRows) is completed as:
 *   tsx src/scripts/run-conversions.ts --only <opKey>                              # dry run
 *   tsx src/scripts/run-conversions.ts --apply --only <opKey> --destructive-tail
 * The engine REFUSES such an op on `--apply` without `--destructive-tail` (it
 * would ledger the repoint and orphan the deactivation forever).
 *
 * `--destructive-tail` is rejected without `--apply` (nothing to destroy in a dry run).
 */

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck - This script is executed by tsx, not compiled
import { runConversionsCli } from "../conversions/cli.js";

runConversionsCli(process.argv.slice(2), process.env).then(
  (code) => process.exit(code),
  (error) => {
    console.error("❌ Fatal error:", error);
    process.exit(1);
  }
);
