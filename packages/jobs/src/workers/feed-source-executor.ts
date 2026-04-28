/**
 * Feed Source Executor Worker
 *
 * New provider-based executor for the pluggable source system (Phase 1 + 2).
 * Runs one fetch against one `source_subscription`:
 *
 *   1. Load subscription + source_config from DB.
 *   2. Resolve vault:// references in `config` with the owner's userId.
 *   3. Dispatch to the provider registered under `source_config.provider_type`.
 *   4. Persist the returned `nextToken` as the new cursor and update
 *      `last_fetched_at` / `last_item_at`.
 *   5. Return the SourceItems to the caller (the feed-level classifier and
 *      publisher remain Agent 3's responsibility — this worker is a
 *      transport layer only).
 *
 * Failure handling:
 *   - Vault resolution errors → subscription.status = 'error', errorMessage
 *   - Provider fetch errors   → subscription.status = 'error', errorMessage
 *   - Success                 → status stays 'active', errorMessage cleared
 *
 * Side-effects queue (`feed-source-items`) is fire-and-forget: whichever
 * classifier/publisher Agent 3 wires up will subscribe to it.
 */

import { db, eq } from "@synap/database";
import { sourceSubscriptions, sourceConfigs } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import { sourceProviderRegistry, type SourceItem } from "@synap/feed-service";
import { resolveVaultReferences } from "../utils/vault-resolver.js";
import { getBoss } from "@synap/events";

const logger = createLogger({ module: "feed-source-executor" });

/** Queue name — register in workers/index.ts. */
export const FEED_SOURCE_EXECUTE_QUEUE = "feed-source-execute";

/**
 * Downstream queue receiving items for classification / publishing. Payload
 * shape is minimal; Agent 3 owns the consumer.
 */
export const FEED_SOURCE_ITEMS_QUEUE = "feed-source-items";

// ── Job payload ──────────────────────────────────────────────────────────────

export interface FeedSourceExecutePayload {
  subscriptionId: string;
  /** Optional: echoed back in the downstream event for tracing. */
  runId?: string;
}

// ── Vault-aware config resolver ──────────────────────────────────────────────

/**
 * Walk `config` and resolve any vault://... string at any depth.
 *
 * `resolveVaultReferences()` from the API package only handles flat string
 * maps (`Record<string, string>`). Source configs can nest — e.g. the HTTP
 * API provider has `headers: Record<string,string>`, which may contain
 * `vault://` refs. This helper flattens the config into a string map,
 * delegates to the vault resolver, then rebuilds the original shape.
 *
 * Non-string values pass through unchanged.
 */
async function resolveConfigVault(
  config: Record<string, unknown>,
  userId: string
): Promise<Record<string, unknown>> {
  // 1. Walk and collect all string leaves into a flat map keyed by JSON path.
  const flat: Record<string, string> = {};
  const paths: Array<[string[], string]> = [];

  function walk(node: unknown, path: string[]): void {
    if (typeof node === "string") {
      const key = path.join(".");
      flat[key] = node;
      paths.push([path, node]);
    } else if (Array.isArray(node)) {
      node.forEach((child, idx) => walk(child, [...path, String(idx)]));
    } else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        walk(v, [...path, k]);
      }
    }
  }
  walk(config, []);

  // 2. Resolve via the server-vault-backed resolver.
  const resolved = await resolveVaultReferences(flat, userId);

  // 3. Rebuild the original structure with resolved strings swapped in.
  const out = structuredClone(config) as Record<string, unknown>;
  for (const [path] of paths) {
    const key = path.join(".");
    setByPath(out, path, resolved[key]);
  }
  return out;
}

function setByPath(
  root: Record<string, unknown>,
  path: string[],
  value: unknown
): void {
  if (path.length === 0) return;
  let node: unknown = root;
  for (let i = 0; i < path.length - 1; i++) {
    if (node == null) return;
    if (Array.isArray(node)) {
      const idx = Number.parseInt(path[i], 10);
      node = node[idx];
    } else if (typeof node === "object") {
      node = (node as Record<string, unknown>)[path[i]];
    }
  }
  const tail = path[path.length - 1];
  if (Array.isArray(node)) {
    const idx = Number.parseInt(tail, 10);
    node[idx] = value;
  } else if (node && typeof node === "object") {
    (node as Record<string, unknown>)[tail] = value;
  }
}

// ── Handler ──────────────────────────────────────────────────────────────────

export async function handleFeedSourceExecute(job: {
  data: FeedSourceExecutePayload;
}): Promise<{ ok: boolean; itemCount: number; error?: string }> {
  const { subscriptionId, runId } = job.data;

  const subscription = await db.query.sourceSubscriptions.findFirst({
    where: eq(sourceSubscriptions.id, subscriptionId),
  });
  if (!subscription) {
    logger.warn({ subscriptionId }, "Source subscription not found");
    return { ok: false, itemCount: 0, error: "subscription not found" };
  }
  if (subscription.status !== "active") {
    logger.debug(
      { subscriptionId, status: subscription.status },
      "Subscription not active — skipping"
    );
    return { ok: false, itemCount: 0, error: `status=${subscription.status}` };
  }

  const sourceConfig = await db.query.sourceConfigs.findFirst({
    where: eq(sourceConfigs.id, subscription.sourceConfigId),
  });
  if (!sourceConfig) {
    await markSubscriptionError(
      subscriptionId,
      "Source config not found — cascade expected to have removed this row"
    );
    return { ok: false, itemCount: 0, error: "source_config not found" };
  }
  if (!sourceConfig.enabled) {
    logger.debug(
      { subscriptionId, sourceConfigId: sourceConfig.id },
      "Source config disabled — skipping"
    );
    return { ok: false, itemCount: 0, error: "source_config disabled" };
  }

  const provider = sourceProviderRegistry.get(sourceConfig.providerType);
  if (!provider) {
    await markSubscriptionError(
      subscriptionId,
      `No provider registered for type "${sourceConfig.providerType}"`
    );
    return {
      ok: false,
      itemCount: 0,
      error: `no provider for ${sourceConfig.providerType}`,
    };
  }

  // Merge base config + per-subscription params before vault resolution.
  const merged: Record<string, unknown> = {
    ...(sourceConfig.config as Record<string, unknown>),
    ...(subscription.params as Record<string, unknown>),
  };

  let resolved: Record<string, unknown>;
  try {
    resolved = await resolveConfigVault(merged, sourceConfig.userId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markSubscriptionError(subscriptionId, `Vault resolve: ${msg}`);
    return { ok: false, itemCount: 0, error: msg };
  }

  // ── Fan-out over derivedQueries if available ─────────────────────────────
  // When the query planner has expanded the archetype into concrete targets,
  // run one fetch per derived query and merge results. Falls back to single
  // provider.fetch() when no derivedQueries are stored.

  interface DerivedQuery {
    upstreamType: string;
    config: Record<string, unknown>;
    label: string;
  }

  const derivedQueries = (
    (subscription.params as Record<string, unknown>)?.derivedQueries as
      | DerivedQuery[]
      | undefined
  )?.filter((q) => q && q.upstreamType && q.config);

  let items: SourceItem[] = [];
  let nextToken: string | undefined;

  if (derivedQueries && derivedQueries.length > 0) {
    // Fan-out: use the resolved relayUrl + relayKey but override upstreamType/config per query.
    const relayUrl = resolved.relayUrl as string | undefined;
    const relayKey = resolved.relayKey as string | undefined;

    if (!relayUrl || !relayKey) {
      await markSubscriptionError(
        subscriptionId,
        "derivedQueries present but relayUrl/relayKey could not be resolved"
      );
      return {
        ok: false,
        itemCount: 0,
        error: "missing relay credentials for derived query fan-out",
      };
    }

    logger.debug(
      { subscriptionId, queryCount: derivedQueries.length },
      "Fan-out fetch over derivedQueries"
    );

    const seenIds = new Set<string>();
    for (const dq of derivedQueries) {
      const queryConfig: Record<string, unknown> = {
        relayUrl,
        relayKey,
        upstreamType: dq.upstreamType,
        upstreamConfig: dq.config,
      };

      try {
        const result = await provider.fetch(queryConfig, {
          sinceToken: subscription.cursor ?? undefined,
          limit: Math.ceil(50 / derivedQueries.length),
        });
        // Deduplicate across queries by externalId
        for (const item of result.items) {
          if (!seenIds.has(item.externalId)) {
            seenIds.add(item.externalId);
            items.push(item);
          }
        }
        if (result.nextToken) nextToken = result.nextToken;
      } catch (err) {
        logger.warn(
          {
            err,
            subscriptionId,
            upstreamType: dq.upstreamType,
            label: dq.label,
          },
          "Derived query fetch failed — continuing with remaining queries"
        );
      }
    }
  } else {
    // Default single-fetch path
    try {
      const result = await provider.fetch(resolved, {
        sinceToken: subscription.cursor ?? undefined,
        limit: 50,
      });
      items = result.items;
      nextToken = result.nextToken;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(
        { err, subscriptionId, providerType: sourceConfig.providerType },
        "Provider fetch failed"
      );
      await markSubscriptionError(subscriptionId, `Fetch: ${msg}`);
      return { ok: false, itemCount: 0, error: msg };
    }
  }

  const latestItemAt = items.reduce<Date | null>((acc, it) => {
    if (!it.publishedAt) return acc;
    return acc == null || it.publishedAt > acc ? it.publishedAt : acc;
  }, null);

  await db
    .update(sourceSubscriptions)
    .set({
      cursor: nextToken ?? subscription.cursor,
      lastFetchedAt: new Date(),
      lastItemAt: latestItemAt ?? subscription.lastItemAt,
      status: "active",
      errorMessage: null,
      updatedAt: new Date(),
    })
    .where(eq(sourceSubscriptions.id, subscriptionId));

  // Publish items to the downstream queue. Classification + message posting
  // is Agent 3's surface — this worker only guarantees the items made it
  // off the wire and into the pipeline.
  if (items.length > 0) {
    try {
      const boss = getBoss();
      await boss.send(FEED_SOURCE_ITEMS_QUEUE, {
        subscriptionId,
        feedId: subscription.feedId,
        userId: subscription.userId,
        workspaceId: subscription.workspaceId,
        runId,
        items,
      });
    } catch (err) {
      logger.warn(
        { err, subscriptionId },
        "Failed to enqueue items (non-fatal — subscription cursor already advanced)"
      );
    }
  }

  logger.info(
    {
      subscriptionId,
      providerType: sourceConfig.providerType,
      itemCount: items.length,
      derivedQueryCount: derivedQueries?.length ?? 0,
      cursorChanged: nextToken !== subscription.cursor,
    },
    "Source fetch complete"
  );

  return { ok: true, itemCount: items.length };
}

async function markSubscriptionError(
  subscriptionId: string,
  message: string
): Promise<void> {
  try {
    await db
      .update(sourceSubscriptions)
      .set({
        status: "error",
        errorMessage: message.slice(0, 2000),
        updatedAt: new Date(),
      })
      .where(eq(sourceSubscriptions.id, subscriptionId));
  } catch (err) {
    logger.error(
      { err, subscriptionId },
      "Failed to persist subscription error (state may be stale)"
    );
  }
}
