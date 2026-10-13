/**
 * Sync for a source a pod admin added. Called by
 * `cp-catalog-sync` for every enabled non-official source, on the same
 * 10-minute schedule, and by the console's "Sync now".
 *
 *   1. fetch `synap-index.json` + `.sig` anonymously (marketplace-source-fetch);
 *   2. verify it against the PINNED key (marketplace-source-verify):
 *        key changed  → the source is blocked until a person re-approves;
 *        bad / expired / older than the last accepted copy / unreachable →
 *          the last verified rows stay, and stop serving installs once that
 *          index's own `expires` passes;
 *   3. replace the source's `cp_catalog_cache` rows with exactly the signed
 *      list — the index is the whole catalog, so a package it no longer lists
 *      is pruned (per source; never another source's rows). Only while the
 *      source is still on the pod under the key this sync verified: a sync
 *      that races a remove (or a key re-approval) writes nothing;
 *   4. record the outcome under `marketplaceSourceStatus.<id>`.
 *
 * Rows from an added source are keyed by its id (`acme`), carry no
 * definition (it is fetched and digest-checked at install time) and carry the
 * signed listing facts in `listing`. They do not write the official catalog's
 * `catalogSyncStamps`, so a third-party source can never move the pod's own
 * health or template-completeness signals.
 */

import {
  db,
  drizzleSql,
  and,
  eq,
  notInArray,
  recordMarketplaceSourceStatus,
  type MarketplaceSourceStatus,
} from "@synap/database";
import {
  cpCatalogCache,
  podSettings,
  type NewCpCatalogCacheRow,
} from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import type { MarketplaceIndex } from "@synap-core/types/marketplace-source";
import type { CatalogSource } from "./cp-catalog-sync.js";
import {
  fetchSourceIndex,
  resolveDefinitionUrl,
  type SourceFetch,
} from "./marketplace-source-fetch.js";
import {
  verifyIndex,
  type IndexRejection,
} from "./marketplace-source-verify.js";

const logger = createLogger({ module: "marketplace-source-sync" });

const STATE_FOR: Record<IndexRejection, MarketplaceSourceStatus["state"]> = {
  too_large: "invalid",
  invalid: "invalid",
  unsigned: "invalid",
  bad_signature: "bad_signature",
  expired: "expired",
  replayed: "invalid",
  key_changed: "key_changed",
};

/**
 * The cache rows one verified index stands for. Pure. A package whose
 * definition is not on the index's own https origin is left out (the pod will
 * never fetch it), and named in `skipped`.
 */
export function listingRows(
  sourceId: string,
  indexUrl: string,
  index: MarketplaceIndex,
  now: Date
): { rows: NewCpCatalogCacheRow[]; skipped: string[] } {
  const rows: NewCpCatalogCacheRow[] = [];
  const skipped: string[] = [];
  for (const pkg of index.packages) {
    const definitionUrl = resolveDefinitionUrl(indexUrl, pkg.definitionUrl);
    if (!definitionUrl) {
      skipped.push(pkg.slug);
      continue;
    }
    rows.push({
      source: sourceId,
      kind: pkg.kind,
      slug: pkg.slug,
      name: pkg.displayName,
      description: pkg.description ?? null,
      version: pkg.version,
      tier: pkg.requiredTier ?? null,
      vendor: null,
      tags: pkg.tags ?? null,
      contentHash: pkg.sha256,
      definition: null,
      listing: {
        definitionUrl,
        sha256: pkg.sha256,
        installUrl: pkg.installUrl ?? null,
        homepageUrl: pkg.homepageUrl ?? null,
        icon: pkg.icon ?? null,
      },
      retiredAt: null,
      replacedBySlug: null,
      retiredReason: null,
      syncedAt: now,
    });
  }
  return { rows, skipped };
}

/**
 * Make the source's cached rows exactly `rows` (upsert, then prune the rest)
 * — only while the source is still on the pod, pinned to the key this sync
 * verified under. That is read under a SHARE lock on the settings row, inside
 * this transaction: a remove or key re-approval rewrites the row under an
 * update lock, so it either committed first (seen here: nothing is written)
 * or waits until these rows are in, then removes them itself. Returns false
 * when the source is gone.
 */
async function replaceSourceRows(
  source: CatalogSource,
  rows: NewCpCatalogCacheRow[]
): Promise<boolean> {
  const sourceId = source.id;
  return db.transaction(async (tx) => {
    const [settingsRow] = await tx
      .select({ settings: podSettings.settings })
      .from(podSettings)
      .orderBy(podSettings.createdAt)
      .limit(1)
      .for("share");
    const listed = settingsRow?.settings?.marketplaceSources;
    const stillPinned =
      Array.isArray(listed) &&
      listed.some(
        (s) =>
          s.id === sourceId &&
          (s.publicKey ?? null) === (source.publicKey ?? null)
      );
    if (!stillPinned) return false;
    if (rows.length > 0) {
      await tx
        .insert(cpCatalogCache)
        .values(rows)
        .onConflictDoUpdate({
          target: [
            cpCatalogCache.source,
            cpCatalogCache.kind,
            cpCatalogCache.slug,
          ],
          set: {
            name: drizzleSql.raw("excluded.name"),
            description: drizzleSql.raw("excluded.description"),
            version: drizzleSql.raw("excluded.version"),
            tier: drizzleSql.raw("excluded.tier"),
            vendor: drizzleSql.raw("excluded.vendor"),
            tags: drizzleSql.raw("excluded.tags"),
            contentHash: drizzleSql.raw("excluded.content_hash"),
            definition: drizzleSql.raw("excluded.definition"),
            listing: drizzleSql.raw("excluded.listing"),
            retiredAt: drizzleSql.raw("excluded.retired_at"),
            replacedBySlug: drizzleSql.raw("excluded.replaced_by_slug"),
            retiredReason: drizzleSql.raw("excluded.retired_reason"),
            syncedAt: drizzleSql.raw("excluded.synced_at"),
          },
        });
    }
    const keep = rows.map((r) => `${r.kind}|${r.slug}`);
    await tx
      .delete(cpCatalogCache)
      .where(
        keep.length > 0
          ? and(
              eq(cpCatalogCache.source, sourceId),
              notInArray(
                drizzleSql`${cpCatalogCache.kind} || '|' || ${cpCatalogCache.slug}`,
                keep
              )
            )
          : eq(cpCatalogCache.source, sourceId)
      );
    return true;
  });
}

/** Drop every cached row of a source (it was removed). */
export async function deleteSourceRows(sourceId: string): Promise<void> {
  await db.delete(cpCatalogCache).where(eq(cpCatalogCache.source, sourceId));
}

export interface SyncDeps {
  fetchImpl?: SourceFetch;
  now?: Date;
}

/** Sync one added source. Never throws; returns (and records) its status. */
export async function syncThirdPartySource(
  source: CatalogSource,
  previous: MarketplaceSourceStatus | undefined,
  deps: SyncDeps = {}
): Promise<MarketplaceSourceStatus> {
  const now = deps.now ?? new Date();
  const kept = {
    lastSyncAt: now.toISOString(),
    lastOkAt: previous?.lastOkAt ?? null,
    packageCount: previous?.packageCount ?? 0,
    validUntil: previous?.validUntil ?? null,
    pendingPublicKey: null,
    pendingFingerprint: null,
  };
  // Set when the source was removed (or re-keyed) while this sync ran: its
  // status is not recorded either, so a removed source leaves nothing behind.
  let gone = false;
  const attempt = await (async (): Promise<MarketplaceSourceStatus> => {
    // A trusted source is only ever stored with a pinned key; one without is
    // refused rather than verified against whatever key the index declares.
    if (source.trust !== "showcase" && !source.publicKey) {
      return {
        ...kept,
        state: "invalid",
        message:
          "This source has no pinned signing key — remove it and add it again.",
      };
    }
    const fetched = await fetchSourceIndex(source.url, deps.fetchImpl);
    if (!fetched.ok) {
      return {
        ...kept,
        state: fetched.reason === "unreachable" ? "unreachable" : "invalid",
        message: fetched.message,
      };
    }
    const verdict = verifyIndex({
      indexBytes: fetched.indexBytes,
      signature: fetched.signature,
      pinnedKey: source.publicKey,
      requireSignature: source.trust !== "showcase",
      expectedSourceId: source.id,
      lastAcceptedExpires: previous?.validUntil ?? null,
      now,
    });
    if (!verdict.ok) {
      return {
        ...kept,
        state: STATE_FOR[verdict.reason],
        message: verdict.message,
        ...(verdict.reason === "key_changed"
          ? {
              pendingPublicKey: verdict.newPublicKey ?? null,
              pendingFingerprint: verdict.newFingerprint ?? null,
            }
          : {}),
      };
    }
    const { rows, skipped } = listingRows(
      source.id,
      fetched.indexUrl,
      verdict.index,
      now
    );
    try {
      gone = !(await replaceSourceRows(source, rows));
    } catch (err) {
      logger.error(
        { err, source: source.id },
        "Failed to store a source's catalog"
      );
      return {
        ...kept,
        state: previous?.state === "ok" ? "ok" : "pending",
        message:
          "The pod verified the catalog but could not store it — it retries on the next sync.",
      };
    }
    return {
      ...kept,
      state: "ok",
      lastOkAt: now.toISOString(),
      packageCount: rows.length,
      validUntil: verdict.index.expires,
      message:
        skipped.length > 0
          ? `${skipped.length} package${skipped.length === 1 ? "" : "s"} left out: the definition is not on the source's own https address (${skipped.slice(0, 5).join(", ")}).`
          : null,
    };
  })();

  // A key change stays a block until a person re-approves (or the source is
  // signed by the pinned key again): a later outage or a bad signature must
  // not quietly lift it.
  const status: MarketplaceSourceStatus =
    previous?.state === "key_changed" &&
    attempt.state !== "ok" &&
    attempt.state !== "key_changed"
      ? {
          ...attempt,
          state: "key_changed",
          pendingPublicKey: previous.pendingPublicKey ?? null,
          pendingFingerprint: previous.pendingFingerprint ?? null,
          message: previous.message,
        }
      : attempt;

  if (gone) {
    logger.info(
      { source: source.id },
      "Marketplace source changed or was removed during its sync — nothing written"
    );
    return status;
  }
  if (status.state !== "ok") {
    logger.warn(
      { source: source.id, state: status.state, message: status.message },
      "Marketplace source did not sync — its last verified catalog stays"
    );
  }
  await recordMarketplaceSourceStatus(source.id, status);
  return status;
}
