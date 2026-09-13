/**
 * Google Calendar → Synap `event` (the `google`/`event` sync-kind handler).
 *
 * Owns only what is calendar-specific; the runner (`connection-sync.ts`) owns
 * leases, bounds, cursors, first-run proposal vs steady upsert and progress.
 *
 * READ: `calendar_list` (one page per call, per configured calendar), bounded to
 * `[now − windowDays, now + windowDays]`; a steady run adds `updatedMin` = the
 * last completed run so only changed events come back.
 *
 * DEDUP POLICY (in this order, never via the weak title-only identity path, which
 * would collapse recurring same-title events):
 *   - Layer-1: `entity_external_links (google, googleEventId)` — the runner's
 *     exact external-link match.
 *   - Layer-2 (`findExisting`): (normalized title, start-time bucket) against the
 *     OWNER's live events — hour bucket for timed events, DAY bucket for all-day —
 *     so an event another source already created (Cal.com booking, manual entry)
 *     is adopted, not duplicated. The runner registers the Google link on it.
 *   - A matched event gets its times/location refreshed (`refreshExisting`).
 */

import { db, entities, eq, and, isNull, drizzleSql } from "@synap/database";
import {
  mapGcalToGraph,
  normalizeEventTitle,
  startBucketWindow,
  GOOGLE_PROVIDER,
  type GCalItem,
} from "./map-gcal-to-graph.js";
import {
  emptySyncGraph,
  mergeSyncGraph,
  type SyncGraphEntity,
} from "./sync-graph.js";
import {
  registerSyncKind,
  readVerbPage,
  readCollection,
  readNextPageToken,
  type SyncFetchPage,
  type SyncFetchRequest,
  type SyncKindContext,
} from "./sync-kind-registry.js";

/** `calendar_list` clampMax (nango-google template). */
const CALENDAR_PAGE_MAX = 250;

/** Event properties a later sync may legitimately change. */
const VOLATILE_EVENT_PROPERTIES = [
  "startDate",
  "endDate",
  "isAllDay",
  "location",
  "calendarLink",
  "description",
  "attendees",
] as const;

// ── Layer-2 dedup ───────────────────────────────────────────────────────────────

/**
 * Layer-1b + Layer-2 in ONE read. An event created by approving the first-run
 * import carries `properties.googleEventId` but no external link yet, and a
 * steady run only re-reads CHANGED events — so a moved event would miss the
 * title+hour bucket. The exact Google id wins; the bucket is the cross-source
 * fallback.
 */
async function findExistingEvent(
  owner: string,
  googleEventId: string | null,
  title: string,
  startDate: string,
  isAllDay: boolean
): Promise<string | null> {
  const window = startBucketWindow(startDate, isAllDay);
  if (!window && !googleEventId) return null;
  const inBucket = window
    ? drizzleSql`(${entities.properties}->>'startDate' IS NOT NULL
        AND (${entities.properties}->>'startDate')::timestamptz >= ${window.gte}
        AND (${entities.properties}->>'startDate')::timestamptz < ${window.lt})`
    : drizzleSql`false`;
  const byGoogleId = googleEventId
    ? drizzleSql`${entities.properties}->>'googleEventId' = ${googleEventId}`
    : drizzleSql`false`;
  const rows = await db.query.entities.findMany({
    where: and(
      eq(entities.type, "event"),
      eq(entities.userId, owner),
      isNull(entities.deletedAt),
      drizzleSql`(${byGoogleId} OR ${inBucket})`
    ),
    columns: { id: true, title: true, properties: true },
  });
  if (googleEventId) {
    const exact = rows.find(
      (r) =>
        (r.properties as Record<string, unknown> | null)?.googleEventId ===
        googleEventId
    );
    if (exact) return exact.id;
  }
  const target = normalizeEventTitle(title);
  for (const r of rows) {
    const props = (r.properties ?? {}) as Record<string, unknown>;
    const rowTitle =
      (typeof props.title === "string" && props.title) || r.title || "";
    if (normalizeEventTitle(rowTitle) === target) return r.id;
  }
  return null;
}

// ── Paging across configured calendars ──────────────────────────────────────────

interface CalendarCursor {
  calendar: number;
  token: string | null;
}

function decodeCursor(raw: string | null): CalendarCursor {
  if (!raw) return { calendar: 0, token: null };
  const parsed = JSON.parse(raw) as Partial<CalendarCursor>;
  return {
    calendar: typeof parsed.calendar === "number" ? parsed.calendar : 0,
    token: typeof parsed.token === "string" ? parsed.token : null,
  };
}

async function fetchCalendarPage(
  ctx: SyncKindContext,
  req: SyncFetchRequest
): Promise<SyncFetchPage> {
  // Unconfigured = one pass with NO calendarId (the verb defaults to primary).
  const calendars: (string | null)[] =
    ctx.kindConfig.sources.length > 0 ? ctx.kindConfig.sources : [null];
  const cursor = decodeCursor(req.pageToken);
  const calendarId = calendars[cursor.calendar] ?? null;

  const result = await readVerbPage(ctx, "calendar_list", {
    ...(calendarId ? { calendarId } : {}),
    timeMin: req.windowStart,
    timeMax: req.windowEnd,
    ...(req.mode === "steady" && req.since ? { updatedMin: req.since } : {}),
    maxResults: Math.max(1, Math.min(req.pageSize, CALENDAR_PAGE_MAX)),
    ...(cursor.token ? { pageToken: cursor.token } : {}),
  });
  const items = readCollection(result, "events", "calendar_list");
  const next = readNextPageToken(result);

  let nextPageToken: string | null = null;
  if (next) {
    nextPageToken = JSON.stringify({ calendar: cursor.calendar, token: next });
  } else if (cursor.calendar + 1 < calendars.length) {
    nextPageToken = JSON.stringify({
      calendar: cursor.calendar + 1,
      token: null,
    });
  }
  return { items, nextPageToken };
}

// ── Handler ─────────────────────────────────────────────────────────────────────

registerSyncKind({
  provider: GOOGLE_PROVIDER,
  kind: "event",
  defaults: { enabled: true, windowDays: 90, itemLimit: 200, sources: [] },
  profileSlugs: ["event", "person", "company"],
  openableProfileSlugs: ["event"],
  fetchPage: fetchCalendarPage,
  mapItems(items) {
    const graph = emptySyncGraph();
    let skipped = 0;
    for (const item of items) {
      const mapped = mapGcalToGraph(item as GCalItem);
      if (!mapped) skipped += 1;
      else mergeSyncGraph(graph, mapped.graph);
    }
    return { graph, skipped };
  },
  async findExisting(entity: SyncGraphEntity, ctx: SyncKindContext) {
    if (entity.profileSlug !== "event") return null;
    const startDate = entity.properties.startDate;
    if (typeof startDate !== "string") return null;
    const googleEventId = entity.properties.googleEventId;
    return findExistingEvent(
      ctx.owner,
      typeof googleEventId === "string" ? googleEventId : null,
      entity.title,
      startDate,
      entity.properties.isAllDay === true
    );
  },
  async refreshExisting(entityId: string, entity: SyncGraphEntity) {
    if (entity.profileSlug !== "event") return false;
    const patch: Record<string, unknown> = {};
    for (const key of VOLATILE_EVENT_PROPERTIES) {
      if (entity.properties[key] !== undefined)
        patch[key] = entity.properties[key];
    }
    if (Object.keys(patch).length === 0) return false;
    await db
      .update(entities)
      .set({
        properties: drizzleSql`COALESCE(${entities.properties}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(entities.id, entityId));
    return true;
  },
});
