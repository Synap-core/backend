/**
 * Copy an entity's external images INTO the pod (decision D2: no hot-linking —
 * no IP/referrer leak, survives the source's deletion).
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
 */

import {
  db,
  eq,
  and,
  isNull,
  drizzleSql,
  entities,
  profiles,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import type { EntityMediaCopy } from "@synap-core/types/presentation";
import { storeDocumentFromBuffer } from "../../routers/file-upload.js";
import { fetchExternalImage, type ImageFetchResult } from "./fetch-image.js";
import {
  mergeMediaSystemData,
  planMediaCopy,
  presentationOf,
  type MediaCopyFailure,
} from "./media-plan.js";

const logger = createLogger({ module: "entity-media-copy" });

export interface EntityMediaCopyJobData {
  entityId: string;
}

export interface EntityMediaCopyResult {
  status: "skipped" | "copied";
  copied: number;
  failed: number;
}

export interface CopyEntityMediaDeps {
  fetchImage?: (url: string) => Promise<ImageFetchResult>;
  store?: typeof storeDocumentFromBuffer;
  now?: () => Date;
}

export async function runEntityMediaCopy(
  input: EntityMediaCopyJobData,
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
    presentation: presentationOf(row.uiHints),
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

  await recordMediaCopyRun(row.id, { copied, failed, at: now().toISOString() });
  return { status: "copied", copied: copied.length, failed: failed.length };
}

/**
 * Fold the run into the entity's systemData under a row lock. Only the `media`
 * and `mediaCopyFailures` keys are written (`jsonb_set`), so a concurrent
 * writer's other keys are never clobbered, and two runs never double-append.
 */
async function recordMediaCopyRun(
  entityId: string,
  run: Parameters<typeof mergeMediaSystemData>[1]
): Promise<void> {
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ systemData: entities.systemData })
      .from(entities)
      .where(eq(entities.id, entityId))
      .for("update");
    if (!current) return;
    const next = mergeMediaSystemData(current.systemData, run);
    await tx
      .update(entities)
      .set({
        systemData: drizzleSql`jsonb_set(jsonb_set(COALESCE(${entities.systemData}, '{}'::jsonb), '{media}', ${JSON.stringify(next.media)}::jsonb, true), '{mediaCopyFailures}', ${JSON.stringify(next.mediaCopyFailures)}::jsonb, true)`,
      })
      .where(eq(entities.id, entityId));
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
