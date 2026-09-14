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
}

const toDate = (v: unknown): Date | null =>
  v == null ? null : v instanceof Date ? v : new Date(String(v));

export async function loadEntityUsage(
  params: EntityUsageParams
): Promise<EntityUsageRow[]> {
  const { userId, workspaceIds, includePodScoped, withOpens } = params;
  const ids = [...workspaceIds];
  if (ids.length === 0 && !includePodScoped) return [];

  const lens =
    ids.length === 0
      ? isNull(entities.workspaceId)
      : includePodScoped
        ? or(isNull(entities.workspaceId), inArray(entities.workspaceId, ids))
        : inArray(entities.workspaceId, ids);
  const where = and(
    isNull(entities.deletedAt),
    ownerPrivateVisibleWhere(entities.workspaceId, entities.userId, userId),
    lens
  );

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
