/**
 * Media-copy BACKFILL — enqueue the existing per-entity copy job for every
 * entity that already existed before the media-copy reactor did.
 *
 * The reactor (`media-copy-reactor.ts`) fires on an entity's create / update
 * only, so an entity written before D2 shipped never gets a pod copy — and
 * hosts now draw a cover ONLY from pod-held media, so without this pass every
 * existing bookmark / book / avatar loses its cover on deploy.
 *
 * ONE copy path: this module decides NOTHING about what to copy beyond the
 * runner's own plan. It reads each candidate row through the SAME
 * `presentationOf` + `planMediaCopy` the runner (`copy-entity-media.ts`) uses,
 * and for an entity that owes media it sends the SAME job
 * (`ENTITY_MEDIA_COPY_QUEUE`, `{ entityId }`). The runner re-plans from the row
 * when the job starts, so a job for an entity that was copied in the meantime
 * is a cheap no-op.
 *
 * Scope (narrowed in SQL, decided in JS by the plan):
 *   - entities of a profile whose `uiHints.presentation` declares a non-link
 *     PROPERTY media source (`declaredMediaProperty`, the runner's own rule);
 *   - entities carrying a `media-urls` property (any kind).
 *
 * Shape of the run:
 *   - batched: keyset pages of {@link BACKFILL_BATCH_SIZE} by `entities.id`;
 *   - rate-limited: each enqueued job gets its own `startAfter`, spaced
 *     {@link BACKFILL_SPACING_SECONDS} apart, so the (serial) worker starts at
 *     most one entity per slot — at most {@link MAX_MEDIA_URLS_PER_ENTITY}
 *     fetches each, the runner's existing cap. The schedule's tail
 *     (`nextStartAt`) is persisted, so a resumed or repeated run continues the
 *     spread instead of stacking a second wave on top of the first;
 *   - resumable: the cursor is persisted after every batch whose sends all
 *     succeeded. A crash re-scans at most one batch; its re-sends are absorbed
 *     by the singleton slot, and a duplicate that slips past (a new day) is
 *     idempotent in the runner (sourceUrl dedupe under a row lock).
 *
 * THE MARKER (`pod_settings.settings.mediaCopyBackfill`) asserts only what this
 * pass actually did: "every live in-scope entity up to `cursor` whose plan
 * (comparator v{@link MEDIA_COPY_BACKFILL_VERSION}) owed media had a copy job
 * enqueued". `completedAt` adds "…and the scan reached the end". It never
 * claims an image was COPIED — that is the runner's record on
 * `systemData.media` / `systemData.mediaCopyFailures`.
 * The marker is keyed on `coverage` = a hash of the version AND the media scope
 * (each declaring profile id + its declared property). A kind that gains a
 * media declaration later (a catalog update) changes the hash, so the stamp of
 * a blinder scan stops short-circuiting and the pod re-scans once — entities
 * already copied plan to nothing and are not re-enqueued.
 */

import { createHash } from "node:crypto";
import {
  db,
  and,
  or,
  gt,
  asc,
  eq,
  isNull,
  inArray,
  drizzleSql,
  entities,
  profiles,
  podSettings,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { getBoss } from "@synap/events";
import {
  ENTITY_MEDIA_COPY_QUEUE,
  type EntityMediaCopyQueueData,
} from "@synap/jobs/workers/entity-media-copy-worker.js";
import {
  CAPTURED_MEDIA_URLS_PROPERTY,
  declaredMediaProperty,
  planMediaCopy,
  presentationOf,
} from "./media-plan.js";
import { entityMediaCopySingletonKey } from "./media-copy-reactor.js";

const logger = createLogger({ module: "media-copy-backfill" });

/**
 * Bump when `planMediaCopy` learns a new SOURCE (or the scope rule changes):
 * every stamp a blinder comparator wrote then stops short-circuiting.
 */
export const MEDIA_COPY_BACKFILL_VERSION = 1;
/** The key on the singleton `pod_settings.settings` blob. */
export const MEDIA_COPY_BACKFILL_SETTINGS_KEY = "mediaCopyBackfill";
export const BACKFILL_BATCH_SIZE = 200;
/** One entity's job may start every this-many seconds (≈ 600 entities / hour). */
export const BACKFILL_SPACING_SECONDS = 6;
/**
 * The singleton slot that absorbs a re-send of the same entity (a resumed
 * batch). A day: longer than any boot loop, shorter than the queue retention.
 */
const BACKFILL_SINGLETON_SECONDS = 24 * 60 * 60;

export interface MediaCopyBackfillMarker {
  version: number;
  /** Hash of version + media scope the plan was judged against. */
  coverage: string;
  /** Last `entities.id` whose batch was fully enqueued; null = none yet. */
  cursor: string | null;
  scanned: number;
  enqueued: number;
  /** When the next enqueued job may start — the tail of the spread schedule. */
  nextStartAt: string;
  startedAt: string;
  /** Set only when the scan reached the end of the scope. */
  completedAt?: string;
}

export type BackfillSend = (
  queue: string,
  data: EntityMediaCopyQueueData,
  options: {
    startAfter: Date;
    singletonKey: string;
    singletonSeconds: number;
    retryLimit: number;
  }
) => Promise<string | null>;

export interface MediaCopyBackfillDeps {
  send?: BackfillSend;
  now?: () => Date;
  batchSize?: number;
  spacingSeconds?: number;
}

export interface MediaCopyBackfillResult {
  status: "already-complete" | "completed";
  scanned: number;
  enqueued: number;
  coverage: string;
  resumedFrom: string | null;
}

interface MediaScope {
  profileIds: string[];
  coverage: string;
}

/** Profiles whose presentation declares a media PROPERTY the runner reads. */
export async function readMediaScope(): Promise<MediaScope> {
  const rows = await db
    .select({ id: profiles.id, uiHints: profiles.uiHints })
    .from(profiles)
    .where(drizzleSql`(${profiles.uiHints} -> 'presentation') IS NOT NULL`);
  const declared = rows
    .map((r) => ({
      id: r.id,
      property: declaredMediaProperty(presentationOf(r.uiHints)),
    }))
    .filter((r): r is { id: string; property: string } => r.property !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
  const coverage = createHash("sha256")
    .update(
      JSON.stringify({
        v: MEDIA_COPY_BACKFILL_VERSION,
        scope: declared.map((d) => [d.id, d.property]),
        captured: CAPTURED_MEDIA_URLS_PROPERTY,
      })
    )
    .digest("hex")
    .slice(0, 32);
  return { profileIds: declared.map((d) => d.id), coverage };
}

export async function readBackfillMarker(): Promise<MediaCopyBackfillMarker | null> {
  const [row] = await db
    .select({ settings: podSettings.settings })
    .from(podSettings)
    .orderBy(podSettings.createdAt)
    .limit(1);
  const raw = (row?.settings as Record<string, unknown> | undefined)?.[
    MEDIA_COPY_BACKFILL_SETTINGS_KEY
  ];
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Partial<MediaCopyBackfillMarker>;
  if (
    typeof m.version !== "number" ||
    typeof m.coverage !== "string" ||
    typeof m.nextStartAt !== "string"
  )
    return null;
  return {
    version: m.version,
    coverage: m.coverage,
    cursor: typeof m.cursor === "string" ? m.cursor : null,
    scanned: typeof m.scanned === "number" ? m.scanned : 0,
    enqueued: typeof m.enqueued === "number" ? m.enqueued : 0,
    nextStartAt: m.nextStartAt,
    startedAt: typeof m.startedAt === "string" ? m.startedAt : m.nextStartAt,
    ...(typeof m.completedAt === "string"
      ? { completedAt: m.completedAt }
      : {}),
  };
}

/** Write ONLY this key on the singleton row — sibling settings are kept. */
async function writeBackfillMarker(
  marker: MediaCopyBackfillMarker
): Promise<void> {
  const [existing] = await db
    .select({ id: podSettings.id })
    .from(podSettings)
    .orderBy(podSettings.createdAt)
    .limit(1);
  if (existing) {
    await db
      .update(podSettings)
      .set({
        settings: drizzleSql`jsonb_set(coalesce(${podSettings.settings}, '{}'::jsonb), ${`{${MEDIA_COPY_BACKFILL_SETTINGS_KEY}}`}::text[], ${JSON.stringify(marker)}::jsonb, true)`,
      })
      .where(eq(podSettings.id, existing.id));
  } else {
    await db
      .insert(podSettings)
      .values({ settings: { [MEDIA_COPY_BACKFILL_SETTINGS_KEY]: marker } });
  }
}

function defaultSend(): BackfillSend {
  return (queue, data, options) => getBoss().send(queue, data, options);
}

/**
 * Run (or resume) the backfill. Idempotent: a completed stamp for the current
 * coverage returns at once; an interrupted run resumes from its cursor.
 * Throws when a send fails — the cursor then stays on the last batch that was
 * fully enqueued, and the next boot resumes there.
 */
export async function backfillEntityMediaCopies(
  deps: MediaCopyBackfillDeps = {}
): Promise<MediaCopyBackfillResult> {
  const send = deps.send ?? defaultSend();
  const now = deps.now ?? (() => new Date());
  const batchSize = deps.batchSize ?? BACKFILL_BATCH_SIZE;
  const spacingMs = (deps.spacingSeconds ?? BACKFILL_SPACING_SECONDS) * 1000;

  const scope = await readMediaScope();
  const previous = await readBackfillMarker();
  const sameCoverage =
    previous !== null &&
    previous.version === MEDIA_COPY_BACKFILL_VERSION &&
    previous.coverage === scope.coverage;

  if (sameCoverage && previous.completedAt) {
    return {
      status: "already-complete",
      scanned: previous.scanned,
      enqueued: previous.enqueued,
      coverage: scope.coverage,
      resumedFrom: null,
    };
  }

  const startedAt = now();
  // The spread never restarts behind jobs an earlier run already scheduled.
  const tail = previous ? Date.parse(previous.nextStartAt) : NaN;
  let nextStart = Math.max(
    startedAt.getTime(),
    Number.isFinite(tail) ? tail : 0
  );
  const marker: MediaCopyBackfillMarker = sameCoverage
    ? { ...previous, nextStartAt: new Date(nextStart).toISOString() }
    : {
        version: MEDIA_COPY_BACKFILL_VERSION,
        coverage: scope.coverage,
        cursor: null,
        scanned: 0,
        enqueued: 0,
        nextStartAt: new Date(nextStart).toISOString(),
        startedAt: startedAt.toISOString(),
      };
  const resumedFrom = marker.cursor;

  const inScope = and(
    isNull(entities.deletedAt),
    scope.profileIds.length > 0
      ? or(
          inArray(entities.profileId, scope.profileIds),
          drizzleSql`(${entities.properties} -> ${CAPTURED_MEDIA_URLS_PROPERTY}::text) IS NOT NULL`
        )
      : drizzleSql`(${entities.properties} -> ${CAPTURED_MEDIA_URLS_PROPERTY}::text) IS NOT NULL`
  );

  for (;;) {
    const page = await db
      .select({
        id: entities.id,
        properties: entities.properties,
        systemData: entities.systemData,
        uiHints: profiles.uiHints,
      })
      .from(entities)
      .leftJoin(profiles, eq(profiles.id, entities.profileId))
      .where(
        marker.cursor ? and(inScope, gt(entities.id, marker.cursor)) : inScope
      )
      .orderBy(asc(entities.id))
      .limit(batchSize);

    let enqueuedInPage = 0;
    for (const row of page) {
      const owed = planMediaCopy({
        properties: row.properties as Record<string, unknown> | null,
        systemData: row.systemData,
        presentation: presentationOf(row.uiHints),
      });
      if (owed.length === 0) continue;
      await send(
        ENTITY_MEDIA_COPY_QUEUE,
        { entityId: row.id },
        {
          startAfter: new Date(nextStart),
          singletonKey: entityMediaCopySingletonKey(row.id),
          singletonSeconds: BACKFILL_SINGLETON_SECONDS,
          retryLimit: 0,
        }
      );
      nextStart += spacingMs;
      enqueuedInPage++;
    }

    if (page.length > 0) {
      marker.cursor = page[page.length - 1]!.id;
      marker.scanned += page.length;
      marker.enqueued += enqueuedInPage;
      marker.nextStartAt = new Date(nextStart).toISOString();
    }
    if (page.length < batchSize) {
      marker.completedAt = now().toISOString();
      await writeBackfillMarker(marker);
      break;
    }
    await writeBackfillMarker(marker);
  }

  logger.info(
    {
      scanned: marker.scanned,
      enqueued: marker.enqueued,
      lastJobStartsAt: marker.nextStartAt,
      resumedFrom,
    },
    "media-copy backfill: scan complete"
  );
  return {
    status: "completed",
    scanned: marker.scanned,
    enqueued: marker.enqueued,
    coverage: scope.coverage,
    resumedFrom,
  };
}
