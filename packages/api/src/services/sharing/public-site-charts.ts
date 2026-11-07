/**
 * THE PUBLIC READ of a site's CHARTS (owner side: `site-charts.ts`).
 *
 *   GET /public/sites/:siteToken/charts                      the list
 *   GET /public/sites/:siteToken/charts/:slugOrPublicId      one chart
 *
 * Credentialless; the site token IS the capability, exactly as the record
 * doors (`public-site-read.ts`), with the same contract:
 *   - UNIFORM MISS: an unknown/draft/revoked site, an unknown slug or public
 *     id, a chart that is unpublished, revoked, expired, whose cell instance
 *     was deleted, whose space closed its public doors, or whose stored
 *     payload does not decode — all `null` (the byte-identical 404). A FAILED
 *     read throws (a 5xx, never a calm 404, never empty data).
 *   - the home space's switch is decided after every miss (403).
 *   - nothing internal leaves: no project, workspace, owner, share, cell or
 *     entity id.
 *
 * ONE SHAPE, TWO MODES. A chart answers `{ publicId, slug, title?, cellKey,
 * mode, props, data, capturedAt, publishedOn }` whether it is a snapshot (the
 * data frozen at publish) or live (the data re-read now). A LIVE read runs the
 * chart's frozen query AS ITS PUBLISHER through the live chart's own read
 * (`entities.list`, 500 rows, the publisher's floor) and shaper, and is cached
 * {@link LIVE_CHART_TTL_MS} per chart, so anonymous traffic cannot drive pod
 * queries (one read per chart per TTL, whatever the request rate; concurrent
 * misses share one read). Live data holding a UUID fails closed.
 */

import { createHash } from "node:crypto";
import { db, and, desc, eq } from "@synap/database";
import { resourceShares } from "@synap/database/schema";
import { publicDoorsOpenFor } from "./public-doors-switch.js";
import type { PublicShareClosed } from "./public-read.js";
import { resolveSite, type PublicSiteRead } from "./public-site-read.js";
import { PUBLIC_ID_RE, SLUG_MAX_LENGTH, SLUG_RE } from "./site-config.js";
import { liveChartWhere, openMemberWorkspaces } from "./site-members.js";
import {
  SITE_PUBLISH_MAX_CHARTS,
  holdsUuid,
  readChartPayload,
  readLiveChartData,
  type ChartMode,
} from "./site-charts.js";

/** How long a live chart's data is reused before the next read re-runs it. */
export const LIVE_CHART_TTL_MS = 60_000;
/** Live charts kept in memory at once (oldest dropped first). */
export const LIVE_CHART_CACHE_MAX = 500;
/** The list door's cap (one page; a site holds at most this many in practice). */
export const SITE_CHARTS_LIST_MAX = SITE_PUBLISH_MAX_CHARTS * 5;

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface PublicChartSummary {
  publicId: string;
  slug: string | null;
  title?: string;
  cellKey: string;
  mode: ChartMode;
  publishedOn: string;
}

export interface PublicChartList {
  items: PublicChartSummary[];
  total: number;
}

export interface PublicChartView extends PublicChartSummary {
  props: Record<string, unknown>;
  data: unknown;
  /** When the numbers were taken: the freeze (snapshot) or the read (live). */
  capturedAt: string;
}

const weakEtag = (parts: unknown) =>
  `W/"${createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 32)}"`;

const day = (d: Date) => d.toISOString().slice(0, 10);

// ── Live members ─────────────────────────────────────────────────────────────

const CHART_COLUMNS = {
  id: resourceShares.id,
  workspaceId: resourceShares.workspaceId,
  publishedAt: resourceShares.publishedAt,
  publishedBy: resourceShares.publishedBy,
  publishedProperties: resourceShares.publishedProperties,
  publicId: resourceShares.publicId,
  publicSlug: resourceShares.publicSlug,
} as const;

// ── The list ─────────────────────────────────────────────────────────────────

export async function readSiteCharts(
  token: string
): Promise<PublicSiteRead<PublicChartList> | PublicShareClosed | null> {
  const site = await resolveSite(token);
  if (!site) return null;
  if (!(await publicDoorsOpenFor(site.homeWorkspaceId))) {
    return { closed: true };
  }
  const open = await openMemberWorkspaces(site.id);
  const rows = await db
    .select(CHART_COLUMNS)
    .from(resourceShares)
    .where(liveChartWhere(site, open))
    .orderBy(desc(resourceShares.publishedAt), desc(resourceShares.id))
    .limit(SITE_CHARTS_LIST_MAX);

  const items: PublicChartSummary[] = [];
  for (const row of rows) {
    const payload = readChartPayload(row.publishedProperties);
    if (!payload || !row.publicId || !row.publishedAt) continue;
    items.push({
      publicId: row.publicId,
      slug: row.publicSlug ?? null,
      ...(payload.title !== undefined ? { title: payload.title } : {}),
      cellKey: payload.cellKey,
      mode: payload.mode,
      publishedOn: day(row.publishedAt),
    });
  }
  const view: PublicChartList = { items, total: items.length };
  const etag = weakEtag([
    "charts",
    site.id,
    rows.map((r) => [r.id, r.publishedAt?.toISOString() ?? null]),
  ]);
  return { view, etag };
}

// ── One chart ────────────────────────────────────────────────────────────────

interface CachedLive {
  at: number;
  read: Promise<{ data: unknown; capturedAt: string }>;
}

/** Keyed by member row id + its publish instant (a republish starts fresh). */
const liveCache = new Map<string, CachedLive>();

/** Test hook: forget every cached live read. */
export function clearLiveChartCache(): void {
  liveCache.clear();
}

function liveRead(
  key: string,
  run: () => Promise<{ data: unknown; capturedAt: string }>,
  nowMs: number
): Promise<{ data: unknown; capturedAt: string }> {
  const hit = liveCache.get(key);
  if (hit && nowMs - hit.at < LIVE_CHART_TTL_MS) return hit.read;
  const read = run();
  liveCache.delete(key);
  liveCache.set(key, { at: nowMs, read });
  // A failed read is not cached: the next request tries again.
  read.catch(() => {
    if (liveCache.get(key)?.read === read) liveCache.delete(key);
  });
  while (liveCache.size > LIVE_CHART_CACHE_MAX) {
    const oldest = liveCache.keys().next().value;
    if (oldest === undefined) break;
    liveCache.delete(oldest);
  }
  return read;
}

export async function readSiteChart(
  token: string,
  slugOrPublicId: string
): Promise<PublicSiteRead<PublicChartView> | PublicShareClosed | null> {
  const site = await resolveSite(token);
  if (!site) return null;

  const ref = typeof slugOrPublicId === "string" ? slugOrPublicId : "";
  const byPublicId = PUBLIC_ID_RE.test(ref);
  if (!byPublicId && (!SLUG_RE.test(ref) || ref.length > SLUG_MAX_LENGTH)) {
    return null;
  }
  // A chart of a CLOSED other space is a miss (404). The home space is
  // counted open HERE so its chart reaches the home switch below, the one
  // switch that answers 403 — like the record door.
  const open = await openMemberWorkspaces(site.id);
  if (site.homeWorkspaceId && !open.includes(site.homeWorkspaceId)) {
    open.push(site.homeWorkspaceId);
  }
  const [row] = await db
    .select(CHART_COLUMNS)
    .from(resourceShares)
    .where(
      and(
        liveChartWhere(site, open),
        byPublicId
          ? eq(resourceShares.publicId, ref)
          : eq(resourceShares.publicSlug, ref)
      )
    )
    .limit(1);
  if (!row || !row.publicId || !row.publishedAt || !row.workspaceId) {
    return null;
  }
  const payload = readChartPayload(row.publishedProperties);
  if (!payload) return null;

  if (!(await publicDoorsOpenFor(site.homeWorkspaceId))) {
    return { closed: true };
  }

  let data: unknown;
  let capturedAt: string;
  if (payload.mode === "snapshot") {
    data = payload.data;
    capturedAt = payload.capturedAt!;
  } else {
    if (!row.publishedBy) {
      throw new Error("a live chart has no publisher to read as");
    }
    const publisher = row.publishedBy;
    const workspaceId = row.workspaceId;
    const nowMs = Date.now();
    const result = await liveRead(
      `${row.id}:${row.publishedAt.toISOString()}`,
      async () => {
        const now = new Date(nowMs);
        const fresh = await readLiveChartData(
          { userId: publisher, workspaceId },
          payload.cellKey,
          payload.props,
          now
        );
        // Fail closed: an id reached the data since publish (e.g. a grouping
        // field now holds references). Never served, never cached.
        if (holdsUuid(fresh)) {
          throw new Error("live chart data holds an internal id");
        }
        return { data: fresh, capturedAt: now.toISOString() };
      },
      nowMs
    );
    data = result.data;
    capturedAt = result.capturedAt;
  }

  const view: PublicChartView = {
    publicId: row.publicId,
    slug: row.publicSlug ?? null,
    ...(payload.title !== undefined ? { title: payload.title } : {}),
    cellKey: payload.cellKey,
    mode: payload.mode,
    props: payload.props,
    data,
    capturedAt,
    publishedOn: day(row.publishedAt),
  };
  const etag = weakEtag([
    "chart",
    row.id,
    row.publishedAt.toISOString(),
    row.publishedProperties ?? null,
    payload.mode === "live" ? capturedAt : null,
  ]);
  return { view, etag };
}
