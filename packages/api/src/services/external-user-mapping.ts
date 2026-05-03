/**
 * External User Mapping Service — per-external-user sub-tokens.
 *
 * Resolves an external user identifier (e.g. an OpenWebUI `user.id`) to a
 * Synap user, given the parent API key the request was authenticated with.
 *
 * Why this exists
 * ---------------
 * OpenWebUI / shared chat surfaces hold a single Synap parent agent key per
 * deployment. Without this mapping, every human chatting through that
 * deployment gets shoved into the same Synap user — their notes, threads,
 * and memory all collide. With this service, the auth middleware swaps
 * `c.userId` from the parent key's owner to the external user's mapped
 * Synap user before any downstream handler runs.
 *
 * Two operating modes (see migration 0018_per_user_sub_tokens.sql):
 *   1. Mode 1 — header-based remapping (this file's primary path).
 *   2. Mode 2 — sub-tokens (api_keys.parent_key_id). Schema is ready,
 *      mint-time logic in setup.ts is a placeholder for now.
 *
 * Failure mode is explicit: lookup failures (DB outage, etc.) return null
 * and the caller falls back to single-user behavior. The auth middleware
 * MUST NOT fail closed on this path.
 *
 * Auto-create flow: when no mapping exists, we provision a fresh Synap
 * user, optionally grant them workspace membership matching the parent
 * key's owner, and insert the mapping row — all inside one transaction so
 * a partial failure leaves no orphans.
 */

import { randomUUID } from "crypto";
import { eq, and } from "drizzle-orm";

import {
  db,
  apiKeyExternalUsers,
  users,
  workspaceMembers,
  type ApiKeyExternalUserRecord,
} from "@synap/database";

import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "external-user-mapping" });

/**
 * In-process LRU cache: (parentKeyId, externalUserId) → mapping row.
 *
 * Mappings are write-once + last_used bumps; we can safely cache the
 * resolved Synap user across requests. TTL is 5 min so that a deletion or
 * reassignment in the DB propagates within reasonable bounds.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_SIZE = 1000;

interface CachedMapping {
  synapUserId: string;
  mappingId: string;
  expiresAt: number;
}

const cache = new Map<string, CachedMapping>();

function cacheKey(parentKeyId: string, externalUserId: string): string {
  return `${parentKeyId}|${externalUserId}`;
}

function getCached(
  parentKeyId: string,
  externalUserId: string
): CachedMapping | null {
  const key = cacheKey(parentKeyId, externalUserId);
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return null;
  }
  // LRU touch — re-insert to move to the end of the iteration order.
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function setCached(
  parentKeyId: string,
  externalUserId: string,
  synapUserId: string,
  mappingId: string
): void {
  // Cap the cache size — drop the oldest entry first.
  if (cache.size >= CACHE_MAX_SIZE) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(cacheKey(parentKeyId, externalUserId), {
    synapUserId,
    mappingId,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

/**
 * Result of a mapping lookup.
 *
 * `created: true` means we provisioned a fresh Synap user as part of this
 * call. Callers can use that signal for telemetry / audit logging.
 */
export interface ExternalUserMappingResult {
  synapUserId: string;
  mappingId: string;
  created: boolean;
}

interface ResolveOptions {
  /** Parent agent's owner — used as a template for membership grants. */
  parentOwnerUserId: string;
  /** Free-form source label (e.g. "openwebui"). Stored on the user + mapping metadata. */
  source?: string;
  /** Optional display name passed through from the upstream system. */
  displayName?: string;
  /** Optional email address. We synthesize one when absent. */
  email?: string;
}

const lastUsedAtWriteCache = new Map<string, number>();
const LAST_USED_AT_DEBOUNCE_MS = 60_000;

/**
 * GC for the last_used_at debounce cache.
 *
 * Without this the Map grows monotonically — every distinct mapping ever
 * touched stays in memory forever. We sweep every 5 min, drop entries older
 * than the TTL (just means we'll write last_used_at again next access — cheap)
 * and enforce a hard cap as a safety net. `unref()` so this never keeps the
 * event loop alive at shutdown. Same pattern as the main mapping cache + the
 * idempotency middleware.
 */
const LAST_USED_AT_CACHE_MAX_SIZE = 10_000;
const LAST_USED_AT_CACHE_TTL_MS = 60 * 60 * 1000; // 1h
const LAST_USED_AT_GC_INTERVAL_MS = 5 * 60 * 1000;

const lastUsedAtGcInterval = setInterval(() => {
  const cutoff = Date.now() - LAST_USED_AT_CACHE_TTL_MS;
  for (const [key, ts] of lastUsedAtWriteCache.entries()) {
    if (ts < cutoff) lastUsedAtWriteCache.delete(key);
  }
  // Hard cap as a safety net — drop oldest insertion-order entries first.
  if (lastUsedAtWriteCache.size > LAST_USED_AT_CACHE_MAX_SIZE) {
    const excess = lastUsedAtWriteCache.size - LAST_USED_AT_CACHE_MAX_SIZE;
    let dropped = 0;
    for (const key of lastUsedAtWriteCache.keys()) {
      if (dropped >= excess) break;
      lastUsedAtWriteCache.delete(key);
      dropped++;
    }
  }
}, LAST_USED_AT_GC_INTERVAL_MS);
if (typeof lastUsedAtGcInterval.unref === "function") {
  lastUsedAtGcInterval.unref();
}

/**
 * Workspace membership grant strategy for auto-created external users.
 *
 * Read from `HUB_PROTOCOL_EXTERNAL_USER_WORKSPACE_STRATEGY`:
 *   - "first" (DEFAULT) — grant membership only in the parent owner's
 *     chronologically first workspace (oldest by joined_at). Conservative:
 *     keeps external users out of team workspaces by accident.
 *   - "all" — copy every membership the parent owner has. Legacy behavior.
 *   - "none" — don't grant any. Writes will fail until an admin grants
 *     membership manually. For high-control environments.
 *
 * NOTE: the previous implicit default was "all". Changing the default to
 * "first" is intentional — it's a more secure default and matches the
 * common case (parent agent has a personal/primary workspace). Operators
 * who need the old behavior must opt back in via the env var.
 */
export type WorkspaceStrategy = "first" | "all" | "none";

export function getWorkspaceStrategy(): WorkspaceStrategy {
  const raw = (
    process.env.HUB_PROTOCOL_EXTERNAL_USER_WORKSPACE_STRATEGY ?? "first"
  ).toLowerCase();
  if (raw === "all" || raw === "none") return raw;
  return "first"; // safe default — also handles unknown values
}

/**
 * Look up — or auto-create — a Synap user for `(parentKeyId, externalUserId)`.
 *
 * Returns null only on an unrecoverable error (e.g. DB outage). Callers MUST
 * treat null as "fall back to the parent key's user, log a warning" — never
 * as "fail the request".
 */
export async function resolveExternalUserMapping(
  parentKeyId: string,
  externalUserId: string,
  opts: ResolveOptions
): Promise<ExternalUserMappingResult | null> {
  // 0. Cheap path: in-process cache.
  const cached = getCached(parentKeyId, externalUserId);
  if (cached) {
    bumpLastUsedAt(cached.mappingId);
    return {
      synapUserId: cached.synapUserId,
      mappingId: cached.mappingId,
      created: false,
    };
  }

  try {
    // 1. SELECT — does a mapping already exist?
    const existing = await db.query.apiKeyExternalUsers.findFirst({
      where: and(
        eq(apiKeyExternalUsers.parentApiKeyId, parentKeyId),
        eq(apiKeyExternalUsers.externalUserId, externalUserId)
      ),
      columns: { id: true, synapUserId: true },
    });

    if (existing) {
      setCached(parentKeyId, externalUserId, existing.synapUserId, existing.id);
      bumpLastUsedAt(existing.id);
      return {
        synapUserId: existing.synapUserId,
        mappingId: existing.id,
        created: false,
      };
    }

    // 2. Auto-create — Synap user + mapping in one transaction.
    const created = await provisionMapping(parentKeyId, externalUserId, opts);
    if (created) {
      setCached(
        parentKeyId,
        externalUserId,
        created.synapUserId,
        created.mappingId
      );
    }
    return created;
  } catch (err) {
    logger.warn(
      { err, parentKeyId, externalUserId },
      "external-user-mapping: lookup/create failed — caller should fall back"
    );
    return null;
  }
}

async function provisionMapping(
  parentKeyId: string,
  externalUserId: string,
  opts: ResolveOptions
): Promise<ExternalUserMappingResult | null> {
  const newUserId = randomUUID();
  const trimmed = externalUserId.slice(0, 12);
  const displayName =
    opts.displayName?.trim() ||
    (opts.source
      ? `${opts.source} user ${trimmed}`
      : `External user ${trimmed}`);

  // We need a unique email per Synap user. If the upstream provided one we
  // use it; otherwise we synthesize a stable, non-deliverable address that
  // still satisfies the UNIQUE constraint on users.email.
  //
  // Use the full UUID — slicing to 8 chars (32 bits) gives a birthday
  // collision around ~65k users. Full UUID (122 bits of entropy) makes
  // collision effectively impossible. Total length stays well within
  // RFC 5321's 254-char limit.
  const email =
    opts.email?.trim() ||
    `external-${opts.source ?? "user"}-${newUserId}@synap.external`;

  try {
    const result = await db.transaction(async (tx) => {
      // 1. Create the Synap user.
      await tx.insert(users).values({
        id: newUserId,
        email,
        name: displayName,
        emailVerified: false,
        userType: "human",
        kratosIdentityId: null,
        timezone: "UTC",
        locale: "en",
      });

      // 2. Mirror the parent owner's workspace memberships so the new user
      //    has somewhere to write data. Best-effort — failures here don't
      //    block the mapping. Strategy controls how aggressively we grant:
      //    see `getWorkspaceStrategy()` doc above.
      const strategy = getWorkspaceStrategy();
      if (strategy !== "none") {
        try {
          let parentMemberships = await tx.query.workspaceMembers.findMany({
            where: eq(workspaceMembers.userId, opts.parentOwnerUserId),
            columns: { workspaceId: true },
            orderBy: (m, { asc }) => [asc(m.joinedAt)],
          });
          if (strategy === "first" && parentMemberships.length > 0) {
            parentMemberships = parentMemberships.slice(0, 1);
          }
          for (const m of parentMemberships) {
            await tx.insert(workspaceMembers).values({
              id: randomUUID(),
              workspaceId: m.workspaceId,
              userId: newUserId,
              role: "editor",
              invitedBy: opts.parentOwnerUserId,
            });
          }
        } catch (membershipErr) {
          logger.warn(
            { err: membershipErr, newUserId, parentKeyId, strategy },
            "external-user-mapping: workspace membership grant failed (non-fatal)"
          );
        }
      }

      // 3. Insert the mapping row.
      const [mapping] = await tx
        .insert(apiKeyExternalUsers)
        .values({
          parentApiKeyId: parentKeyId,
          externalUserId,
          synapUserId: newUserId,
          metadata: {
            source: opts.source,
            displayName: opts.displayName,
            email: opts.email,
          },
        })
        .returning({ id: apiKeyExternalUsers.id });

      return { mappingId: mapping.id, synapUserId: newUserId };
    });

    logger.info(
      {
        parentKeyId,
        externalUserId,
        synapUserId: result.synapUserId,
        source: opts.source,
      },
      "external-user-mapping: provisioned new Synap user + mapping"
    );

    return {
      synapUserId: result.synapUserId,
      mappingId: result.mappingId,
      created: true,
    };
  } catch (err) {
    logger.error(
      { err, parentKeyId, externalUserId },
      "external-user-mapping: provisioning failed"
    );
    return null;
  }
}

/**
 * Debounced last_used_at bump — fire-and-forget, never blocks the request.
 */
function bumpLastUsedAt(mappingId: string): void {
  const now = Date.now();
  const last = lastUsedAtWriteCache.get(mappingId) ?? 0;
  if (now - last < LAST_USED_AT_DEBOUNCE_MS) return;
  lastUsedAtWriteCache.set(mappingId, now);
  db.update(apiKeyExternalUsers)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeyExternalUsers.id, mappingId))
    .catch(() => {
      // Non-fatal — usage tracking is best-effort.
    });
}

/**
 * Test/admin helper — invalidate one cache entry (e.g. after manual reassignment).
 */
export function invalidateExternalUserMappingCache(
  parentKeyId: string,
  externalUserId: string
): void {
  cache.delete(cacheKey(parentKeyId, externalUserId));
}

/**
 * Test helper — clear the entire in-process cache.
 */
export function _clearExternalUserMappingCacheForTests(): void {
  cache.clear();
  lastUsedAtWriteCache.clear();
}

/**
 * Test helper — expose internals for GC verification.
 */
export const _internalsForTests = {
  lastUsedAtWriteCache,
  lastUsedAtGcInterval,
  LAST_USED_AT_CACHE_MAX_SIZE,
  LAST_USED_AT_CACHE_TTL_MS,
  LAST_USED_AT_GC_INTERVAL_MS,
};

/**
 * Look up an existing mapping without auto-creating. Used by /setup/external-user
 * to detect "already mapped" and return idempotently.
 */
export async function lookupExternalUserMapping(
  parentKeyId: string,
  externalUserId: string
): Promise<ApiKeyExternalUserRecord | null> {
  const found = await db.query.apiKeyExternalUsers.findFirst({
    where: and(
      eq(apiKeyExternalUsers.parentApiKeyId, parentKeyId),
      eq(apiKeyExternalUsers.externalUserId, externalUserId)
    ),
  });
  return found ?? null;
}

/**
 * Whether the per-user sub-token feature is currently enabled on this pod.
 *
 * Default behavior is the legacy single-key mapping. The flag MUST be opt-in
 * — anything other than the literal string "true" disables.
 */
export function isSubTokenFeatureEnabled(): boolean {
  return process.env.HUB_PROTOCOL_SUB_TOKENS === "true";
}
