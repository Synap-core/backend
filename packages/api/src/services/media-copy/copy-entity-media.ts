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
 *   store  → `storeDocumentFromBuffer` — the STORE-ONLY half of the upload
 *            door: blob + `documents` row + immutable v1, and NO entity. The
 *            governed `createGovernedFileEntityFromBuffer` would mint a second
 *            (`file`) entity per image, which is exactly what a copy is not:
 *            the image belongs to THIS entity, recorded on its systemData.
 *   record → `systemData.media[]` (EntityMediaCopy, deduped by sourceUrl) and
 *            `systemData.mediaCopyFailures[]`, written under a row lock with
 *            `jsonb_set` on those two keys only — every other key is kept.
 *
 * The write is a direct row update, not `entities.update`: it emits no event,
 * so the copy can never re-trigger itself.
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
  type EntityMediaCopy,
} from "@synap-core/types/presentation";
import { storeDocumentFromBuffer } from "../../routers/file-upload.js";
import { emitHubRealtimeEvent } from "../../utils/domain-event-bridge.js";
import { fetchExternalImage, type ImageFetchResult } from "./fetch-image.js";
import {
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
import { entityMediaCopySingletonKey } from "./media-copy-reactor.js";

const logger = createLogger({ module: "entity-media-copy" });

export interface EntityMediaCopyResult {
  status: "skipped" | "copied";
  copied: number;
  failed: number;
}

export interface CopyEntityMediaDeps {
  fetchImage?: (url: string) => Promise<ImageFetchResult>;
  store?: typeof storeDocumentFromBuffer;
  now?: () => Date;
  /**
   * Delete a stored document + its blobs (default: `EntityBodyService.deleteBody`).
   * Used for a copy the run stored but could not record.
   */
  discard?: (documentId: string) => Promise<void>;
  /** Enqueue the follow-up run for a transient failure (default: pg-boss). */
  scheduleRetry?: (entityId: string, delaySeconds: number) => Promise<void>;
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
      ...(entity.workspaceId ? { workspaceId: entity.workspaceId } : {}),
    },
  });
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
      properties: entities.properties,
      systemData: entities.systemData,
      uiHints: profiles.uiHints,
    })
    .from(entities)
    .leftJoin(profiles, eq(profiles.id, entities.profileId))
    .where(and(eq(entities.id, input.entityId), isNull(entities.deletedAt)))
    .limit(1);
  if (!row) return skipped;

  const urls = planMediaCopy({
    properties: row.properties as Record<string, unknown> | null,
    systemData: row.systemData,
    presentation: presentationFromUiHints(row.uiHints),
  });
  if (urls.length === 0) return skipped;

  const fetchImage = deps.fetchImage ?? ((u: string) => fetchExternalImage(u));
  const store = deps.store ?? storeDocumentFromBuffer;
  const now = deps.now ?? (() => new Date());

  const copied: EntityMediaCopy[] = [];
  const failed: Array<{
    sourceUrl: string;
    reason: MediaCopyFailure["reason"];
  }> = [];

  for (const sourceUrl of urls) {
    const got = await fetchImage(sourceUrl);
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
    recorded = await recordMediaCopyRun(row.id, {
      copied,
      failed,
      at: now().toISOString(),
    });
  } catch (err) {
    await discardAll(copied, new Set(), discard, row.id);
    throw err;
  }
  const { kept, failures } = recorded;
  await discardAll(copied, kept, discard, row.id);
  const retryIn = transientRetryDelaySeconds(
    failures,
    new Set(failed.map((f) => f.sourceUrl))
  );
  if (retryIn !== null) {
    await (deps.scheduleRetry ?? scheduleMediaCopyRetry)(row.id, retryIn);
  }
  if (copied.some((c) => kept.has(c.documentId))) {
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

/** One delayed follow-up run, under the entity's one job key. */
async function scheduleMediaCopyRetry(
  entityId: string,
  delaySeconds: number
): Promise<void> {
  await getBoss().send(
    ENTITY_MEDIA_COPY_QUEUE,
    { entityId },
    {
      startAfter: delaySeconds,
      singletonKey: entityMediaCopySingletonKey(entityId),
      singletonSeconds: delaySeconds,
      retryLimit: 0,
    }
  );
}

interface RecordedRun {
  /** This run's copies the entity now holds. */
  kept: Set<string>;
  /** The entity's failure record after the run. */
  failures: MediaCopyFailure[];
}

/**
 * Fold the run into the entity's systemData under a row lock. Only the `media`
 * and `mediaCopyFailures` keys are written (`jsonb_set`), so a concurrent
 * writer's other keys are never clobbered, and two runs never double-append.
 * Returns this run's copies the entity now holds, and its failure record.
 */
async function recordMediaCopyRun(
  entityId: string,
  run: Parameters<typeof mergeMediaSystemData>[1]
): Promise<RecordedRun> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ systemData: entities.systemData })
      .from(entities)
      .where(eq(entities.id, entityId))
      .for("update");
    if (!current) return { kept: new Set<string>(), failures: [] };
    const next = mergeMediaSystemData(current.systemData, run);
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
    };
  });
}

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
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
