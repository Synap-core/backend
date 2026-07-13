/**
 * Backfill — settings.defaultSources → `provider --feeds--> consumer` links.
 *
 * Wave 4 of WORKSPACE-RESOLUTION-PLAN.md. `settings.defaultSources` (JSONB,
 * `{ [domain]: { workspaceId, capability?, profileSlug?, label? } }`, stored on
 * the CONSUMER workspace) is a write-only precursor: it names a provider
 * workspace per domain but nothing reads it as a graph edge today. This script
 * materializes each entry as a first-class `workspace --feeds--> workspace` row
 * in `links` (provider → consumer), which the resolver's rung 4 and lens
 * propagation (Wave 5) can then query directly instead of every caller
 * re-parsing JSONB.
 *
 * Idempotent on the `links` unique edge (from_type, from_id, to_type, to_id,
 * link_type) — safe to re-run. Does NOT delete or modify `defaultSources`
 * (dual-read comes later; deleting the JSONB precursor is a destructive tail
 * owed separately, per the plan's secondary-effects register).
 *
 * Run (against the pod your DATABASE_URL points at):
 *   tsx packages/database/src/scripts/backfill-default-sources-edges.ts          # dry run (default)
 *   tsx packages/database/src/scripts/backfill-default-sources-edges.ts --apply  # writes for real
 *
 * NOTE on location: the plan asked for `scripts/backfill-default-sources-edges.mjs`
 * at the synap-backend repo root, but root `scripts/` has no dependency on the
 * `postgres` driver (strict pnpm — only `packages/database` depends on it), so a
 * root-level script importing it directly does not resolve. This file lives
 * beside `migrate.ts` / `run-conversions.ts`, the repo's existing pg-env-var ops
 * scripts, which already solve that problem the same way. Invoke via
 * `pnpm --filter @synap/database backfill:default-sources-edges` or `tsx` directly.
 */

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck - executed by tsx, not compiled
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("❌ ERROR: DATABASE_URL environment variable is required");
  process.exit(1);
}

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const dryRun = !apply;

console.log("📦 Backfill: defaultSources → feeds edges\n");
console.log(`Mode: ${dryRun ? "DRY RUN (no writes)" : "APPLY"}\n`);

const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });

interface WorkspaceRow {
  id: string;
  name: string;
  settings: Record<string, unknown> | null;
  archived_at: Date | null;
}

interface DefaultSource {
  workspaceId: string;
  capability?: string;
  profileSlug?: string;
  label?: string;
}

async function main(): Promise<void> {
  const workspaces = (await sql`
    SELECT id, name, settings, archived_at FROM workspaces
  `) as unknown as WorkspaceRow[];

  const byId = new Map(workspaces.map((w) => [w.id, w]));

  let planned = 0;
  let skippedExisting = 0;
  let skippedMissingProvider = 0;
  let created = 0;

  for (const consumer of workspaces) {
    if (consumer.archived_at) continue;
    const defaultSources = (consumer.settings?.defaultSources ?? {}) as Record<
      string,
      DefaultSource
    >;

    for (const [domain, source] of Object.entries(defaultSources)) {
      const providerId = source?.workspaceId;
      if (!providerId) continue;
      if (providerId === consumer.id) continue; // self-edge, not meaningful

      const provider = byId.get(providerId);
      if (!provider || provider.archived_at) {
        console.warn(
          `  ⚠️  ${consumer.name} (${consumer.id}) defaultSources.${domain} → missing/archived provider ${providerId} — skipped`
        );
        skippedMissingProvider++;
        continue;
      }

      const existing = await sql`
        SELECT id FROM links
        WHERE from_type = 'workspace' AND from_id = ${providerId}
          AND to_type = 'workspace' AND to_id = ${consumer.id}
          AND link_type = 'feeds'
      `;
      if (existing.length > 0) {
        skippedExisting++;
        continue;
      }

      planned++;
      console.log(
        `  ${dryRun ? "🔍" : "✅"} ${provider.name} --feeds--> ${consumer.name}  (domain=${domain}${
          source.capability ? `, capability=${source.capability}` : ""
        })`
      );

      if (apply) {
        // NOTE: postgres.js sql.json() is unreliable on some deployed images —
        // JSON.stringify + explicit ::jsonb cast is the proven-safe path (same
        // pattern used elsewhere in this codebase for jsonb columns).
        const metadata = JSON.stringify({
          domain,
          capability: source.capability ?? null,
          // Carry profileSlug so the feeds edge stays kind-scoped in the ladder
          // (loadFeedsProviders reads metadata->>'profileSlug'); dropping it made
          // every backfilled edge unconditionally domain-wide.
          profileSlug: source.profileSlug ?? null,
          label: source.label ?? null,
        });
        await sql`
          INSERT INTO links (workspace_id, from_type, from_id, to_type, to_id, link_type, metadata)
          VALUES (
            ${consumer.id},
            'workspace', ${providerId},
            'workspace', ${consumer.id},
            'feeds',
            ${metadata}::jsonb
          )
          ON CONFLICT (from_type, from_id, to_type, to_id, link_type) DO NOTHING
        `;
        created++;
      }
    }
  }

  console.log(
    `\nPlanned: ${planned}  Created: ${created}  Already-existing: ${skippedExisting}  Skipped (missing provider): ${skippedMissingProvider}`
  );
  if (dryRun) {
    console.log(
      "\n🔍 Dry run complete — nothing was written. Re-run with --apply to commit."
    );
  }
}

main()
  .catch((err) => {
    console.error("❌ Backfill failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end();
  });
