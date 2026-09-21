/**
 * THE one GROUP BY over `entities` — how much lives where, how recently, and
 * what the caller opens. Orient, MCP grounding, diagnose and the discover
 * summary tier all read it; never re-derive a count beside it.
 *
 * ── The floor ───────────────────────────────────────────────────────────────
 * `ownerPrivateVisibleWhere` — `entities` is an ownerPrivate table (a NULL
 * workspace means "personal to the owner"), so plain `userVisibleWhere` would
 * admit every user's personal rows. `workspaceIds` only NARROWS on top of it:
 * a caller-supplied id it cannot see still counts nothing.
 *
 * ── Grouping ────────────────────────────────────────────────────────────────
 * `(workspace_id, profile_id, type)`. `profile_id`, not `type`, is the identity
 * a ranking needs: five slugs are held by two profile rows each on the live pod,
 * so a slug-keyed count would credit a twin with its sibling's entities.
 * `type` rides along for diagnose's slug inventory (same cardinality).
 *
 * ── Opens (`withOpens`) ─────────────────────────────────────────────────────
 * `user_entity_state` holds the caller's explicit-open state per entity. It is
 * LEFT JOINed on (item, 'entity', caller) — its primary key is
 * (user_id, item_id, item_type), so the join yields at most one row per entity
 * and never inflates `count`. Only the ranking callers pay for the join.
 */

import {
  db,
  and,
  or,
  eq,
  inArray,
  isNull,
  drizzleSql,
  entities,
  userResourceState,
  ownerPrivateVisibleWhere,
} from "@synap/database";

export interface EntityUsageRow {
  /** `null` = the pod-scoped bucket (only when `includePodScoped`). */
  workspaceId: string | null;
  profileId: string | null;
  /** `entities.type` — the profile slug as stored on the row. */
  type: string | null;
  count: number;
  lastActivityAt: Date | null;
  /** Sum of the caller's `view_count` over these entities (0 without opens). */
  openCount: number;
  /** Newest `last_viewed_at` by the caller (null without opens). */
  lastOpenedAt: Date | null;
  /** Entities the caller pinned or starred (0 without opens). */
  pinnedCount: number;
}

export interface EntityUsageParams {
  userId: string;
  /** Workspaces to count. Narrows the floor; never widens it. */
  workspaceIds: readonly string[];
  /** Also count the caller's pod-scoped (`workspace_id IS NULL`) rows. */
  includePodScoped?: boolean;
  /** Join the caller's open/pin state (ranking callers only). */
  withOpens?: boolean;
  /**
   * Narrow to these profile rows. A pure filter on top of the floor — omitting
   * it counts every profile, exactly as before. Used by the per-property fill
   * door, which only ever needs one profile's rows and must not pay for a
   * whole-pod GROUP BY to get its denominator.
   */
  profileIds?: readonly string[];
}

const toDate = (v: unknown): Date | null =>
  v == null ? null : v instanceof Date ? v : new Date(String(v));

/**
 * THE floor, built once — `loadEntityUsage` and `loadPropertyFill` must be
 * counting the SAME rows or the fill numerator and its denominator come from
 * two different populations. Returns `null` when the lens can admit nothing.
 */
function entityFloor(params: EntityUsageParams) {
  const { userId, workspaceIds, includePodScoped, profileIds } = params;
  const ids = [...workspaceIds];
  if (ids.length === 0 && !includePodScoped) return null;
  if (profileIds && profileIds.length === 0) return null;

  const lens =
    ids.length === 0
      ? isNull(entities.workspaceId)
      : includePodScoped
        ? or(isNull(entities.workspaceId), inArray(entities.workspaceId, ids))
        : inArray(entities.workspaceId, ids);
  return and(
    isNull(entities.deletedAt),
    ownerPrivateVisibleWhere(entities.workspaceId, entities.userId, userId),
    lens,
    ...(profileIds ? [inArray(entities.profileId, [...profileIds])] : [])
  );
}

export async function loadEntityUsage(
  params: EntityUsageParams
): Promise<EntityUsageRow[]> {
  const { userId, withOpens } = params;
  const where = entityFloor(params);
  if (!where) return [];

  const base = {
    workspaceId: entities.workspaceId,
    profileId: entities.profileId,
    type: entities.type,
    count: drizzleSql<number>`cast(count(*) as integer)`,
    lastActivityAt: drizzleSql<Date | null>`max(${entities.updatedAt})`,
  };

  const rows = withOpens
    ? await db
        .select({
          ...base,
          openCount: drizzleSql<number>`cast(coalesce(sum(${userResourceState.openCount}), 0) as integer)`,
          lastOpenedAt: drizzleSql<Date | null>`max(${userResourceState.lastOpenedAt})`,
          pinnedCount: drizzleSql<number>`cast(count(*) filter (where ${userResourceState.pinned} or ${userResourceState.starred}) as integer)`,
        })
        .from(entities)
        .leftJoin(
          userResourceState,
          and(
            eq(userResourceState.resourceId, entities.id),
            eq(userResourceState.resourceType, "entity"),
            eq(userResourceState.userId, userId)
          )
        )
        .where(where)
        .groupBy(entities.workspaceId, entities.profileId, entities.type)
    : await db
        .select(base)
        .from(entities)
        .where(where)
        .groupBy(entities.workspaceId, entities.profileId, entities.type);

  return rows.map((r) => {
    const o = r as Partial<EntityUsageRow> & typeof r;
    return {
      workspaceId: r.workspaceId ?? null,
      profileId: r.profileId ?? null,
      type: r.type ?? null,
      count: Number(r.count) || 0,
      lastActivityAt: toDate(r.lastActivityAt),
      openCount: Number(o.openCount) || 0,
      lastOpenedAt: toDate(o.lastOpenedAt),
      pinnedCount: Number(o.pinnedCount) || 0,
    };
  });
}

// ── Per-property FILL — a SIBLING of the aggregate above, not a second one ──

export interface PropertyFillRow {
  workspaceId: string | null;
  profileId: string | null;
  /** The property key as it is stored on `entities.properties`. */
  slug: string;
  /** Entities of this group whose value for this key is present and non-empty. */
  filled: number;
}

/**
 * How many entities carry a NON-EMPTY value for each property key, per
 * `(workspace_id, profile_id, key)`. Same table, same floor as
 * `loadEntityUsage` (both build it through `entityFloor`); the only addition is
 * a LATERAL over the `properties` JSONB.
 *
 * ── THE DENOMINATOR TRAP — why this returns a NUMERATOR ONLY ───────────────
 * `jsonb_each` over `{}` yields ZERO rows. An entity that has never had a
 * property written therefore contributes NOTHING here — not a zero row, no row
 * at all. So any `count(*)` taken from this lateral counts "entities that have
 * at least one property key", which is NOT the population of the kind.
 *
 * Dividing by it inflates every rate, silently and in the flattering direction:
 * a kind with 100 entities, 10 carrying `{"status":"x"}` and 90 carrying `{}`,
 * would report `status` as 10/10 = 100% filled instead of 10/100 = 10%.
 *
 * So this function deliberately exposes no sample size. The denominator is
 * `loadEntityUsage`'s `count` — a GROUP BY over `entities` ITSELF, where a
 * property-less entity is still a row. `loadProfileFill` below is the one place
 * the two are joined, and it takes the denominator from the entity count.
 *
 * `jsonb_typeof(...) = 'object'` guard: `jsonb_each` RAISES on a non-object
 * (an array or scalar `properties`). One malformed row would 500 the whole
 * request; it contributes zero keys instead.
 */
export async function loadPropertyFill(
  params: EntityUsageParams
): Promise<PropertyFillRow[]> {
  const where = entityFloor(params);
  if (!where) return [];

  const result = await db.execute(drizzleSql`
    SELECT ${entities.workspaceId} AS "workspaceId",
           ${entities.profileId} AS "profileId",
           kv.key AS "slug",
           cast(count(*) FILTER (
             WHERE jsonb_typeof(kv.value) <> 'null'
               AND kv.value NOT IN ('""'::jsonb, '[]'::jsonb, '{}'::jsonb)
           ) as integer) AS "filled"
    FROM ${entities},
         LATERAL jsonb_each(
           CASE WHEN jsonb_typeof(${entities.properties}) = 'object'
                THEN ${entities.properties}
                ELSE '{}'::jsonb END
         ) kv
    WHERE ${where}
    GROUP BY 1, 2, 3
  `);

  // postgres-js `execute` resolves to the row array itself; pglite's resolves
  // to `{ rows }`. Both drivers run this file (prod / the PGlite harness).
  const raw = result as unknown;
  const rows = (
    Array.isArray(raw)
      ? raw
      : ((raw as { rows?: unknown[] } | null)?.rows ?? [])
  ) as Array<Partial<PropertyFillRow>>;
  return rows.map((r) => ({
    workspaceId: r.workspaceId ?? null,
    profileId: r.profileId ?? null,
    slug: String(r.slug),
    filled: Number(r.filled) || 0,
  }));
}

/**
 * ONE profile's fill at ONE lens: a numerator per property key, and the sample
 * size they are all out of.
 *
 * Two numbers, never a pre-divided ratio — the consumer divides. A single
 * `fillRate: number` collapses three different facts into `0`:
 *   • the stat was not requested / could not be read  → `fill` ABSENT
 *   • the kind has no entities at this lens           → `sampleSize === 0`
 *   • a real, measured zero                           → `sampleSize > 0, filled === 0`
 * That is the `empty ≠ failed ≠ unmeasured` collapse this codebase keeps
 * paying for. Keeping both numbers on the wire makes all three distinguishable.
 */
export interface ProfileFill {
  /**
   * Filled count per property key. A key NOBODY has filled may be ABSENT from
   * this map (the lateral produced no group for it) — read a missing key as 0,
   * which is safe precisely because `sampleSize` is independent of this map.
   */
  filledBySlug: ReadonlyMap<string, number>;
  /**
   * Entities of this profile at this lens — from `loadEntityUsage`, NEVER from
   * the property lateral (see the trap above). `0` means the kind has no
   * entities here: UNMEASURABLE (new kind / cold start), not "0% filled".
   */
  sampleSize: number;
}

/** 10 minutes. A fill stat is a tiebreaker; it never needs to be fresh. */
const FILL_CACHE_TTL_MS = 600_000;

/**
 * In-process TTL cache, the idiom already used ~6× in this repo
 * (`ProfileResolutionService.entityScopeCache` et al) — WITH one change.
 *
 * It caches the IN-FLIGHT PROMISE, not the resolved value. None of the six
 * existing caches do, which leaves every one of them open to a cold-key
 * stampede: N concurrent requests all miss, all issue the query, and N-1 of
 * them are wasted. Storing the promise makes the second caller await the first
 * caller's query. It is one line, and it removes the question entirely.
 *
 * A REJECTED promise is evicted (see below), so a failed read is never cached
 * as a durable answer — the next caller retries and gets a real error or a real
 * value. An error must not become a 10-minute-old "unmeasured".
 *
 * Key: `${profileId}:${workspaceId ?? "__nows__"}:${userId}`. `profileId` LEADS
 * so `invalidateProfileFillCache(profileId)` can prefix-match, matching the
 * existing `invalidateEntityScopeCache` shape. `userId` is appended — a
 * DELIBERATE addition to the designed key: the floor is `ownerPrivateVisibleWhere`,
 * so two users on one pod see genuinely different counts for the same
 * (profile, workspace), and a user-less key would serve one user the other's.
 */
const profileFillCache = new Map<
  string,
  { value: Promise<ProfileFill>; expiresAt: number }
>();

/** Drop cached fill (call after a bulk property write, or in tests). */
export function invalidateProfileFillCache(profileId?: string): void {
  if (!profileId) {
    profileFillCache.clear();
    return;
  }
  for (const key of profileFillCache.keys()) {
    if (key.startsWith(`${profileId}:`)) profileFillCache.delete(key);
  }
}

export function loadProfileFill(params: {
  /** The AUTHENTICATED user — the floor. Never a request-supplied id. */
  userId: string;
  profileId: string;
  /** The requested lens; part of the cache key. `undefined` = no workspace lens. */
  workspaceId?: string;
  /** The ALREADY-FLOORED workspace ids to count over (as `rankProfilesByUsage` computes them). */
  workspaceIds: readonly string[];
}): Promise<ProfileFill> {
  const { userId, profileId, workspaceId, workspaceIds } = params;
  const key = `${profileId}:${workspaceId ?? "__nows__"}:${userId}`;
  const cached = profileFillCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const scope = {
    userId,
    workspaceIds,
    includePodScoped: true,
    profileIds: [profileId],
  } as const;

  const value = (async (): Promise<ProfileFill> => {
    const [usage, fill] = await Promise.all([
      loadEntityUsage(scope),
      loadPropertyFill(scope),
    ]);
    // THE denominator: entity rows, not lateral rows. See loadPropertyFill.
    const sampleSize = usage.reduce((n, r) => n + r.count, 0);
    const filledBySlug = new Map<string, number>();
    for (const r of fill)
      filledBySlug.set(r.slug, (filledBySlug.get(r.slug) ?? 0) + r.filled);
    return { filledBySlug, sampleSize };
  })();

  value.catch(() => {
    if (profileFillCache.get(key)?.value === value)
      profileFillCache.delete(key);
  });
  profileFillCache.set(key, {
    value,
    expiresAt: Date.now() + FILL_CACHE_TTL_MS,
  });
  return value;
}

// ── PURE tier ────────────────────────────────────────────────────────────────

export interface UsageTotals {
  count: number;
  lastActivityAt: Date | null;
  openCount: number;
  lastOpenedAt: Date | null;
  pinnedCount: number;
}

const newer = (a: Date | null, b: Date | null) =>
  !a ? b : !b ? a : a > b ? a : b;

function fold(
  rows: readonly EntityUsageRow[],
  keyOf: (r: EntityUsageRow) => string | null
): Map<string, UsageTotals> {
  const out = new Map<string, UsageTotals>();
  for (const r of rows) {
    const key = keyOf(r);
    if (key == null) continue;
    const t = out.get(key) ?? {
      count: 0,
      lastActivityAt: null,
      openCount: 0,
      lastOpenedAt: null,
      pinnedCount: 0,
    };
    t.count += r.count;
    t.lastActivityAt = newer(t.lastActivityAt, r.lastActivityAt);
    t.openCount += r.openCount;
    t.lastOpenedAt = newer(t.lastOpenedAt, r.lastOpenedAt);
    t.pinnedCount += r.pinnedCount;
    out.set(key, t);
  }
  return out;
}

/** Totals per workspace. The pod-scoped bucket is NOT a workspace — skipped. */
export const usageByWorkspace = (rows: readonly EntityUsageRow[]) =>
  fold(rows, (r) => r.workspaceId);

/** Totals per profile row id (across every counted workspace + pod bucket). */
export const usageByProfile = (rows: readonly EntityUsageRow[]) =>
  fold(rows, (r) => r.profileId);

/**
 * The blended usage score (founder decision D3, 2026-09-14): ONE rank, the SAME
 * for agents and humans — what exists, what is alive, and what the person
 * actually opens.
 *
 *   log2(1 + entities)                 — volume, damped: 500 rows is not 100× 5
 *   + 6 · ½^(days since last write / 30) — recency, 30-day half-life
 *   + 3 · log2(1 + opens)              — the human's own reads weigh most
 *   + 4 · ½^(days since last open / 30)
 *   + 2 · pinned/starred entities (capped at 3)
 *
 * The weights are a principled default, not a measurement — they are named here
 * so they can be overridden in one place, and `usage-rank.test.ts` pins the
 * ORDER they produce on discriminating fixtures, not the numbers.
 */
export const USAGE_WEIGHTS = {
  recency: 6,
  opens: 3,
  openRecency: 4,
  pinned: 2,
  pinnedCap: 3,
  halfLifeDays: 30,
} as const;

const DAY_MS = 86_400_000;

export function usageScore(t: UsageTotals | undefined, now: Date): number {
  if (!t) return 0;
  const W = USAGE_WEIGHTS;
  const decay = (d: Date | null) =>
    d
      ? Math.pow(
          0.5,
          Math.max(0, now.getTime() - d.getTime()) / DAY_MS / W.halfLifeDays
        )
      : 0;
  return (
    Math.log2(1 + t.count) +
    W.recency * (t.count > 0 ? decay(t.lastActivityAt) : 0) +
    W.opens * Math.log2(1 + t.openCount) +
    W.openRecency * decay(t.lastOpenedAt) +
    W.pinned * Math.min(t.pinnedCount, W.pinnedCap)
  );
}

/**
 * Order `items` by blended usage, highest first; ties (including every unused
 * item, score 0) break by name so the order is deterministic. Returns 1-based
 * ranks alongside, keyed by the item's id.
 */
export function rankByUsage<T>(
  items: readonly T[],
  opts: {
    idOf: (item: T) => string | undefined;
    nameOf: (item: T) => string;
    usage: Map<string, UsageTotals>;
    now?: Date;
  }
): Array<{ item: T; rank: number; score: number; usage?: UsageTotals }> {
  const now = opts.now ?? new Date();
  return items
    .map((item) => {
      const id = opts.idOf(item);
      const usage = id ? opts.usage.get(id) : undefined;
      return { item, usage, score: usageScore(usage, now) };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        opts.nameOf(a.item).localeCompare(opts.nameOf(b.item))
    )
    .map((r, i) => ({ ...r, rank: i + 1 }));
}
