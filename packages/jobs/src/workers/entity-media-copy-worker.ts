/**
 * Entity Media Copy Worker — copy an entity's external images into the pod.
 *
 * Why: an <img> on a third-party URL leaks the viewer's IP and referrer and
 * dies with the source, so an external image an entity names — in its profile's declared media property, or in the
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
 * (`systemData.mediaCopyFailures`). A TRANSIENT one (timeout, 5xx, a failed
 * store) makes the runner enqueue one delayed follow-up run itself, with
 * backoff, until the attempt cap; a permanent one is final. A thrown run is
 * logged and NOT retried by pg-boss — the next update of the entity re-plans
 * it.
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
let announceRunner: (() => void) | null = null;
let runnerRegistered = new Promise<void>((resolve) => {
  announceRunner = resolve;
});

/**
 * How long a job that starts before the runner is registered waits for it.
 * apps/api starts the workers before it fills the IoC slots, so a job already
 * queued (a backfill slot, a retry) can be picked up in that gap; the wait
 * covers the gap instead of completing the job as a silent no-op.
 */
export const RUNNER_REGISTRATION_WAIT_MS = 60_000;

export function registerEntityMediaCopyRunner(fn: EntityMediaCopyRunner): void {
  entityMediaCopyRunner = fn;
  announceRunner?.();
}

/** Test seam: forget the registered runner. */
export function resetEntityMediaCopyRunnerForTests(): void {
  entityMediaCopyRunner = null;
  runnerRegistered = new Promise<void>((resolve) => {
    announceRunner = resolve;
  });
}

async function awaitRunner(
  waitMs: number
): Promise<EntityMediaCopyRunner | null> {
  if (entityMediaCopyRunner) return entityMediaCopyRunner;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    runnerRegistered,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs);
    }),
  ]);
  clearTimeout(timer);
  return entityMediaCopyRunner;
}

export async function handleEntityMediaCopy(
  job: PgBoss.Job,
  opts: { waitMs?: number } = {}
): Promise<void> {
  const runner = await awaitRunner(opts.waitMs ?? RUNNER_REGISTRATION_WAIT_MS);
  if (!runner) {
    // Never complete the job as if it ran: pg-boss records the throw as a
    // failed job (visible), where a return would read as done.
    throw new Error(
      "entity-media-copy runner not registered — the job did not run"
    );
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
    const result = await runner(data);
    logger.info({ entityId: data.entityId, result }, "entity-media-copy done");
  } catch (err) {
    logger.warn(
      { err, entityId: data.entityId },
      "entity-media-copy failed (non-fatal, no retry)"
    );
  }
}
