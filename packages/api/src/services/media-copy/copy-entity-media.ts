/**
 * Copy an entity's external images INTO the pod: no hot-linking, so no
 * IP/referrer leak to the image host, and the picture survives the source's
 * deletion.
 *
 * Fills the `ENTITY_MEDIA_COPY_QUEUE` IoC slot (registered by apps/api at boot).
 * The job is enqueued by the entity-media-copy reactor on an entity's create /
 * update side-effect fan-out — i.e. only AFTER the entity exists (approved or
 * auto-applied). A proposal never reaches here, so an agent-supplied URL cannot
 * make the server fetch before consent.
 *
 *   plan   → `planMediaCopy` (declared media property + `media-urls`, minus
 *            what is already copied or given up on)
 *   fetch  → `fetchExternalImage` (SSRF guard, streamed byte cap, magic bytes)
 *            — unless the same person's Library already copied that URL
 *            (`library-handoff.ts`): then the bytes come from that copy's
 *            blob, re-stored as this entity's own document (no fetch; the
 *            CDN link has usually expired by Build time)
 *   store  → `storeDocumentFromBuffer` — the STORE-ONLY half of the upload
 *            door: blob + `documents` row + immutable v1, and NO entity. The
 *            governed `createGovernedFileEntityFromBuffer` would mint a second
 *            (`file`) entity per image, which is exactly what a copy is not:
 *            the image belongs to THIS entity, recorded on its systemData.
 *   record → `systemData.media[]` (EntityMediaCopy, deduped by sourceUrl) and
 *            `systemData.mediaCopyFailures[]`, written under a row lock with
 *            `jsonb_set` on those two keys only — every other key is kept.
 *
 * The ENTITY write is a direct row update, not `entities.update`: it emits no
 * entity event, so the copy can never re-trigger itself. The stored copy's
 * `documents` row does emit `document.create.completed` (every document
 * write's one fact) and is marked as a media copy so document lists leave it
 * out (`media-copy-documents.ts`, which says why the event stays).
 *
 * announce → after a run that COPIED something, ONE realtime `entity:updated`
 *            push (`emitHubRealtimeEvent`, the bridge door for direct writes)
 *            so a client holding the entity in cache refetches and draws the
 *            new cover. Deliberately NOT `recordDomainMutation`: that appends
 *            an `entity.update` event AND fans out side-effects — the media-copy
 *            reactor itself (a self-trigger), the automation matcher (an "on
 *            update" automation firing because a picture was cached), webhooks
 *            and re-embedding — for a change to no property anyone wrote. The
 *            realtime push touches neither the event store nor the fan-out, so
 *            no reactor can see it. `updatedAt` is not bumped either: it is the
 *            "edited" time people read and sort by, and a backfill would make
 *            every existing bookmark read "edited today".
 */

import {
  db,
  eq,
  and,
  isNull,
  drizzleSql,
  entities,
  profiles,
  eventRepository,
  EntityBodyService,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import {
  presentationFromUiHints,
  readEntityMediaCopies,
  type EntityMediaCopy,
  type ProfilePresentation,
} from "@synap-core/types/presentation";
import { storeDocumentFromBuffer } from "../../routers/file-upload.js";
import { emitHubRealtimeEvent } from "../../utils/domain-event-bridge.js";
import { fetchExternalImage, type ImageFetchResult } from "./fetch-image.js";
import { liveDocumentIds } from "./live-documents.js";
import { imageFromLibraryCopy } from "./library-handoff.js";
import {
  collectMediaSourceUrls,
  mergeMediaSystemData,
  planMediaCopy,
  transientRetryDelaySeconds,
  type MediaCopyFailure,
} from "./media-plan.js";
import { getBoss } from "@synap/events";
import {
  ENTITY_MEDIA_COPY_QUEUE,
  type EntityMediaCopyQueueData,
} from "@synap/jobs/workers/entity-media-copy-worker.js";

const logger = createLogger({ module: "entity-media-copy" });

export interface EntityMediaCopyResult {
  status: "skipped" | "copied";
  copied: number;
  failed: number;
}

export interface CopyEntityMediaDeps {
  fetchImage?: (url: string) => Promise<ImageFetchResult>;
  /**
   * The same person's Library copy of a URL (the hand-off), consulted BEFORE
   * fetching; `null` = none, fetch as usual (default: `imageFromLibraryCopy`).
   */
  fromLibrary?: (
    userId: string,
    sourceUrl: string
  ) => Promise<ImageFetchResult | null>;
  store?: typeof storeDocumentFromBuffer;
  now?: () => Date;
  /**
   * Delete a stored document + its blobs (default: `EntityBodyService.deleteBody`).
   * Used for a copy the run stored but could not record.
   */
  discard?: (documentId: string) => Promise<void>;
  /**
   * Enqueue the follow-up run for a transient failure (default: pg-boss).
   * Resolves to the job id, or null when no job was created.
   */
  scheduleRetry?: (
    entityId: string,
    delaySeconds: number
  ) => Promise<string | null>;
  /** Tell connected clients the entity changed (default: realtime bridge). */
  announce?: (entity: {
    id: string;
    userId: string;
    workspaceId: string | null;
  }) => void;
}

/** The realtime push only — no event row, no side-effect fan-out. */
function announceMediaCopied(entity: {
  id: string;
  userId: string;
  workspaceId: string | null;
}): void {
  emitHubRealtimeEvent({
    eventType: "entity.update.completed",
    subjectId: entity.id,
    userId: entity.userId,
    data: {
      entityId: entity.id,
      // Only the entity's pod-held media changed (no property, no status):
      // a client can refresh this entity's picture without reloading every
      // board, graph and lifecycle count — and coalesce a backfill's stream.
      reason: "media",
      ...(entity.workspaceId ? { workspaceId: entity.workspaceId } : {}),
    },
  });
}

/**
 * The pod's storage refused a copy because it is not configured (the provider
 * factory's ValidationError — a missing R2 key, an unknown provider). Every
 * other copy would download its image only to be refused the same way, so
 * for {@link STORAGE_UNAVAILABLE_BACKOFF_MS} no run fetches anything.
 */
export const STORAGE_UNAVAILABLE_BACKOFF_MS = 10 * 60 * 1000;
let storageUnavailableUntil = 0;

/** Test seam. */
export function resetStorageUnavailableForTests(): void {
  storageUnavailableUntil = 0;
}

export function isStorageUnconfigured(err: unknown): boolean {
  const e = err as { name?: unknown; context?: { provider?: unknown } } | null;
  return e?.name === "ValidationError" && e.context?.provider !== undefined;
}

export async function runEntityMediaCopy(
  input: EntityMediaCopyQueueData,
  deps: CopyEntityMediaDeps = {}
): Promise<EntityMediaCopyResult> {
  const skipped: EntityMediaCopyResult = {
    status: "skipped",
    copied: 0,
    failed: 0,
  };
  const [row] = await db
    .select({
      id: entities.id,
      userId: entities.userId,
      workspaceId: entities.workspaceId,
      title: entities.title,
      documentId: entities.documentId,
      properties: entities.properties,
      systemData: entities.systemData,
      uiHints: profiles.uiHints,
    })
    .from(entities)
    .leftJoin(profiles, eq(profiles.id, entities.profileId))
    .where(and(eq(entities.id, input.entityId), isNull(entities.deletedAt)))
    .limit(1);
  if (!row) return skipped;

  const presentation = presentationFromUiHints(row.uiHints);
  const liveCopyDocumentIds = await liveDocumentIds(
    readEntityMediaCopies(row.systemData).map((m) => m.documentId)
  );
  const urls = planMediaCopy({
    properties: row.properties as Record<string, unknown> | null,
    systemData: row.systemData,
    presentation,
    documentId: row.documentId,
    liveCopyDocumentIds,
  });
  const held = readEntityMediaCopies(row.systemData);
  const stale = held.some(
    (m) =>
      !liveCopyDocumentIds.has(m.documentId) ||
      !collectMediaSourceUrls(
        row.properties as Record<string, unknown> | null,
        presentation,
        row.documentId
      ).includes(m.sourceUrl)
  );
  if (urls.length === 0 && !stale) return skipped;

  const fetchImage = deps.fetchImage ?? ((u: string) => fetchExternalImage(u));
  const fromLibrary =
    deps.fromLibrary ??
    ((userId: string, u: string) => imageFromLibraryCopy(userId, u));
  const store = deps.store ?? storeDocumentFromBuffer;
  const now = deps.now ?? (() => new Date());

  if (urls.length > 0 && now().getTime() < storageUnavailableUntil) {
    return skipped;
  }

  const copied: EntityMediaCopy[] = [];
  const failed: Array<{
    sourceUrl: string;
    reason: MediaCopyFailure["reason"];
  }> = [];

  for (const sourceUrl of urls) {
    // The Library may already hold these bytes (copied while the CDN link
    // still worked): re-store them as this entity's own copy, no fetch.
    const got =
      (await fromLibrary(row.userId, sourceUrl)) ??
      (await fetchImage(sourceUrl));
    if (!got.ok) {
      failed.push({ sourceUrl, reason: got.reason });
      logger.info(
        { entityId: row.id, sourceUrl, reason: got.reason },
        "entity-media-copy: image not copied"
      );
      continue;
    }
    try {
      const stored = await store({
        userId: row.userId,
        workspaceId: row.workspaceId ?? null,
        buffer: got.bytes,
        mimeType: got.mime,
        filename: filenameFor(sourceUrl, got.mime),
        title: row.title ? `${row.title} — image` : undefined,
        // Nobody uploaded this: the pod copied it in the background.
        storedBySystem: true,
        // The entity's picture, not a filed document: lists leave it out.
        mediaCopyOf: row.id,
      });
      copied.push({
        documentId: stored.documentId,
        mime: got.mime,
        bytes: got.bytes.byteLength,
        sourceUrl,
        ...(got.width !== undefined ? { width: got.width } : {}),
        ...(got.height !== undefined ? { height: got.height } : {}),
        copiedAt: now().toISOString(),
      });
    } catch (err) {
      if (isStorageUnconfigured(err)) {
        // Not this URL's fault, and the rest would fail the same way: stop
        // downloading, and hold every run off for a while.
        failed.push({ sourceUrl, reason: "store_unavailable" });
        storageUnavailableUntil =
          now().getTime() + STORAGE_UNAVAILABLE_BACKOFF_MS;
        logger.warn(
          { err, entityId: row.id },
          "entity-media-copy: pod storage is not configured — copies paused"
        );
        break;
      }
      failed.push({ sourceUrl, reason: "store_failed" });
      logger.warn(
        { err, entityId: row.id, sourceUrl },
        "entity-media-copy: storing the image failed"
      );
    }
  }

  // A stored blob the entity does not end up holding is an orphan nobody can
  // list or reclaim: a failed record, a deleted entity, or a concurrent run
  // that recorded the same sourceUrl first. Discard exactly those.
  const discard =
    deps.discard ??
    ((documentId: string) =>
      new EntityBodyService(db, eventRepository).deleteBody({ documentId }));
  let recorded: RecordedRun;
  try {
    recorded = await recordMediaCopyRun(
      row.id,
      { copied, failed, at: now().toISOString() },
      {
        presentation,
        deadDocumentIds: new Set(
          held
            .map((m) => m.documentId)
            .filter((id) => !liveCopyDocumentIds.has(id))
        ),
      }
    );
  } catch (err) {
    await discardAll(copied, new Set(), discard, row.id);
    throw err;
  }
  const { kept, failures, pruned } = recorded;
  await discardAll(copied, kept, discard, row.id);
  // Copies the entity no longer names (its URL changed or was removed): their
  // blobs go too. A copy whose document is already gone has nothing to discard.
  await discardAll(
    pruned.filter((m) => liveCopyDocumentIds.has(m.documentId)),
    new Set(),
    discard,
    row.id
  );
  const retryIn = transientRetryDelaySeconds(
    failures,
    new Set(failed.map((f) => f.sourceUrl))
  );
  if (retryIn !== null) {
    const jobId = await (deps.scheduleRetry ?? scheduleMediaCopyRetry)(
      row.id,
      retryIn
    );
    if (!jobId) {
      // The transient failure stays recorded, so the next edit of the entity
      // (or a backfill re-scan) re-plans it; nothing else will.
      logger.warn(
        { entityId: row.id, delaySeconds: retryIn },
        "entity-media-copy: the follow-up run was not enqueued"
      );
    }
  }
  if (copied.some((c) => kept.has(c.documentId)) || pruned.length > 0) {
    (deps.announce ?? announceMediaCopied)({
      id: row.id,
      userId: row.userId,
      workspaceId: row.workspaceId ?? null,
    });
  }
  return {
    status: "copied",
    copied: copied.filter((c) => kept.has(c.documentId)).length,
    failed: failed.length,
  };
}

async function discardAll(
  copied: EntityMediaCopy[],
  kept: Set<string>,
  discard: (documentId: string) => Promise<void>,
  entityId: string
): Promise<void> {
  for (const c of copied) {
    if (kept.has(c.documentId)) continue;
    try {
      await discard(c.documentId);
    } catch (err) {
      logger.warn(
        { err, entityId, documentId: c.documentId },
        "entity-media-copy: discarding an unrecorded copy failed"
      );
    }
  }
}

/**
 * One delayed follow-up run. Deliberately NOT under the entity's singleton
 * slot: a slot is computed from the send time, so a retry sent from inside a
 * run lands in the same slot as the job that is running (or the reactor's
 * next one) and pg-boss drops it (`send` returns null). The runner re-plans
 * from the row, so a duplicate run is harmless; a lost retry is not.
 * Returns the job id, or null when pg-boss did not create the job.
 */
async function scheduleMediaCopyRetry(
  entityId: string,
  delaySeconds: number
): Promise<string | null> {
  return getBoss().send(
    ENTITY_MEDIA_COPY_QUEUE,
    { entityId },
    { startAfter: delaySeconds, retryLimit: 0 }
  );
}

interface RecordedRun {
  /** This run's copies the entity now holds. */
  kept: Set<string>;
  /** The entity's failure record after the run. */
  failures: MediaCopyFailure[];
  /** Copies dropped because the entity no longer names their source. */
  pruned: EntityMediaCopy[];
}

/**
 * Fold the run into the entity's systemData under a row lock. Only the `media`
 * and `mediaCopyFailures` keys are written (`jsonb_set`), so a concurrent
 * writer's other keys are never clobbered, and two runs never double-append.
 * The sources kept are read from the LOCKED row, so an edit that landed while
 * the run was fetching is honoured. Returns this run's copies the entity now
 * holds, its failure record, and the copies it pruned.
 */
async function recordMediaCopyRun(
  entityId: string,
  run: Parameters<typeof mergeMediaSystemData>[1],
  ctx: {
    presentation: ProfilePresentation | null;
    deadDocumentIds: ReadonlySet<string>;
  }
): Promise<RecordedRun> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        systemData: entities.systemData,
        properties: entities.properties,
        documentId: entities.documentId,
      })
      .from(entities)
      .where(eq(entities.id, entityId))
      .for("update");
    if (!current) return { kept: new Set<string>(), failures: [], pruned: [] };
    const next = mergeMediaSystemData(current.systemData, run, {
      sources: new Set(
        collectMediaSourceUrls(
          current.properties as Record<string, unknown> | null,
          ctx.presentation,
          current.documentId
        )
      ),
      deadDocumentIds: ctx.deadDocumentIds,
    });
    await tx
      .update(entities)
      .set({
        systemData: drizzleSql`jsonb_set(jsonb_set(COALESCE(${entities.systemData}, '{}'::jsonb), '{media}', ${JSON.stringify(next.media)}::jsonb, true), '{mediaCopyFailures}', ${JSON.stringify(next.mediaCopyFailures)}::jsonb, true)`,
      })
      .where(eq(entities.id, entityId));
    const held = new Set(next.media.map((m) => m.documentId));
    return {
      kept: new Set(
        run.copied.map((c) => c.documentId).filter((id) => held.has(id))
      ),
      failures: next.mediaCopyFailures,
      pruned: next.pruned,
    };
  });
}

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

/** A filename from the URL path, with the SNIFFED type's extension. */
export function filenameFor(sourceUrl: string, mime: string): string {
  const ext = EXT[mime] ?? "img";
  let base = "image";
  try {
    const last = new URL(sourceUrl).pathname.split("/").filter(Boolean).pop();
    if (last) base = decodeURIComponent(last).replace(/\.[a-z0-9]{1,5}$/i, "");
  } catch {
    // keep the default
  }
  base = base.replace(/[^\w.-]+/g, "-").slice(0, 80) || "image";
  return `${base}.${ext}`;
}
