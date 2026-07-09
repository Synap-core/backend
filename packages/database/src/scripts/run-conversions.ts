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
 *
 * `--destructive-tail` is rejected without `--apply` (nothing to destroy in a dry run).
 */

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck - This script is executed by tsx, not compiled
import postgres from "postgres";
import { CONVERSION_MANIFEST, runConversions } from "../conversions/index.js";

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const dryRun = !apply;
const destructiveTail = args.has("--destructive-tail");

if (destructiveTail && dryRun) {
  console.error(
    "❌ --destructive-tail requires --apply (a dry run writes nothing to destroy)."
  );
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("❌ ERROR: DATABASE_URL environment variable is required");
  process.exit(1);
}

console.log("🔁 Synap Conversion Runner\n");
console.log(`Database: ${databaseUrl.replace(/:[^:]*@/, ":****@")}`);
console.log(`Mode:     ${dryRun ? "DRY RUN (no writes)" : "APPLY"}`);
console.log(
  `Manifest: v${CONVERSION_MANIFEST.version}, ${CONVERSION_MANIFEST.ops.length} op(s)`
);
if (destructiveTail)
  console.log("Tail:     DESTRUCTIVE (source profiles will be deactivated)");
console.log("");

const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });

function fmtCounts(counts: Record<string, number>): string {
  const parts = Object.entries(counts)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`);
  return parts.length ? parts.join(", ") : "—";
}

async function main() {
  const summary = await runConversions(sql, CONVERSION_MANIFEST, {
    dryRun,
    destructiveTail,
  });

  const statusIcon: Record<string, string> = {
    applied: "✅",
    skipped: "⏭️ ",
    "dry-run": "🔍",
    noop: "➖",
    error: "❌",
  };

  console.log(
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  );
  console.log(`${"".padEnd(3)}${"OP".padEnd(16)}${"KEY".padEnd(22)}COUNTS`);
  console.log(
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  );
  for (const r of summary.results) {
    const icon = statusIcon[r.status] ?? "  ";
    console.log(
      `${icon} ${r.op.padEnd(16)}${r.opKey.padEnd(22)}${fmtCounts(r.counts)}`
    );
    if (r.error) console.log(`     ↳ ${r.error}`);
  }
  console.log(
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
  );

  if (summary.hadError) {
    console.error("❌ Conversion run stopped at a failing op (see above).");
    process.exit(1);
  }

  if (dryRun) {
    console.log(
      "🔍 Dry run complete — nothing was written. Re-run with --apply to commit.\n"
    );
  } else {
    console.log("✅ Conversion run complete.\n");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Fatal error:", error);
    process.exit(1);
  })
  .finally(() => {
    sql.end().catch(() => {});
  });
