/**
 * Fireflies workers — inbound transcript ingestion + backfill safety net.
 *
 * TWO queues:
 *   • `fireflies-ingest` (on-demand) — the inbound webhook enqueues a
 *     {meetingId, clientReferenceId, toolId, workspaceId?, ownerUserId} job here
 *     (ack-then-process), so the fetch-then-land runs off the request path with
 *     pg-boss retry/timeout safety. Handler RE-THROWS on failure so pg-boss retries.
 *   • `fireflies-backfill-cron` (cron) — lists recent transcripts and re-ingests
 *     any not-yet-seen meeting (catches webhooks missed during downtime). Handler
 *     SWALLOWS on failure (a cron must not retry-storm).
 *
 * Both delegate to api-side runners (executeCapability + recordInboundMessage) via
 * IoC slots, because @synap/jobs cannot statically import @synap/api (circular dep).
 * apps/api fills the slots at boot — same pattern as cal-backfill / mail-feed.
 */

import type PgBoss from "pg-boss";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "fireflies-worker" });

export const FIREFLIES_INGEST_QUEUE = "fireflies-ingest";
export const FIREFLIES_BACKFILL_CRON_QUEUE = "fireflies-backfill-cron";
export const FIREFLIES_BACKFILL_CRON = "*/30 * * * *";

/** Job payload the webhook enqueues onto FIREFLIES_INGEST_QUEUE. */
export interface FirefliesIngestJobData {
  meetingId: string;
  clientReferenceId?: string | null;
  toolId: string;
  workspaceId?: string | null;
  ownerUserId: string;
}

type FirefliesIngestRunner = (
  input: FirefliesIngestJobData
) => Promise<unknown>;
type FirefliesBackfillRunner = () => Promise<unknown>;

let firefliesIngestRunner: FirefliesIngestRunner | null = null;
let firefliesBackfillRunner: FirefliesBackfillRunner | null = null;

export function registerFirefliesIngestRunner(fn: FirefliesIngestRunner): void {
  firefliesIngestRunner = fn;
}

export function registerFirefliesBackfillRunner(
  fn: FirefliesBackfillRunner
): void {
  firefliesBackfillRunner = fn;
}

export async function handleFirefliesIngest(job: PgBoss.Job): Promise<void> {
  if (!firefliesIngestRunner) {
    logger.warn("fireflies-ingest runner not registered — skipping job");
    return;
  }
  const data = job.data as FirefliesIngestJobData;
  if (!data?.meetingId || !data?.toolId || !data?.ownerUserId) {
    logger.warn({ data }, "fireflies-ingest: malformed job payload — dropping");
    return;
  }
  // Re-throw on failure so pg-boss retries this job (transient GraphQL/timeout).
  const result = await firefliesIngestRunner(data);
  logger.info(
    { meetingId: data.meetingId, result },
    "fireflies-ingest complete"
  );
}

export async function handleFirefliesBackfillCron(
  _job: PgBoss.Job
): Promise<void> {
  if (!firefliesBackfillRunner) {
    logger.warn("fireflies-backfill runner not registered — skipping tick");
    return;
  }
  try {
    const result = await firefliesBackfillRunner();
    logger.info({ result }, "fireflies-backfill run complete");
  } catch (err) {
    logger.error({ err }, "fireflies-backfill run failed");
  }
}
