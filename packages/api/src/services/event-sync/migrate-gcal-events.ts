/**
 * ONE-TIME migration: the event-sync redesign cutover.
 *
 * BEFORE the redesign, Google Calendar events pushed STRAIGHT to Discord and
 * the only trace was a dedup entry `synced["google_calendar:${gcalId}"] =
 * <discordEventId>` (~50 live) in the Discord tool metadata. AFTER the redesign
 * Google flows through Synap: run-gcal-import creates an `event` entity and
 * source-A mirrors it.
 *
 * THE DOUBLE-CREATE HAZARD this fixes: without a cutover, the first post-deploy
 * tick would (a) run-gcal-import creates a Synap `event` for each still-live
 * Google event, then (b) source A sees a BRAND-NEW event entity with NO
 * `synced` skip-key and creates a SECOND native Discord scheduled event next to
 * the one the old direct path already made.
 *
 * This migration, run ONCE before/at deploy, closes that gap. For every live
 * `google_calendar:${gcalId}` entry it:
 *   1. creates the Synap `event` entity (idempotent: skips if the google
 *      external-id already resolves to one) + registers `external_id
 *      google:${gcalId}` — so run-gcal-import's Layer-1 lookup adopts it and
 *      never re-creates it;
 *   2. RE-KEYS the synced map: writes `synced["synap_event:${entityId}"] =
 *      <old discordEventId>` and DELETES the old `google_calendar:*` key — so
 *      source A sees the skip-key for the new entity and does NOT create a
 *      second Discord event (the value need only be non-empty to hit the skip
 *      branch at run-event-sync's `existingSynced[key]` check).
 * Stale `google_calendar:*` keys whose Google event is no longer in-window are
 * simply dropped (their Discord event is past; no entity is created, so source A
 * never touches them — no double-create).
 *
 * IDEMPOTENT: safe to re-run. A second run finds the external-id already
 * registered (skips create) and the map already re-keyed (no google_calendar:*
 * keys left).
 *
 * Run: `pnpm --filter @synap/api exec tsx src/services/event-sync/migrate-gcal-events.ts`
 * (or import + call `migrateGcalEvents()` from an ops script).
 */

import {
  db,
  tools,
  eq,
  drizzleSql,
  EntityRepository,
  eventRepository,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { executeCapability } from "../capabilities/execute-capability.js";
import { makeExternalLinkIdempotency } from "../../utils/entity-link-idempotency.js";
import { mapGcalToGraph, type GCalItem } from "./map-gcal-to-graph.js";
import { resolveTool } from "../tools/resolve-tool.js";
import { isDiscordEventSyncEnabled } from "./discord-metadata.js";

const logger = createLogger({ module: "migrate-gcal-events" });

const GOOGLE_PROVIDER = "google";
const GCAL_KEY_PREFIX = "google_calendar:";

interface EventSyncConfig {
  enabled?: boolean;
  connectionId?: string;
  synced?: Record<string, string>;
}
interface DiscordToolMetadata {
  discord?: { eventSync?: EventSyncConfig } & Record<string, unknown>;
  [k: string]: unknown;
}

export interface MigrateGcalEventsResult {
  skipped?: boolean;
  reason?: string;
  /** google_calendar:* keys found in the live synced map. */
  gcalKeys?: number;
  /** entities created (or already present) + re-keyed to synap_event:*. */
  rekeyed?: number;
  /** stale gcal keys (event no longer in-window) dropped. */
  dropped?: number;
}

export async function migrateGcalEvents(): Promise<MigrateGcalEventsResult> {
  // Resolve via the ONE door (resolveTool) — this is a one-time ops script
  // with no caller workspace, so an unscoped findFirst-by-name would pick an
  // arbitrary row on a pod with more than one discord tool. This reads
  // `discord.eventSync.synced`, so it uses the SAME eventSync predicate
  // runEventSync does (see resolve-tool.ts doc comment on why the predicate
  // is caller-supplied, not hard-coded).
  const discordTool = await resolveTool("discord", isDiscordEventSyncEnabled);
  if (!discordTool) return { skipped: true, reason: "no_discord_tool" };

  const metadata = (discordTool.metadata ?? {}) as DiscordToolMetadata;
  const eventSync = metadata.discord?.eventSync;
  const synced = eventSync?.synced ?? {};

  const gcalEntries = Object.entries(synced).filter(([k]) =>
    k.startsWith(GCAL_KEY_PREFIX)
  );
  if (gcalEntries.length === 0) {
    return { skipped: true, reason: "no_gcal_keys", gcalKeys: 0 };
  }

  const owner = discordTool.createdBy;
  const workspaceId = discordTool.workspaceId ?? null;

  // Fetch current Google events so we can rebuild the entity for in-window keys.
  const cap = await executeCapability({
    verbId: "calendar_list",
    parameters: { timeMin: "@now", maxResults: 50 },
    userId: owner,
    workspaceId,
    connectionSelector: eventSync?.connectionId
      ? { connectionId: eventSync.connectionId }
      : undefined,
  });
  if (cap.kind !== "run") {
    logger.warn(
      { capKind: cap.kind },
      "migrate-gcal: calendar_list did not run — aborting (no data to rebuild entities)"
    );
    return { skipped: true, reason: `calendar_list_${cap.kind}` };
  }
  const result = cap.result as { events?: GCalItem[] } | undefined;
  const items = Array.isArray(result?.events) ? result!.events : [];
  const itemById = new Map<string, GCalItem>();
  for (const it of items) if (it.id) itemById.set(it.id, it);

  const entityRepo = new EntityRepository(db, eventRepository);
  const idempotency = makeExternalLinkIdempotency(db, {
    namespace: "gcal",
    provider: GOOGLE_PROVIDER,
    userId: owner,
  });

  // Rebuild the synced map: carry non-gcal keys unchanged, re-key gcal keys.
  const nextSynced: Record<string, string> = {};
  for (const [k, v] of Object.entries(synced)) {
    if (!k.startsWith(GCAL_KEY_PREFIX)) nextSynced[k] = v; // synap_event/deadline
  }

  let rekeyed = 0;
  let dropped = 0;

  for (const [key, discordEventId] of gcalEntries) {
    const gcalId = key.slice(GCAL_KEY_PREFIX.length);
    try {
      // Idempotent: already migrated? (external-id resolves to an entity.)
      let entityId = await idempotency.lookup(GOOGLE_PROVIDER, gcalId);
      if (!entityId) {
        const item = itemById.get(gcalId);
        if (!item) {
          // Out-of-window Google event → its Discord event is past; drop the
          // stale key. No entity created ⇒ source A never re-creates it.
          dropped += 1;
          continue;
        }
        const graph = mapGcalToGraph(item);
        if (!graph) {
          dropped += 1;
          continue;
        }
        const createdEvent = await entityRepo.create(
          {
            profileSlug: "event",
            title: graph.event.title,
            properties: graph.event.properties,
            workspaceId,
            userId: owner,
          },
          owner
        );
        entityId = createdEvent.id;
        await idempotency.register(entityId, GOOGLE_PROVIDER, gcalId);
      }
      // RE-KEY: source A skips this entity because its synap_event key carries
      // the old (non-empty) Discord egress id — no second Discord event.
      nextSynced[`synap_event:${entityId}`] = discordEventId || "migrated";
      rekeyed += 1;
    } catch (err) {
      logger.warn({ err, gcalId }, "migrate-gcal: entity rebuild failed");
      // Leave the gcal key OUT of nextSynced only if we succeeded; on failure,
      // preserve the original key so a re-run can retry it.
      nextSynced[key] = discordEventId;
    }
  }

  // Atomic single-leaf write on {discord,eventSync,synced} (mirrors persistSynced).
  await db
    .update(tools)
    .set({
      metadata: drizzleSql`jsonb_set(COALESCE(${tools.metadata}, '{}'::jsonb), '{discord,eventSync,synced}', ${JSON.stringify(nextSynced)}::jsonb, true)`,
      updatedAt: new Date(),
    })
    .where(eq(tools.id, discordTool.id));

  logger.info(
    { gcalKeys: gcalEntries.length, rekeyed, dropped },
    "migrate-gcal-events complete"
  );
  return { gcalKeys: gcalEntries.length, rekeyed, dropped };
}

// Self-run guard: `tsx migrate-gcal-events.ts` executes the migration once.
if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("migrate-gcal-events.ts")
) {
  migrateGcalEvents()
    .then((r) => {
      logger.info({ result: r }, "migrate-gcal-events: done");
      process.exit(0);
    })
    .catch((err) => {
      logger.error({ err }, "migrate-gcal-events: failed");
      process.exit(1);
    });
}
