/**
 * Entity Media Copy Worker — copy an entity's external images into the pod.
 *
 * Decision D2 (entity rendering consolidation, 2026-10-13): an external image
 * an entity names — in its profile's declared media property, or in the
 * `media-urls` a capture producer handed over — is COPIED into the pod after
 * the entity exists, and recorded on `entities.systemData.media[]`. Renderers
 * then draw the pod copy, never the third-party URL.
 *
 * Enqueued by the api-side entity-media-copy reactor on an entity's create /
 * update fan-out (so only after the write was applied — never at proposal
 * time). The work itself is api-side (fetch guard, the store door, the
 * systemData write); @synap/jobs cannot import @synap/api (api → jobs →
 * database), so apps/api fills the runner slot at boot via
 * `registerEntityMediaCopyRunner()` — the inbound-attachment IoC pattern.
 *
 * Failure posture: the runner records per-URL failures on the entity
 * (`systemData.mediaCopyFailures`); a thrown run is logged and NOT retried by
 * pg-boss — the next update of the entity re-plans it.
 */

import type PgBoss from "pg-boss";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "entity-media-copy-worker" });

export const ENTITY_MEDIA_COPY_QUEUE = "entity-media-copy";

/** Job payload the reactor enqueues onto ENTITY_MEDIA_COPY_QUEUE. */
export interface EntityMediaCopyQueueData {
  entityId: string;
}

type EntityMediaCopyRunner = (
  input: EntityMediaCopyQueueData
) => Promise<unknown>;

let entityMediaCopyRunner: EntityMediaCopyRunner | null = null;

export function registerEntityMediaCopyRunner(fn: EntityMediaCopyRunner): void {
  entityMediaCopyRunner = fn;
}

export async function handleEntityMediaCopy(job: PgBoss.Job): Promise<void> {
  if (!entityMediaCopyRunner) {
    logger.warn("entity-media-copy runner not registered — skipping job");
    return;
  }
  const data = job.data as EntityMediaCopyQueueData;
  if (!data?.entityId) {
    logger.warn(
      { data },
      "entity-media-copy: malformed job payload — dropping"
    );
    return;
  }
  try {
    const result = await entityMediaCopyRunner(data);
    logger.info({ entityId: data.entityId, result }, "entity-media-copy done");
  } catch (err) {
    logger.warn(
      { err, entityId: data.entityId },
      "entity-media-copy failed (non-fatal, no retry)"
    );
  }
}
