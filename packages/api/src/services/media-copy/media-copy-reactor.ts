/**
 * The trigger for the media-copy job: an entity's create / update side-effect
 * fan-out (`recordDomainMutation` → `emitSideEffects`), which only ever runs
 * AFTER the write was applied — a direct auto-approved write, or the approval
 * of a proposal. A pending proposal emits `proposal.*`, never `entity.*`, so an
 * agent-supplied URL cannot make the pod fetch anything before consent.
 *
 * The reactor stays cheap (the side-effect payload carries no properties): it
 * enqueues one debounced job per entity, and the runner decides from the row
 * whether anything is owed. A profile with no presentation and no
 * capture-provided `media-urls` costs one indexed read.
 */

import { createLogger } from "@synap-core/core";
import { registerReactor, type Reactor } from "@synap/events";
import {
  ENTITY_MEDIA_COPY_QUEUE,
  type EntityMediaCopyQueueData,
} from "@synap/jobs/workers/entity-media-copy-worker.js";

const logger = createLogger({ module: "entity-media-copy-reactor" });

/**
 * Debounce window: a burst of writes to one entity collapses into one job per
 * slot; a write landing in a busy slot is pushed to the next one, so the last
 * change is always seen (the runner re-reads the row).
 */
const DEBOUNCE_SECONDS = 10;

export const entityMediaCopyReactor: Reactor = {
  id: "entity-media-copy",
  match: (payload) =>
    payload.subjectType === "entity" &&
    (payload.action === "create" || payload.action === "update"),
  async handler(payload, { boss }) {
    if (!payload.subjectId) return;
    await boss.send(
      ENTITY_MEDIA_COPY_QUEUE,
      { entityId: payload.subjectId } satisfies EntityMediaCopyQueueData,
      {
        singletonKey: `entity-media-copy:${payload.subjectId}`,
        singletonSeconds: DEBOUNCE_SECONDS,
        singletonNextSlot: true,
        retryLimit: 0,
      }
    );
  },
};

let registered = false;

/** Register the reactor. Called once at API boot (`apps/api/src/index.ts`). */
export function registerEntityMediaCopyReactor(): void {
  if (registered) return;
  registered = true;
  registerReactor(entityMediaCopyReactor);
  logger.info("Registered entity media copy reactor");
}
