/**
 * Google Calendar → Synap sync (the `google`/`event` sync-kind handler).
 *
 * Lists upcoming Google Calendar events via the `calendar_list` capability and,
 * for each, lands a sovereign Synap `event` entity — so the SAME source-A
 * mirror that already pushes `event` entities → native Discord scheduled events
 * also covers Google events, with NO direct Google→Discord path.
 *
 * DECOUPLED FROM DISCORD (was: gated on the Discord tool's `discord.eventSync`
 * metadata + unscoped). The enable-gate + config now live on the GOOGLE
 * connection's own `metadata.sync` (per-kind), resolved by the reusable
 * `runConnectionSync` substrate (connection-sync.ts). This module only owns the
 * CALENDAR read verb + the map→create→external-link landing; it registers itself
 * as the `google`/`event` sync kind. Gmail/Drive add `google`/`email` etc. the
 * same way — declare a kind + mapper, no change here.
 *
 * WHY THE EVENT IS CREATED DIRECTLY (R4): the composite `submitCaptureGraph`
 * door auto-applies ONLY when EVERY op auto-approves; a non-approvable
 * company/deal op would silently downgrade the whole graph to a pending
 * proposal — and a proposal doesn't mirror. So the BARE event is created
 * DIRECTLY via `EntityRepository.create` (it always lands + mirrors), and the
 * attendee person/company links ride a SEPARATE best-effort `submitCaptureGraph`
 * that anchors to the already-created event.
 *
 * REACTOR-BUS FAN-OUT (the "landed → automations react" half): a newly-created
 * event fires `emitSideEffects` (reactor bus — search index, embeddings,
 * automation-trigger-match) so rules can act on synced events. A FULL BACKFILL
 * (`scope: "all"`) SUPPRESSES that fan-out so imported history does not replay
 * into automations — the same throttle `inbound-recorder`'s `suppressSideEffects`
 * applies to bulk message backfill. The FACT bus (`EntityRepository.create` →
 * `emitCompleted`, i.e. history/SSE/mirror) fires either way, unchanged.
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
 */

import {
  db,
  entities,
  eq,
  and,
  drizzleSql,
  EntityRepository,
  eventRepository,
} from "@synap/database";
import { emitSideEffects } from "@synap/events";
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
import {
  registerSyncKind,
  runConnectionSync,
  type SyncKindContext,
  type KindSyncResult,
} from "./connection-sync.js";

const logger = createLogger({ module: "gcal-import" });

const GOOGLE_PROVIDER = "google";
/** Full-backfill window: pull events back this far when `scope: "all"`. */
const BACKFILL_WINDOW_MS = 365 * 24 * 3_600_000;

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

// ── Per-item landing ────────────────────────────────────────────────────────────

type LandOutcome = "created" | "linked" | "skipped" | "failed";

async function landCalendarItem(
  item: GCalItem,
  ctx: {
    entityRepo: EntityRepository;
    idempotency: ReturnType<typeof makeExternalLinkIdempotency>;
    actor: string;
    owner: string;
    workspaceId: string | null;
    backfill: boolean;
  }
): Promise<LandOutcome> {
  const graph = mapGcalToGraph(item);
  if (!graph) return "skipped";
  const { googleEventId, event, isAllDay } = graph;

  try {
    // Layer-1: same Google event already imported? Refresh its times, done.
    const linkedId = await ctx.idempotency.lookup(
      GOOGLE_PROVIDER,
      googleEventId
    );
    if (linkedId) {
      await patchEventTimes(linkedId, event.properties);
      return "linked";
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
      await ctx.idempotency.register(adoptedId, GOOGLE_PROVIDER, googleEventId);
      await patchEventTimes(adoptedId, event.properties);
      return "linked";
    }

    // New event → create the BARE entity DIRECTLY (R4) so it always lands.
    const createdEvent = await ctx.entityRepo.create(
      {
        profileSlug: "event",
        title: event.title,
        properties: event.properties,
        workspaceId: ctx.workspaceId,
        userId: ctx.owner,
      },
      ctx.owner
    );
    // Register the stable external id (entity_external_links + identity signal).
    await ctx.idempotency.register(
      createdEvent.id,
      GOOGLE_PROVIDER,
      googleEventId
    );

    // REACTOR BUS (the "landed → automations react" half). `EntityRepository.create`
    // fires only the FACT bus (emitCompleted → events/SSE/mirror); it does NOT
    // reach the reactor registry, so without this an automation could never react
    // to a synced event. A FULL BACKFILL suppresses the fan-out so history does
    // not replay into automations (parity with inbound-recorder's
    // `suppressSideEffects`). Best-effort — never un-lands the event.
    if (!ctx.backfill) {
      await emitSideEffects({
        subjectType: "entity",
        action: "create",
        subjectId: createdEvent.id,
        userId: ctx.owner,
        workspaceId: ctx.workspaceId,
        data: { profileSlug: "event", source: "google" },
      }).catch((err) =>
        logger.warn(
          { err, googleEventId },
          "gcal sync: reactor-bus emit failed (event kept)"
        )
      );
    }

    // BEST-EFFORT: attach attendee person/company + relations, anchored to the
    // just-created event (existingEntityId), through the composite door — its
    // resolver strong-signal auto-links people by email / companies by website.
    // A failure here must NEVER un-create the event (which already mirrors).
    if (graph.entities.length > 1) {
      const graphEntities = graph.entities.map((e) =>
        e.ref === "event" ? { ...e, existingEntityId: createdEvent.id } : e
      );
      await submitCaptureGraph({
        userId: ctx.actor,
        workspaceId: ctx.workspaceId,
        entities: graphEntities,
        relations: graph.relations,
        summary: `Google Calendar event — ${event.title}`,
      }).catch((err) =>
        logger.warn(
          { err, googleEventId },
          "gcal sync: attendee graph failed (event kept)"
        )
      );
    }
    return "created";
  } catch (err) {
    logger.warn({ err, googleEventId }, "gcal sync: event → entity failed");
    return "failed";
  }
}

// ── The `google`/`event` sync-kind handler ───────────────────────────────────────

async function runCalendarSync(ctx: SyncKindContext): Promise<KindSyncResult> {
  const { owner, workspaceId, connectionId, backfill } = ctx;

  const actor = (await getCaptureAgentUserId()) ?? owner;
  const entityRepo = new EntityRepository(db, eventRepository);
  const idempotency = makeExternalLinkIdempotency(db, {
    namespace: "gcal",
    provider: GOOGLE_PROVIDER,
    userId: owner,
  });

  // Scope → verb window. `recent` = the ongoing window from now (maxResults at
  // the clamp ceiling to reduce the chance an in-window event is missed).
  // `all` = a full backfill reaching BACKFILL_WINDOW_MS into the past. (Deep
  // pagination past the 50-item clamp is a deliberate follow-up.)
  const baseParams: Record<string, unknown> = backfill
    ? {
        timeMin: new Date(Date.now() - BACKFILL_WINDOW_MS).toISOString(),
        maxResults: 50,
      }
    : { timeMin: "@now", maxResults: 50 };

  // One pass per configured calendar; UNCONFIGURED = a single default pass with
  // NO `calendarId` param — byte-for-byte the pre-redesign call (lists primary).
  const calendarIds: (string | null)[] =
    ctx.kindConfig.sources.length > 0 ? ctx.kindConfig.sources : [null];

  let processed = 0;
  let created = 0;
  let linkedExisting = 0;
  let failed = 0;

  for (const calendarId of calendarIds) {
    const cap = await executeCapability({
      verbId: "calendar_list",
      parameters: { ...baseParams, ...(calendarId ? { calendarId } : {}) },
      userId: owner,
      workspaceId,
      connectionSelector: connectionId ? { connectionId } : undefined,
    });

    const capErr = capErrorMessage(cap);
    if (capErr && isConnectionAuthError(capErr)) {
      // Dead Google connection → nudge the operator to reconnect (deduped),
      // instead of silently importing nothing every tick. The dedup watermark
      // now lives on the GOOGLE connection tool (the source of truth for this
      // sync), not a foreign Discord row.
      await notifyConnectorUnhealthy({
        connectorKey: "google",
        connectorName: "Google Workspace",
        reconnectHint:
          "Reconnect it in the app (Settings → Connectors) or run `/connect provider:google` in Discord.",
        userId: owner,
        workspaceId,
        watermarkToolId: ctx.toolId,
        watermarkMetadata: ctx.toolMetadata,
        discordTeamChannelId: resolveNoticeChannelId(
          ctx.toolMetadata,
          ctx.announceChannelId
        ),
        errorMessage: capErr,
      });
      return { skipped: true, reason: "google_connection_unhealthy" };
    }
    if (cap.kind !== "run") {
      logger.warn(
        { capKind: cap.kind, calendarId },
        "calendar_list did not run — skipping calendar"
      );
      continue;
    }

    const result = cap.result as { events?: GCalItem[] } | undefined;
    const items = Array.isArray(result?.events) ? result!.events : [];
    processed += items.length;

    for (const item of items) {
      const outcome = await landCalendarItem(item, {
        entityRepo,
        idempotency,
        actor,
        owner,
        workspaceId,
        backfill,
      });
      if (outcome === "created") created += 1;
      else if (outcome === "linked") linkedExisting += 1;
      else if (outcome === "failed") failed += 1;
    }
  }

  logger.info(
    { processed, created, linkedExisting, failed, backfill },
    "gcal sync run complete"
  );
  return { processed, created, linkedExisting, failed };
}

// Register the calendar sync kind on module load (side-effect). Importing this
// module — which every `runGcalImport` caller and the api barrel do — makes the
// `google`/`event` handler visible to `runConnectionSync`.
registerSyncKind({
  provider: GOOGLE_PROVIDER,
  kind: "event",
  // Template default: sync is on, ongoing (recent) window, primary calendar.
  defaults: { enabled: true, scope: "recent", sources: [] },
  run: runCalendarSync,
});

// ── Back-compat entry (the cron + api barrel call this) ───────────────────────────

/**
 * Sync Google Calendar → Synap `event` entities. Thin adapter over the
 * connection-sync substrate that projects the `event` kind's result back into
 * the historical `RunGcalImportResult` shape the cron logs.
 *
 * @param workspaceId optional caller scope — provided narrows to that
 *   workspace's Google connection; omitted (the cron) uses the unscoped tie-break.
 */
export async function runGcalImport(
  workspaceId?: string | null
): Promise<RunGcalImportResult> {
  const res = await runConnectionSync({
    provider: GOOGLE_PROVIDER,
    workspaceId,
  });
  if (res.skipped) return { skipped: true, reason: res.reason };
  const event = res.kinds?.["event"];
  if (!event) return { skipped: true, reason: "event_kind_not_run" };
  if ("skipped" in event) return { skipped: true, reason: event.reason };
  return {
    processed: event.processed,
    created: event.created,
    linkedExisting: event.linkedExisting,
    failed: event.failed,
  };
}
