/**
 * Google Calendar → Synap importer (the event-sync redesign).
 *
 * Runs FIRST inside the `event-sync-cron` tick, BEFORE the source-A Discord
 * mirror pass. Lists upcoming Google Calendar events via the `calendar_list`
 * capability and, for each, ensures a Synap `event` entity exists — so the
 * SAME source-A mirror that already pushes `event` entities → native Discord
 * scheduled events also covers Google events, with NO direct Google→Discord path.
 *
 * WHY THE EVENT IS CREATED DIRECTLY (R4): the composite `submitCaptureGraph`
 * door auto-applies ONLY when EVERY op auto-approves; a non-approvable
 * company/deal op would silently downgrade the whole graph to a pending
 * proposal — and a proposal doesn't mirror. So the BARE event is created
 * DIRECTLY via `EntityRepository.create` (it always lands + mirrors), and the
 * attendee person/company links ride a SEPARATE best-effort `submitCaptureGraph`
 * that anchors to the already-created event.
 *
 * DEDUP is done IN THIS RUNNER (never via submitCaptureGraph/resolveIdentity —
 * its weak path matches TITLE ALONE and would collapse recurring same-title
 * events), in two layers:
 *   - Layer-1 (stable external id): `entity_external_links (google, googleEventId)`
 *     — same-event re-run idempotency, registered on create.
 *   - Layer-2 (cross-source): (normalized title, start-time bucket) query —
 *     hour bucket for timed events, DAY bucket for all-day — so an event already
 *     created by another source (Cal.com booking, manual entry) is adopted, not
 *     duplicated.
 *
 * Lives in @synap/api because `calendar_list` (executeCapability) + the entity
 * repo + submitCaptureGraph are api-side; the jobs `event-sync-cron` worker
 * invokes it in-process via the `registerEventSyncRunner` IoC slot.
 */

import {
  db,
  tools,
  entities,
  eq,
  and,
  drizzleSql,
  EntityRepository,
  eventRepository,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { executeCapability } from "../capabilities/execute-capability.js";
import { submitCaptureGraph } from "../capture-agent/submit-capture-graph.js";
import { getCaptureAgentUserId } from "../capture-agent/ensure-capture-agent.js";
import { makeExternalLinkIdempotency } from "../../utils/entity-link-idempotency.js";
import {
  notifyConnectorUnhealthy,
  isConnectionAuthError,
  capErrorMessage,
  resolveNoticeChannelId,
} from "../connection-health/notify-connector-unhealthy.js";
import {
  mapGcalToGraph,
  normalizeEventTitle,
  startBucketWindow,
  type GCalItem,
} from "./map-gcal-to-graph.js";

const logger = createLogger({ module: "gcal-import" });

const GOOGLE_PROVIDER = "google";

// ── Config (read off the same Discord tool as event-sync) ──────────────────────

interface EventSyncConfig {
  enabled?: boolean;
  sources?: string[];
  announceChannelId?: string;
  /** Optional: pin the Google sync to a specific connection (1-of-N). */
  connectionId?: string;
}

interface DiscordToolMetadata {
  discord?: { eventSync?: EventSyncConfig } & Record<string, unknown>;
  [k: string]: unknown;
}

export interface RunGcalImportResult {
  skipped?: boolean;
  reason?: string;
  processed?: number;
  created?: number;
  linkedExisting?: number;
  failed?: number;
}

// ── Dedup lookups (IN the runner, not via resolveIdentity) ─────────────────────

/**
 * Layer-2: find an existing Synap `event` whose (normalized title, start bucket)
 * matches — an event another source already created. Returns its id or null.
 * The bucket keeps recurring same-title occurrences DISTINCT.
 */
async function findExistingEventByBucket(
  title: string,
  startDate: string,
  isAllDay: boolean
): Promise<string | null> {
  const window = startBucketWindow(startDate, isAllDay);
  if (!window) return null;
  const rows = await db.query.entities.findMany({
    where: and(
      eq(entities.type, "event"),
      drizzleSql`${entities.properties}->>'startDate' IS NOT NULL`,
      drizzleSql`(${entities.properties}->>'startDate')::timestamptz >= ${window.gte}`,
      drizzleSql`(${entities.properties}->>'startDate')::timestamptz < ${window.lt}`
    ),
    columns: { id: true, title: true, properties: true },
  });
  const target = normalizeEventTitle(title);
  for (const r of rows) {
    const props = (r.properties ?? {}) as Record<string, unknown>;
    const rowTitle =
      (typeof props.title === "string" && props.title) || r.title || "";
    if (normalizeEventTitle(rowTitle) === target) return r.id;
  }
  return null;
}

/** Patch times/link/location onto an already-existing event (idempotent refresh). */
async function patchEventTimes(
  entityId: string,
  patch: Record<string, unknown>
): Promise<void> {
  await db
    .update(entities)
    .set({
      properties: drizzleSql`COALESCE(${entities.properties}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(entities.id, entityId));
}

// ── Main ───────────────────────────────────────────────────────────────────────

export async function runGcalImport(): Promise<RunGcalImportResult> {
  const discordTool = await db.query.tools.findFirst({
    where: eq(tools.name, "discord"),
    columns: { id: true, createdBy: true, workspaceId: true, metadata: true },
  });
  if (!discordTool) return { skipped: true, reason: "no_discord_tool" };

  const metadata = (discordTool.metadata ?? {}) as DiscordToolMetadata;
  const eventSync = metadata.discord?.eventSync;
  if (!eventSync?.enabled) {
    return { skipped: true, reason: "event_sync_disabled" };
  }
  // The Google import runs when the operator opted into the "calendar" source
  // (or left `sources` unset — the pre-redesign default was calendar-inclusive).
  const wantsCalendar =
    !Array.isArray(eventSync.sources) || eventSync.sources.includes("calendar");
  if (!wantsCalendar) {
    return { skipped: true, reason: "calendar_source_disabled" };
  }

  const owner = discordTool.createdBy;
  const workspaceId = discordTool.workspaceId ?? null;

  // Fetch upcoming Google events via the capability (maxResults at the clamp
  // ceiling to reduce the chance an in-window event is missed).
  const cap = await executeCapability({
    verbId: "calendar_list",
    parameters: { timeMin: "@now", maxResults: 50 },
    userId: owner,
    workspaceId,
    connectionSelector: eventSync.connectionId
      ? { connectionId: eventSync.connectionId }
      : undefined,
  });

  const capErr = capErrorMessage(cap);
  if (capErr && isConnectionAuthError(capErr)) {
    // Dead Google connection → nudge the operator to reconnect (deduped), instead
    // of silently importing nothing every tick.
    await notifyConnectorUnhealthy({
      connectorKey: "google",
      connectorName: "Google Workspace",
      reconnectHint:
        "Reconnect it in the app (Settings → Connectors) or run `/connect provider:google` in Discord.",
      userId: owner,
      workspaceId,
      watermarkToolId: discordTool.id,
      watermarkMetadata: metadata as Record<string, unknown>,
      discordTeamChannelId: resolveNoticeChannelId(
        metadata,
        eventSync.announceChannelId
      ),
      errorMessage: capErr,
    });
    return { skipped: true, reason: "google_connection_unhealthy" };
  }
  if (cap.kind !== "run") {
    logger.warn({ capKind: cap.kind }, "calendar_list did not run — skipping");
    return { skipped: true, reason: `calendar_list_${cap.kind}` };
  }

  const result = cap.result as { events?: GCalItem[] } | undefined;
  const items = Array.isArray(result?.events) ? result!.events : [];

  const actor = (await getCaptureAgentUserId()) ?? owner;
  const entityRepo = new EntityRepository(db, eventRepository);
  const idempotency = makeExternalLinkIdempotency(db, {
    namespace: "gcal",
    provider: GOOGLE_PROVIDER,
    userId: owner,
  });

  let created = 0;
  let linkedExisting = 0;
  let failed = 0;

  for (const item of items) {
    const graph = mapGcalToGraph(item);
    if (!graph) continue;
    const { googleEventId, event, isAllDay } = graph;

    try {
      // Layer-1: same Google event already imported? Refresh its times, done.
      const linkedId = await idempotency.lookup(GOOGLE_PROVIDER, googleEventId);
      if (linkedId) {
        await patchEventTimes(linkedId, event.properties);
        linkedExisting += 1;
        continue;
      }

      // Layer-2: an event another source already created (same normalized title +
      // start bucket)? Adopt it — register the Google external id + refresh times,
      // so future runs hit Layer-1 and it never duplicates.
      const adoptedId = await findExistingEventByBucket(
        event.title,
        typeof event.properties.startDate === "string"
          ? event.properties.startDate
          : "",
        isAllDay
      );
      if (adoptedId) {
        await idempotency.register(adoptedId, GOOGLE_PROVIDER, googleEventId);
        await patchEventTimes(adoptedId, event.properties);
        linkedExisting += 1;
        continue;
      }

      // New event → create the BARE entity DIRECTLY (R4) so it always lands.
      const createdEvent = await entityRepo.create(
        {
          profileSlug: "event",
          title: event.title,
          properties: event.properties,
          workspaceId,
          userId: owner,
        },
        owner
      );
      // Register the stable external id (entity_external_links + identity signal).
      await idempotency.register(
        createdEvent.id,
        GOOGLE_PROVIDER,
        googleEventId
      );
      created += 1;

      // BEST-EFFORT: attach attendee person/company + relations, anchored to the
      // just-created event (existingEntityId), through the composite door — its
      // resolver strong-signal auto-links people by email / companies by website.
      // A failure here must NEVER un-create the event (which already mirrors).
      if (graph.entities.length > 1) {
        const graphEntities = graph.entities.map((e) =>
          e.ref === "event" ? { ...e, existingEntityId: createdEvent.id } : e
        );
        await submitCaptureGraph({
          userId: actor,
          workspaceId,
          entities: graphEntities,
          relations: graph.relations,
          summary: `Google Calendar event — ${event.title}`,
        }).catch((err) =>
          logger.warn(
            { err, googleEventId },
            "gcal import: attendee graph failed (event kept)"
          )
        );
      }
    } catch (err) {
      failed += 1;
      logger.warn({ err, googleEventId }, "gcal import: event → entity failed");
    }
  }

  logger.info(
    { processed: items.length, created, linkedExisting, failed },
    "gcal import run complete"
  );
  return { processed: items.length, created, linkedExisting, failed };
}
