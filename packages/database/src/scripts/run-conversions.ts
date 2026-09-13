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
import postgres from "postgres";
import {
  CONVERSION_MANIFEST,
  runConversions,
  parseOnlyArgs,
  selectManifestOps,
  type FieldPlanRow,
} from "../conversions/index.js";

const argv = process.argv.slice(2);
const args = new Set(argv);
const apply = args.has("--apply");
const dryRun = !apply;
const destructiveTail = args.has("--destructive-tail");

if (destructiveTail && dryRun) {
  console.error(
    "❌ --destructive-tail requires --apply (a dry run writes nothing to destroy)."
  );
  process.exit(1);
}

let manifest = CONVERSION_MANIFEST;
try {
  const only = parseOnlyArgs(argv);
  if (only) manifest = selectManifestOps(CONVERSION_MANIFEST, only);
} catch (err) {
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
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
  `Manifest: v${CONVERSION_MANIFEST.version}, ${manifest.ops.length} of ${CONVERSION_MANIFEST.ops.length} op(s)`
);
if (manifest !== CONVERSION_MANIFEST)
  console.log(`Only:     ${manifest.ops.map((o) => o.opKey).join(", ")}`);
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

/**
 * A def's lens: "base" (workspace_id NULL) or the overlay's workspace id. NOT
 * "pod-wide": a base def is visible wherever its PROFILE is — pod-wide on the
 * system row, but only one workspace on a workspace twin.
 */
function fmtLens(workspaceId: string | null): string {
  return workspaceId === null ? "base" : workspaceId;
}

/**
 * Every field the op moves, re-stamps or leaves behind — the table the operator
 * reads before `--apply`. Rows come from the engine's own apply statements (see
 * `FieldPlanRow`), so this is what the apply will do, not an estimate.
 */
function printFieldPlan(opKey: string, rows: FieldPlanRow[]) {
  console.log(`FIELD PLAN — ${opKey} (${rows.length} field(s))`);
  if (rows.length === 0) {
    console.log("   no property defs or links change\n");
    return;
  }
  const header =
    "   " +
    "ACTION".padEnd(19) +
    "TABLE".padEnd(19) +
    "SLUG".padEnd(24) +
    "FROM LENS".padEnd(38) +
    "TO LENS".padEnd(38) +
    "NOTE";
  console.log(header);
  for (const row of rows) {
    const note = row.action.endsWith("-skipped")
      ? `${row.collidesWith ? `folds with '${row.collidesWith}'; ` : ""}` +
        `${row.entitiesWithKey ?? 0} entit(ies) hold this key`
      : "";
    console.log(
      "   " +
        row.action.padEnd(19) +
        row.table.padEnd(19) +
        row.slug.padEnd(24) +
        fmtLens(row.fromWorkspaceId).padEnd(38) +
        fmtLens(row.toWorkspaceId).padEnd(38) +
        note
    );
  }
  const left = rows.filter((row) => row.action.endsWith("-skipped"));
  const scoped = rows.filter((row) => row.action === "restamped");
  console.log(
    `   → ${scoped.length} base def(s) re-stamped as workspace overlays; ` +
      `${left.length} field(s) LEFT BEHIND on the drained row, holding values on ` +
      `${left.reduce((n, row) => n + (row.entitiesWithKey ?? 0), 0)} entity row(s)` +
      (left.length
        ? " — these keys lose their schema once the tail deactivates the row"
        : "") +
      "\n"
  );
}

async function main() {
  const summary = await runConversions(sql, manifest, {
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

  for (const r of summary.results) {
    if (r.planDetail) printFieldPlan(r.opKey, r.planDetail);
  }

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
