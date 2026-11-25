/**
 * The conversion runner, as a function: one body behind both entry points —
 * `packages/database/src/scripts/run-conversions.ts` (tsx, a source checkout)
 * and `packages/api/src/scripts/run-conversions-cli.ts` (`node
 * dist/scripts/run-conversions.js` inside the backend container, where the
 * source script is not shipped).
 *
 *   --apply                      write for real, record the ledger (default: DRY RUN)
 *   --destructive-tail           with --apply: deactivate merged-away source profiles
 *   --only <opKey>[,<opKey>]     restrict to named op(s), manifest order
 *
 * Returns the process exit code; it never calls process.exit itself.
 */

import postgres from "postgres";
import {
  CONVERSION_MANIFEST,
  runConversions,
  parseOnlyArgs,
  selectManifestOps,
  type FieldPlanRow,
} from "./index.js";

function fmtCounts(counts: object): string {
  const parts = Object.entries(counts as Record<string, number>)
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

export async function runConversionsCli(
  argv: string[],
  env: NodeJS.ProcessEnv
): Promise<number> {
  const args = new Set(argv);
  const apply = args.has("--apply");
  const dryRun = !apply;
  const destructiveTail = args.has("--destructive-tail");

  if (destructiveTail && dryRun) {
    console.error(
      "❌ --destructive-tail requires --apply (a dry run writes nothing to destroy)."
    );
    return 1;
  }

  let manifest = CONVERSION_MANIFEST;
  try {
    const only = parseOnlyArgs(argv);
    if (only) manifest = selectManifestOps(CONVERSION_MANIFEST, only);
  } catch (err) {
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("❌ ERROR: DATABASE_URL environment variable is required");
    return 1;
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
  try {
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
      return 1;
    }

    if (dryRun) {
      console.log(
        "🔍 Dry run complete — nothing was written. Re-run with --apply to commit.\n"
      );
    } else {
      console.log("✅ Conversion run complete.\n");
    }
    return 0;
  } catch (error) {
    console.error("❌ Fatal error:", error);
    return 1;
  } finally {
    await sql.end().catch(() => {});
  }
}
