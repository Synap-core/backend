/**
 * Event Sync — mirror upcoming Synap events into NATIVE Discord scheduled events.
 *
 * Runs on a schedule: the jobs `event-sync-cron` worker invokes this in-process
 * via the `registerEventSyncRunner` IoC slot. For the pod's Discord tool with a
 * `metadata.discord.eventSync` config it collects upcoming events from three
 * sources and creates one native Discord "external" scheduled event per new item:
 *   A. `event` entities             — Synap-native events (properties.startDate…)
 *   B. Stellar grant deadlines      — the SAME `type='event'` rows tagged
 *                                     `properties.source==='stellar'`
 *   C. Google Calendar              — via the `calendar_list` capability
 *
 * Each event's location is the Google Meet link (when present) else the physical
 * address; the full address / details ride in the Discord event `description`.
 *
 * Idempotency is migration-free (mirrors the mail-feed watermark): a `synced`
 * dedup map (`sourceKey → discordEventId`) lives in the Discord tool metadata.
 * Keys are rebuilt from the current window each run, so past / out-of-window
 * events prune themselves and the map never grows unbounded.
 *
 * Lives in `@synap/api` because `calendar_list` (executeCapability) is api-side;
 * the jobs `event-sync-cron` worker invokes it in-process via the
 * `registerEventSyncRunner` IoC slot (jobs can't import @synap/api).
 */

import {
  db,
  tools,
  entities,
  eq,
  and,
  drizzleSql,
  enqueueChannelEgress,
  ensureExternalChannel,
  insertChannelMessage,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { executeCapability } from "../capabilities/execute-capability.js";
import {
  notifyConnectorUnhealthy,
  isConnectionAuthError,
  capErrorMessage,
  resolveNoticeChannelId,
} from "../connection-health/notify-connector-unhealthy.js";

const logger = createLogger({ module: "event-sync" });

const DEFAULT_WINDOW_DAYS = 60;
const ALL_SOURCES = ["event", "calendar", "deadline"] as const;
const HOUR_MS = 3_600_000;

// ── Config + wire types ────────────────────────────────────────────────────────

export interface EventSyncConfig {
  enabled?: boolean;
  /** Which sources to mirror. Subset of 'event' | 'calendar' | 'deadline'. */
  sources?: string[];
  /** Look-ahead window in days (default 60). */
  windowDays?: number;
  /** Optional Discord channel id to post a short card per created event. */
  announceChannelId?: string;
  /** Dedup map: sourceKey → created Discord scheduled-event id. */
  synced?: Record<string, string>;
  /** Optional: pin the event sync to a specific Google connection (1-of-N). Absent → the install-default connection. */
  connectionId?: string;
}

interface DiscordToolMetadata {
  discord?: { eventSync?: EventSyncConfig } & Record<string, unknown>;
  [k: string]: unknown;
}

export type EventSourceType = "synap_event" | "deadline" | "google_calendar";

/** One upcoming event normalized across all sources. */
export interface UpcomingEvent {
  sourceType: EventSourceType;
  sourceId: string;
  title: string;
  /** ISO8601 start. */
  startsAt: string;
  /** ISO8601 end (optional — synthesized as +1h when absent). */
  endsAt?: string;
  /** Physical address / venue. */
  location?: string;
  /** Meet / video link (preferred Discord location when present). */
  url?: string;
  description?: string;
  /** The Synap entity this event came from, when applicable. */
  linkedEntityId?: string;
}

export interface RunEventSyncResult {
  skipped?: boolean;
  reason?: string;
  processed?: number;
  created?: number;
  skippedExisting?: number;
}

// ── Pure helpers (unit-tested) ─────────────────────────────────────────────────

/** Stable dedup key for an event. */
export function sourceKey(
  sourceType: EventSourceType,
  sourceId: string
): string {
  return `${sourceType}:${sourceId}`;
}

/**
 * EXTERNAL Discord events REQUIRE an end time — synthesize `start + 1h` when the
 * source has none. Returns the given `endsAt` untouched when present.
 */
export function synthesizeEndTime(startsAt: string, endsAt?: string): string {
  if (endsAt) return endsAt;
  const startMs = Date.parse(startsAt);
  if (Number.isNaN(startMs)) return startsAt; // caller validates start separately
  return new Date(startMs + HOUR_MS).toISOString();
}

/**
 * Keep predicate for an `event` entity row given the config sources. A row is a
 * Stellar deadline when `properties.source === 'stellar'`, else a native event.
 * `sources` excluding 'deadline' drops stellar rows; excluding 'event' keeps only
 * stellar rows.
 */
export function keepEntityRow(isStellar: boolean, sources: string[]): boolean {
  return isStellar ? sources.includes("deadline") : sources.includes("event");
}

/**
 * Decide the Discord `location` (a free-text string, capped at 100 chars by
 * Discord) and the `description`. Prefer the meet link as the location; when it's
 * used, surface the physical address in the description. When only an address
 * exists, use it as the location — and if it's long, keep the full text in the
 * description too (since Discord truncates the location).
 */
export function buildEventLocation(evt: UpcomingEvent): {
  location: string;
  description?: string;
} {
  const meet = evt.url?.trim();
  const address = evt.location?.trim();
  const descParts: string[] = [];
  if (evt.description?.trim()) descParts.push(evt.description.trim());

  let location: string;
  if (meet) {
    location = meet;
    if (address) descParts.push(`Location: ${address}`);
  } else if (address) {
    location = address;
    if (address.length > 100) descParts.push(`Location: ${address}`);
  } else {
    location = evt.title;
  }

  return {
    location,
    description: descParts.length > 0 ? descParts.join("\n\n") : undefined,
  };
}

/** Extract an ISO time from a Google Calendar start/end field. */
function gcalTime(t: unknown): string | undefined {
  if (!t) return undefined;
  if (typeof t === "string") return t;
  const obj = t as { dateTime?: string; date?: string };
  return obj.dateTime || obj.date || undefined;
}

interface EntityRow {
  id: string;
  title: string | null;
  properties: Record<string, unknown> | null;
}

/** Normalize one `event` entity row → UpcomingEvent (null when no start). */
export function normalizeEntity(row: EntityRow): UpcomingEvent | null {
  const props = (row.properties ?? {}) as Record<string, unknown>;
  const startsAt =
    typeof props.startDate === "string" ? props.startDate.trim() : "";
  if (!startsAt) return null;

  const isStellar = props.source === "stellar";
  const title =
    (typeof props.title === "string" && props.title.trim()) ||
    row.title?.trim() ||
    "(untitled event)";

  return {
    sourceType: isStellar ? "deadline" : "synap_event",
    sourceId: row.id,
    title,
    startsAt,
    endsAt: typeof props.endDate === "string" ? props.endDate : undefined,
    location: typeof props.location === "string" ? props.location : undefined,
    url:
      typeof props.calendarLink === "string" ? props.calendarLink : undefined,
    description:
      typeof props.description === "string" ? props.description : undefined,
    linkedEntityId: row.id,
  };
}

interface GCalItem {
  id?: string;
  summary?: string;
  start?: unknown;
  end?: unknown;
  location?: string;
  htmlLink?: string;
  hangoutLink?: string;
  description?: string;
}

/** Normalize one Google Calendar item → UpcomingEvent (null when no id/start). */
export function normalizeCalendarItem(item: GCalItem): UpcomingEvent | null {
  const startsAt = gcalTime(item.start);
  if (!item.id || !startsAt) return null;
  return {
    sourceType: "google_calendar",
    sourceId: item.id,
    title: item.summary?.trim() || "(untitled event)",
    startsAt,
    endsAt: gcalTime(item.end),
    location: item.location,
    url: item.hangoutLink,
    description: item.description,
  };
}

/** Compact one-line-per-field announcement card for a newly-created event. */
export function buildEventAnnouncement(evt: UpcomingEvent): string {
  const when = new Date(Date.parse(evt.startsAt)).toISOString();
  const lines = [`**${evt.title}**`, `🗓️ ${when}`];
  if (evt.url) lines.push(`🔗 ${evt.url}`);
  else if (evt.location) lines.push(`📍 ${evt.location}`);
  lines.push("_Added to the Discord events calendar._");
  return lines.join("\n");
}

// ── Metadata persistence (read-modify-write, clobber-safe) ─────────────────────

// ATOMIC single-leaf write on `{discord,eventSync,synced}` only — NOT a full
// metadata overwrite. Prevents this cron from clobbering the mail-feed watermark
// or an operator's config change (they touch other leaves). runEventSync only
// runs when metadata.discord.eventSync exists, so the path is present.
async function persistSynced(
  toolId: string,
  nextSynced: Record<string, string>
): Promise<void> {
  await db
    .update(tools)
    .set({
      metadata: drizzleSql`jsonb_set(COALESCE(${tools.metadata}, '{}'::jsonb), '{discord,eventSync,synced}', ${JSON.stringify(nextSynced)}::jsonb, true)`,
      updatedAt: new Date(),
    })
    .where(eq(tools.id, toolId));
}

// ── Source fetchers ─────────────────────────────────────────────────────────────

/** Sources A/B — `event` entities (+ Stellar deadlines) inside the window. */
async function fetchEntityEvents(
  windowDays: number,
  sources: string[]
): Promise<UpcomingEvent[]> {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + windowDays * 24 * HOUR_MS);

  const rows = await db.query.entities.findMany({
    where: and(
      eq(entities.type, "event"),
      drizzleSql`${entities.properties}->>'startDate' IS NOT NULL`,
      drizzleSql`(${entities.properties}->>'startDate')::timestamptz >= ${now.toISOString()}`,
      drizzleSql`(${entities.properties}->>'startDate')::timestamptz <= ${windowEnd.toISOString()}`
    ),
    columns: { id: true, title: true, properties: true },
  });

  const out: UpcomingEvent[] = [];
  for (const row of rows) {
    const props = (row.properties ?? {}) as Record<string, unknown>;
    if (!keepEntityRow(props.source === "stellar", sources)) continue;
    const evt = normalizeEntity(row as EntityRow);
    if (evt) out.push(evt);
  }
  return out;
}

/** Source C — Google Calendar via the `calendar_list` capability. Returns the
 * events plus an `authError` message when the connection is dead (so the caller
 * can nudge the operator to reconnect instead of silently syncing nothing). */
async function fetchCalendarEvents(
  owner: string,
  workspaceId: string | null,
  connectionId: string | null | undefined
): Promise<{ events: UpcomingEvent[]; authError?: string }> {
  // maxResults at the verb's clamp ceiling (50) to reduce the chance an in-window
  // event is missed — the synced dedup map is rebuilt from each fetch, so an
  // in-window event beyond the fetch limit could be pruned and later re-created.
  const cap = await executeCapability({
    verbId: "calendar_list",
    parameters: { timeMin: "@now", maxResults: 50 },
    userId: owner,
    workspaceId,
    connectionSelector: connectionId ? { connectionId } : undefined,
  });

  // A dead Google connection surfaces as an error envelope inside a kind:"run"
  // result (execute-provider-verb returns it as-is on failure) — flag it so the
  // caller can nudge the operator, rather than silently returning no events.
  const capErr = capErrorMessage(cap);
  if (capErr && isConnectionAuthError(capErr)) {
    return { events: [], authError: capErr };
  }
  if (cap.kind !== "run") {
    logger.warn({ capKind: cap.kind }, "calendar_list did not run — skipping");
    return { events: [] };
  }

  const result = cap.result as { events?: GCalItem[] } | undefined;
  const items = Array.isArray(result?.events) ? result!.events : [];
  const out: UpcomingEvent[] = [];
  for (const item of items) {
    const evt = normalizeCalendarItem(item);
    if (evt) out.push(evt);
  }
  return { events: out };
}

// ── Main ────────────────────────────────────────────────────────────────────────

export async function runEventSync(): Promise<RunEventSyncResult> {
  // Resolve the pod's Discord tool + its event-sync config.
  const discordTool = await db.query.tools.findFirst({
    where: eq(tools.name, "discord"),
    columns: {
      id: true,
      createdBy: true,
      workspaceId: true,
      metadata: true,
    },
  });

  if (!discordTool) {
    return { skipped: true, reason: "no_discord_tool" };
  }

  const metadata = (discordTool.metadata ?? {}) as DiscordToolMetadata;
  const eventSync = metadata.discord?.eventSync;

  if (!eventSync?.enabled) {
    return { skipped: true, reason: "event_sync_disabled" };
  }

  const owner = discordTool.createdBy;
  const workspaceId = discordTool.workspaceId ?? null;
  const sources =
    Array.isArray(eventSync.sources) && eventSync.sources.length > 0
      ? eventSync.sources
      : [...ALL_SOURCES];
  const windowDays = eventSync.windowDays ?? DEFAULT_WINDOW_DAYS;
  const existingSynced = eventSync.synced ?? {};

  // Collect + normalize upcoming events across all enabled sources.
  const events: UpcomingEvent[] = [];
  events.push(...(await fetchEntityEvents(windowDays, sources)));
  if (sources.includes("calendar")) {
    const cal = await fetchCalendarEvents(
      owner,
      workspaceId,
      eventSync.connectionId
    );
    events.push(...cal.events);
    // Dead Google connection → nudge the operator to reconnect (deduped), instead
    // of silently mirroring nothing every 6h.
    if (cal.authError) {
      await notifyConnectorUnhealthy({
        connectorKey: "google",
        connectorName: "Google Workspace",
        reconnectHint:
          "Reconnect it in the app (Settings → Connectors) or run `/connect provider:google` in Discord.",
        userId: owner,
        workspaceId,
        watermarkToolId: discordTool.id,
        watermarkMetadata: metadata,
        // System notice → the configured feedback/notices channel, not the
        // event-announce channel (which is where the reconnect nudge wrongly landed).
        discordTeamChannelId: resolveNoticeChannelId(
          metadata,
          eventSync.announceChannelId
        ),
        errorMessage: cal.authError,
      });
    }
  }

  const now = Date.now();
  const nextSynced: Record<string, string> = {};
  let created = 0;
  let skippedExisting = 0;

  for (const evt of events) {
    const key = sourceKey(evt.sourceType, evt.sourceId);

    // Already mirrored — carry the key forward (prunes past/out-of-window keys,
    // which simply aren't in this run's window set).
    const existingId = existingSynced[key];
    if (existingId) {
      nextSynced[key] = existingId;
      skippedExisting += 1;
      continue;
    }

    // Validate the start is a parseable future time before hitting Discord.
    const startMs = Date.parse(evt.startsAt);
    if (Number.isNaN(startMs) || startMs < now) continue;
    const startIso = new Date(startMs).toISOString();
    const endIso = new Date(
      Date.parse(synthesizeEndTime(evt.startsAt, evt.endsAt))
    ).toISOString();

    const { location, description } = buildEventLocation(evt);

    try {
      // Enqueue an agnostic `scheduled_event` intent — the bridge resolves its
      // own guild and creates the native event. The dedup map now carries the
      // egress row id so a re-run doesn't re-enqueue the same event.
      const enq = await enqueueChannelEgress({
        externalSource: "discord",
        externalId: "",
        kind: "scheduled_event",
        payload: {
          name: evt.title,
          description,
          startTime: startIso,
          endTime: endIso,
          location,
        },
        workspaceId,
      });
      nextSynced[key] = enq.id;
      created += 1;

      // Optional announce card into the bound Synap channel (auto-mirrors).
      if (eventSync.announceChannelId) {
        const { channelId } = await ensureExternalChannel({
          provider: "discord",
          externalId: eventSync.announceChannelId,
          userId: owner,
          workspaceId,
          title: "Events",
          branchPurpose: "team",
        });
        await insertChannelMessage({
          channelId,
          content: buildEventAnnouncement(evt),
          userId: owner,
          metadata: {
            eventSync: true,
            egressId: enq.id,
            sourceType: evt.sourceType,
          },
        }).catch((err) =>
          logger.warn({ err, key }, "event announce post failed")
        );
      }
    } catch (err) {
      logger.warn(
        { err, key },
        "scheduled_event egress enqueue failed — skipping"
      );
      continue;
    }
  }

  // Persist the pruned + updated dedup map (atomic single-leaf jsonb_set).
  await persistSynced(discordTool.id, nextSynced).catch((err) =>
    logger.warn({ err }, "event-sync synced-map persist failed")
  );

  logger.info(
    { processed: events.length, created, skippedExisting },
    "event sync run complete"
  );

  return { processed: events.length, created, skippedExisting };
}
