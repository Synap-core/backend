/**
 * Package Version Backfill Worker
 *
 * SELF-HEAL for pod workspaces installed BEFORE `settings.packageVersion`
 * existed as a concept: they show "can't check for updates" forever because
 * there is nothing to compare against, and `reconcileWorkspaceIfStale`
 * (`packages/api/src/services/workspace-creation-service.ts`) treats a NULL
 * `packageVersion` as `checked:false` — never wrong, but never able to prove
 * "up to date" either.
 *
 * The version hash itself is CP-MINTED (a content-hash stamp, e.g. `"h-<hash>"`)
 * — it cannot be computed pod-side, so this has to be a RUNTIME pass: for every
 * workspace that has a `package_slug` but no `settings.packageVersion`, look up
 * the CURRENTLY-KNOWN version for that slug and stamp it if found.
 *
 * `packages/jobs` cannot import `@synap/api` (circular dependency — api →
 * jobs, see `cp-catalog-sync.ts`'s header comment for the established
 * precedent), so this does NOT call `resolveWorkspaceTemplate` directly.
 * Instead it reads the SAME source that resolver's cache tier reads —
 * `cp_catalog_cache` (kind='template', slug) — for just the `version` column.
 * This is intentionally narrower than the full resolver: the resolver's
 * bundle-fallback tier exists to make workspace CREATION resilient to a cold
 * cache; a backfill has no such urgency; a cache-cold slug simply stays
 * unstamped and is picked up on a LATER run once `cp-catalog-sync` populates
 * it — expected, not a failure.
 *
 * Idempotent + re-runnable: the WHERE clause only selects rows still missing
 * `packageVersion`, so a stamped row drops out of scope on the next run
 * automatically. Runs on startup (mirrors `cp-catalog-sync`/
 * `capability-template-sync`) and on a schedule so newly-synced cache rows
 * eventually backfill their matching legacy workspaces without a redeploy.
 */

import { db, and, eq, drizzleSql, workspaces } from "@synap/database";
import { cpCatalogCache } from "@synap/database/schema";
import type { WorkspaceSettings } from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "package-version-backfill" });

export const PACKAGE_VERSION_BACKFILL_QUEUE = "package-version-backfill";
/** Cron schedule for this worker (every 30 minutes — a slow-moving backfill, not latency-sensitive). */
export const PACKAGE_VERSION_BACKFILL_CRON = "*/30 * * * *";

interface CandidateRow {
  id: string;
  packageSlug: string | null;
  settings: unknown;
}

/**
 * Backfill `settings.packageVersion` for every workspace that has a
 * `package_slug` but no version stamped yet, by looking up the freshest
 * KNOWN version for that slug in `cp_catalog_cache`. Never throws — a
 * per-workspace failure is logged and skipped, the rest of the batch
 * continues.
 */
export async function handlePackageVersionBackfill(): Promise<void> {
  const candidates: CandidateRow[] = await db
    .select({
      id: workspaces.id,
      packageSlug: workspaces.packageSlug,
      settings: workspaces.settings,
    })
    .from(workspaces)
    .where(
      and(
        drizzleSql`${workspaces.packageSlug} IS NOT NULL`,
        drizzleSql`(${workspaces.settings}->>'packageVersion') IS NULL`
      )
    );

  if (candidates.length === 0) {
    logger.debug("package-version-backfill: no candidates — nothing to do");
    return;
  }

  // Resolve every distinct slug's version ONCE (not per-workspace) — several
  // legacy workspaces commonly share a template slug.
  const slugs = [...new Set(candidates.map((c) => c.packageSlug!))];
  const versionBySlug = new Map<string, string>();
  for (const slug of slugs) {
    try {
      const [row] = await db
        .select({ version: cpCatalogCache.version })
        .from(cpCatalogCache)
        .where(
          and(
            eq(cpCatalogCache.kind, "template"),
            eq(cpCatalogCache.slug, slug)
          )
        )
        .limit(1);
      if (row?.version) versionBySlug.set(slug, row.version);
    } catch (err) {
      logger.warn(
        { err, slug },
        "package-version-backfill: cache lookup failed for slug (non-fatal, will retry next run)"
      );
    }
  }

  let stamped = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    const version = candidate.packageSlug
      ? versionBySlug.get(candidate.packageSlug)
      : undefined;
    if (!version) {
      // Cache-cold for this slug (not yet synced, or no CP-known template) —
      // expected, not a failure. Leave unstamped for a later run.
      skipped++;
      continue;
    }
    try {
      const currentSettings = (candidate.settings ?? {}) as WorkspaceSettings;
      await db
        .update(workspaces)
        .set({
          settings: {
            ...currentSettings,
            packageVersion: version,
          } satisfies WorkspaceSettings,
        })
        .where(eq(workspaces.id, candidate.id));
      stamped++;
    } catch (err) {
      logger.warn(
        { err, workspaceId: candidate.id, slug: candidate.packageSlug },
        "package-version-backfill: failed to stamp packageVersion for workspace (non-fatal)"
      );
    }
  }

  logger.info(
    { candidates: candidates.length, stamped, skipped },
    "package-version-backfill: run complete"
  );
}
