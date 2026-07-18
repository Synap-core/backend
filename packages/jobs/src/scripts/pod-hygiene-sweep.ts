/**
 * Pod Hygiene — Hard-Delete Sweep (one-time admin door)
 *
 * Purpose (2026-07-17, user-approved POD-HYGIENE decisions):
 *   H1 — sweep Superwhisper dictation notes OLDER THAN 7 days (`--keep-days`).
 *   H2 — delete the ~12 named test fixtures outright.
 *   H4 — HARD delete, no grace/soft-delete window, INCLUDING each note's linked
 *        transcript document rows + their MinIO blobs.
 *   (H3 — the Content OS purge is done separately via the existing CLI; NOT here.)
 *
 * This is the "delete-by-filter" door that the per-entity `entities.delete`
 * (soft) and `entities.adminBatchDelete` (hard, but leaves relation/typesense
 * orphans) don't cover. It mirrors the canonical deletion semantics:
 *
 *   - Linked documents + blobs: same as `entities.delete`'s optional
 *     document-deletion branch — resolve the documents, delete the
 *     `storage_key` blob best-effort via `@synap/storage`'s `storage.delete()`
 *     (the same utility the router uses), then delete the `documents` row
 *     (which cascades `document_versions` / `document_sessions`).
 *   - Relations: `relations.source_entity_id` / `target_entity_id` are plain
 *     uuid columns with NO FK to `entities`, so a hard entity delete does NOT
 *     cascade them — we delete them explicitly to avoid graph orphans.
 *   - All other entity children cascade at the DB level on the entity delete
 *     (`entity_vectors`, `entity_facets`, `entity_property_index`,
 *     `entity_identity_signals`, `entity_centrality`, `enrichments`,
 *     `entity_external_links`, signal links — all `onDelete: "cascade"`).
 *   - Typesense: the soft-delete path fires a `search-index` delete job via
 *     `emitSideEffects`. A raw hard delete does not, so we enqueue the SAME
 *     `search-index` delete job directly through pg-boss for each removed
 *     entity + document. We deliberately do NOT route through the full
 *     `emitSideEffects` chain — that would also fire webhooks, cross-thread
 *     notifications and AI-correction feedback signals, none of which are
 *     wanted for a bulk one-time purge. If pg-boss is unreachable this step is
 *     skipped (recorded in the report); the periodic full search-reindex cron
 *     prunes stale Typesense docs as a safety net.
 *
 * SAFETY: dry-run is the DEFAULT. Nothing is written without `--execute`.
 * A per-run `--limit` hard-caps how many entities are deleted.
 *
 * Usage (against the pod your DATABASE_URL points at):
 *   tsx packages/jobs/src/scripts/pod-hygiene-sweep.ts --superwhisper                # dry run
 *   tsx packages/jobs/src/scripts/pod-hygiene-sweep.ts --superwhisper --keep-days 7  # dry run, custom age
 *   tsx packages/jobs/src/scripts/pod-hygiene-sweep.ts --superwhisper --execute      # DELETE
 *   tsx packages/jobs/src/scripts/pod-hygiene-sweep.ts --fixtures                    # dry run
 *   tsx packages/jobs/src/scripts/pod-hygiene-sweep.ts --fixtures --include-borderline --execute
 *   ... add --limit <n> to cap deletions, --json for a machine-readable summary.
 *
 * Or via the package script:
 *   pnpm --filter @synap/jobs pod-hygiene-sweep -- --superwhisper
 */

import { sql } from "@synap/database";
import { getBoss, startBoss, stopBoss } from "@synap/events";
import { storage } from "@synap/storage";

// ────────────────────────────────────────────────────────────────────────────
// Pure helpers (unit-tested — see pod-hygiene-sweep.test.ts)
// ────────────────────────────────────────────────────────────────────────────

export const DEFAULT_KEEP_DAYS = 7;
export const DEFAULT_LIMIT = 5000;
export const SUPERWHISPER_SOURCE = "superwhisper";

/**
 * The cutoff instant for "older than N days": an entity is swept when its
 * `created_at` is STRICTLY BEFORE this value. `keepDays = 7` at now=T means
 * anything created before (T − 7d) goes; the most recent 7 days are kept.
 */
export function keepDaysCutoff(keepDays: number, now: Date): Date {
  const cutoff = new Date(now.getTime());
  cutoff.setUTCDate(cutoff.getUTCDate() - keepDays);
  return cutoff;
}

export interface FixtureMatcher {
  /** Human-readable label for the report. */
  label: string;
  mode: "exact" | "prefix";
  title: string;
  /** If set, the entity's `type` (profileSlug) must be one of these. */
  types?: string[];
  /** Borderline fixtures are only deleted with `--include-borderline`. */
  borderline?: boolean;
  /** Approximate expected row count — a deviation is flagged in the report. */
  expected?: number;
}

/**
 * The H2 fixture set. Person/company test fixtures and note test fixtures are
 * matched by exact title or title-prefix; each group is type-restricted so a
 * legitimately-named real entity (e.g. a real "Jane Doe" note) is never caught.
 * 'Bob Smith' / 'Alice Chen' are borderline (07-16 test captures) — surfaced in
 * every dry run but only deleted when the operator passes --include-borderline.
 */
export function buildFixtureMatchers(): FixtureMatcher[] {
  const PC = ["person", "company"];
  return [
    {
      label: "Acme Corp",
      mode: "exact",
      title: "Acme Corp",
      types: PC,
      expected: 3,
    },
    {
      label: "Acme Studios",
      mode: "exact",
      title: "Acme Studios",
      types: PC,
      expected: 1,
    },
    {
      label: "Northwind Logistics",
      mode: "exact",
      title: "Northwind Logistics",
      types: PC,
      expected: 1,
    },
    {
      label: "Sarah Chen",
      mode: "exact",
      title: "Sarah Chen",
      types: PC,
      expected: 2,
    },
    {
      label: "Jane Doe",
      mode: "exact",
      title: "Jane Doe",
      types: PC,
      expected: 1,
    },
    {
      label: "gtest1781999884*",
      mode: "prefix",
      title: "gtest1781999884",
      types: PC,
      expected: 2,
    },
    {
      label: "Stamp Synap project*",
      mode: "prefix",
      title: "Stamp Synap project",
      types: ["note"],
    },
    {
      label: "Project stamp test*",
      mode: "prefix",
      title: "Project stamp test",
      types: ["note"],
    },
    {
      label: "Dogfood project link test*",
      mode: "prefix",
      title: "Dogfood project link test",
      types: ["note"],
    },
    {
      label: "CLI-mirror note*",
      mode: "prefix",
      title: "CLI-mirror note",
      types: ["note"],
    },
    {
      label: "Bob Smith (borderline)",
      mode: "exact",
      title: "Bob Smith",
      types: ["person"],
      borderline: true,
    },
    {
      label: "Alice Chen (borderline)",
      mode: "exact",
      title: "Alice Chen",
      types: ["person"],
      borderline: true,
    },
  ];
}

/** Does a single entity row match a fixture matcher (title + type)? Pure. */
export function fixtureMatches(
  row: { title: string | null; type: string },
  matcher: FixtureMatcher
): boolean {
  const title = row.title ?? "";
  const titleOk =
    matcher.mode === "exact"
      ? title === matcher.title
      : title.startsWith(matcher.title);
  if (!titleOk) return false;
  if (matcher.types && !matcher.types.includes(row.type)) return false;
  return true;
}

/** SQL pre-filter inputs derived from the matcher set (exact titles + LIKE patterns). */
export function fixtureSqlFilters(matchers: FixtureMatcher[]): {
  exactTitles: string[];
  prefixPatterns: string[];
} {
  const exactTitles: string[] = [];
  const prefixPatterns: string[] = [];
  for (const m of matchers) {
    if (m.mode === "exact") exactTitles.push(m.title);
    else prefixPatterns.push(`${m.title}%`);
  }
  return { exactTitles, prefixPatterns };
}

// ────────────────────────────────────────────────────────────────────────────
// IO / execution
// ────────────────────────────────────────────────────────────────────────────

/** timestamptz columns arrive as Date, computed columns as string — accept both. */
function isoDate(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

interface CandidateRow {
  id: string;
  type: string;
  title: string | null;
  workspace_id: string | null;
  document_id: string | null;
  source_file_document_id: string | null;
  created_at: Date | string;
}

interface SweepReport {
  mode: string;
  dryRun: boolean;
  matched: number;
  processed: number;
  limited: boolean;
  entitiesDeleted: number;
  documentsDeleted: number;
  blobsDeleted: number;
  blobFailures: number;
  searchJobsEnqueued: number;
  searchEnqueueSkipped: boolean;
  oldest: string | null;
  newest: string | null;
  samples: Array<{
    id: string;
    title: string | null;
    type: string;
    workspace_id: string | null;
  }>;
  docCount: number;
}

interface CliOptions {
  mode: "superwhisper" | "fixtures" | null;
  keepDays: number;
  includeBorderline: boolean;
  execute: boolean;
  limit: number;
  json: boolean;
}

export function parseArgs(argv: string[]): CliOptions {
  const args = argv.slice(2);
  const has = (f: string) => args.includes(f);
  const valOf = (f: string, fallback: number): number => {
    const i = args.indexOf(f);
    if (i === -1 || i + 1 >= args.length) return fallback;
    const n = Number(args[i + 1]);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const mode = has("--superwhisper")
    ? "superwhisper"
    : has("--fixtures")
      ? "fixtures"
      : null;
  return {
    mode,
    keepDays: valOf("--keep-days", DEFAULT_KEEP_DAYS),
    includeBorderline: has("--include-borderline"),
    execute: has("--execute"),
    limit: valOf("--limit", DEFAULT_LIMIT),
    json: has("--json"),
  };
}

/** Collect the distinct linked-document ids (own doc + transcript source). */
function docIdsFor(row: CandidateRow): string[] {
  const ids = new Set<string>();
  if (row.document_id) ids.add(row.document_id);
  if (row.source_file_document_id) ids.add(row.source_file_document_id);
  return [...ids];
}

async function fetchSuperwhisperCandidates(
  keepDays: number,
  now: Date
): Promise<CandidateRow[]> {
  const cutoff = keepDaysCutoff(keepDays, now);
  return (await sql`
    SELECT id, type, title, workspace_id, document_id,
           properties->>'sourceFileDocumentId' AS source_file_document_id,
           -- The keep-days window keys on DICTATION time, not row creation:
           -- the whole corpus was bulk-(re)imported in one window on
           -- 2026-07-15, so created_at is the import instant. Superwhisper
           -- stamps the real moment in properties.datetime (ISO, present on
           -- all rows — verified live); created_at is only the fallback.
           COALESCE((properties->>'datetime')::timestamptz, created_at) AS created_at
    FROM entities
    WHERE deleted_at IS NULL
      AND type = 'note'
      AND properties->>'source' = ${SUPERWHISPER_SOURCE}
      AND workspace_id IS NULL
      AND COALESCE((properties->>'datetime')::timestamptz, created_at) < ${cutoff.toISOString()}
    -- ORDER BY the output alias — Postgres resolves it to the COALESCE above.
    ORDER BY created_at ASC
  `) as unknown as CandidateRow[];
}

async function fetchFixtureCandidates(
  matchers: FixtureMatcher[]
): Promise<CandidateRow[]> {
  const { exactTitles, prefixPatterns } = fixtureSqlFilters(matchers);
  const rows = (await sql`
    SELECT id, type, title, workspace_id, document_id,
           properties->>'sourceFileDocumentId' AS source_file_document_id,
           created_at
    FROM entities
    WHERE deleted_at IS NULL
      AND (title = ANY(${exactTitles}) OR title LIKE ANY(${prefixPatterns}))
    ORDER BY created_at ASC
  `) as unknown as CandidateRow[];
  // Authoritative JS filter: enforce type restriction the SQL pre-filter can't.
  return rows.filter((r) => matchers.some((m) => fixtureMatches(r, m)));
}

/**
 * Resolve the documents (id + storage_key) linked to a set of entity rows,
 * so we know which blobs to delete and which document rows to purge.
 */
async function resolveDocuments(
  rows: CandidateRow[]
): Promise<Map<string, { id: string; storage_key: string | null }>> {
  const allDocIds = [...new Set(rows.flatMap(docIdsFor))];
  const byId = new Map<string, { id: string; storage_key: string | null }>();
  if (allDocIds.length === 0) return byId;
  const docs = (await sql`
    SELECT id, storage_key FROM documents WHERE id = ANY(${allDocIds})
  `) as unknown as Array<{ id: string; storage_key: string | null }>;
  for (const d of docs) byId.set(d.id, d);
  return byId;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("❌ DATABASE_URL is required");
    process.exit(1);
  }
  const opts = parseArgs(process.argv);
  if (!opts.mode) {
    console.error(
      "Usage: pod-hygiene-sweep --superwhisper | --fixtures [--keep-days N] " +
        "[--include-borderline] [--limit N] [--execute] [--json]"
    );
    process.exit(1);
  }

  const now = new Date();
  const matchers = buildFixtureMatchers();

  // 1. Gather candidates.
  let candidates: CandidateRow[];
  if (opts.mode === "superwhisper") {
    candidates = await fetchSuperwhisperCandidates(opts.keepDays, now);
  } else {
    const allFixtures = await fetchFixtureCandidates(matchers);
    // Split borderline out unless the operator opted in.
    const isBorderline = (r: CandidateRow) =>
      matchers.some((m) => m.borderline && fixtureMatches(r, m));
    if (!opts.json) {
      const border = allFixtures.filter(isBorderline);
      if (border.length > 0) {
        console.log(
          `\n⚖️  Borderline fixtures (${border.length}) — ${
            opts.includeBorderline
              ? "INCLUDED (--include-borderline)"
              : "EXCLUDED"
          }:`
        );
        for (const r of border) {
          console.log(
            `     - "${r.title}" (${r.type})  workspace_id=${r.workspace_id ?? "NULL"}  id=${r.id}`
          );
        }
      }
      // Per-matcher count verification.
      console.log("\n🔎 Fixture match counts (actual vs expected):");
      for (const m of matchers) {
        const c = allFixtures.filter((r) => fixtureMatches(r, m)).length;
        const flag =
          m.expected !== undefined && c !== m.expected
            ? `  ⚠️ expected ${m.expected}`
            : "";
        console.log(`     - ${m.label}: ${c}${flag}`);
      }
    }
    candidates = opts.includeBorderline
      ? allFixtures
      : allFixtures.filter((r) => !isBorderline(r));
  }

  const docMap = await resolveDocuments(candidates);
  const linkedDocCount = new Set(candidates.flatMap(docIdsFor)).size;

  // 2. Apply the per-run hard cap.
  const limited = candidates.length > opts.limit;
  const toProcess = candidates.slice(0, opts.limit);

  const report: SweepReport = {
    mode: opts.mode,
    dryRun: !opts.execute,
    matched: candidates.length,
    processed: toProcess.length,
    limited,
    entitiesDeleted: 0,
    documentsDeleted: 0,
    blobsDeleted: 0,
    blobFailures: 0,
    searchJobsEnqueued: 0,
    searchEnqueueSkipped: false,
    // postgres.js returns COMPUTED columns (the COALESCE dictation-time) as
    // strings, not Dates — the documented pod gotcha. Normalize either shape.
    oldest: candidates.length ? isoDate(candidates[0].created_at) : null,
    newest: candidates.length
      ? isoDate(candidates[candidates.length - 1].created_at)
      : null,
    samples: candidates.slice(0, 10).map((r) => ({
      id: r.id,
      title: r.title,
      type: r.type,
      workspace_id: r.workspace_id,
    })),
    docCount: linkedDocCount,
  };

  // 3. Dry run: report and exit.
  if (!opts.execute) {
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`\n📋 DRY RUN — mode=${opts.mode}`);
      console.log(`   Matched entities:   ${report.matched}`);
      console.log(
        `   Would process:      ${report.processed}${limited ? ` (capped by --limit ${opts.limit})` : ""}`
      );
      console.log(`   Linked documents:   ${report.docCount}`);
      console.log(
        `   Oldest / newest:    ${report.oldest ?? "—"}  /  ${report.newest ?? "—"}`
      );
      console.log(`\n   Sample (up to 10):`);
      for (const s of report.samples) {
        console.log(`     - "${s.title}" (${s.type})  id=${s.id}`);
      }
      console.log(
        `\n🔍 Nothing written. Re-run with --execute to hard-delete.` +
          (opts.mode === "fixtures" && !opts.includeBorderline
            ? " Add --include-borderline to also remove borderline fixtures."
            : "")
      );
    }
    return;
  }

  // 4. Execute — start pg-boss best-effort for Typesense cleanup.
  let boss: ReturnType<typeof getBoss> | null = null;
  try {
    await startBoss();
    boss = getBoss();
  } catch (err) {
    report.searchEnqueueSkipped = true;
    console.warn(
      `⚠️  pg-boss unavailable — skipping Typesense delete jobs (full-reindex cron will prune). ${
        err instanceof Error ? err.message : err
      }`
    );
  }

  for (const row of toProcess) {
    const docIds = docIdsFor(row);
    const docs = docIds
      .map((id) => docMap.get(id))
      .filter((d): d is { id: string; storage_key: string | null } => !!d);

    // 4a. Atomic DB deletes (relations → documents → entity+cascades).
    try {
      await sql.begin(async (txHandle) => {
        // postgres.js types the transaction handle as TransactionSql, which the
        // compiler doesn't see as template-callable; cast to the base client
        // shape (same pattern as conversions/engine.ts).
        const tx = txHandle as unknown as typeof sql;
        await tx`DELETE FROM relations WHERE source_entity_id = ${row.id} OR target_entity_id = ${row.id}`;
        if (docs.length > 0) {
          await tx`DELETE FROM documents WHERE id = ANY(${docs.map((d) => d.id)})`;
        }
        await tx`DELETE FROM entities WHERE id = ${row.id}`;
      });
    } catch (err) {
      console.error(
        `❌ Failed to delete entity ${row.id} ("${row.title}"):`,
        err instanceof Error ? err.message : err
      );
      continue; // never let one row abort the sweep
    }
    report.entitiesDeleted++;
    report.documentsDeleted += docs.length;

    // 4b. Best-effort blob deletes (a missing blob must not abort the sweep).
    for (const d of docs) {
      if (!d.storage_key) continue;
      try {
        await storage.delete(d.storage_key);
        report.blobsDeleted++;
      } catch {
        report.blobFailures++;
      }
    }

    // 4c. Best-effort Typesense delete jobs (same queue the reactor uses).
    if (boss) {
      try {
        await boss.send("search-index", {
          collection: "entities",
          operation: "delete",
          documentId: row.id,
          timestamp: Date.now(),
        });
        report.searchJobsEnqueued++;
        for (const d of docs) {
          await boss.send("search-index", {
            collection: "documents",
            operation: "delete",
            documentId: d.id,
            timestamp: Date.now(),
          });
          report.searchJobsEnqueued++;
        }
      } catch {
        // best-effort; reindex cron reconciles
      }
    }

    if (report.entitiesDeleted % 200 === 0) {
      console.log(`   … deleted ${report.entitiesDeleted}/${toProcess.length}`);
    }
  }

  if (boss) {
    try {
      await stopBoss();
    } catch {
      /* ignore */
    }
  }

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\n✅ EXECUTE complete — mode=${opts.mode}`);
    console.log(`   Entities deleted:   ${report.entitiesDeleted}`);
    console.log(`   Documents deleted:  ${report.documentsDeleted}`);
    console.log(
      `   Blobs deleted:      ${report.blobsDeleted}  (failures: ${report.blobFailures})`
    );
    console.log(
      `   Search jobs queued: ${report.searchJobsEnqueued}${
        report.searchEnqueueSkipped ? "  (skipped — pg-boss unavailable)" : ""
      }`
    );
    if (limited) {
      console.log(
        `\n⚠️  Capped at --limit ${opts.limit}. ${report.matched - report.processed} more remain — re-run to continue.`
      );
    }
  }
}

// Run only when invoked directly (not when imported by the unit test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("💥 Fatal:", err);
      process.exit(1);
    })
    .finally(async () => {
      try {
        await sql.end();
      } catch {
        /* ignore */
      }
    });
}
