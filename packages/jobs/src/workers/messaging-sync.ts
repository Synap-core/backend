/**
 * Messaging sync workers — the person's channel stays complete (channels
 * design §3, §7).
 *
 * TWO queues:
 *   • `messaging-history-import` (on-demand) — a connected account's past
 *     conversations with people already in the pod land in their channels,
 *     silently. Enqueued when an account connects, by the owner's
 *     `POST /messaging/accounts/{id}/import-history`, and when a person's
 *     channel is opened. Re-runs are safe (every message dedups), so the
 *     handler RE-THROWS and pg-boss retries.
 *   • `messaging-webhook-ensure` (cron: hourly, plus once shortly after boot
 *     and when an account connects) — registers the pod's webhook with the
 *     provider and records whether it is complete. SWALLOWS on failure (a
 *     cron must not retry-storm).
 *
 * Both delegate to api-side runners through IoC slots, because @synap/jobs
 * cannot statically import @synap/api (circular dep). apps/api fills the
 * slots at boot — the fireflies / cal-backfill pattern.
 */

import type PgBoss from "pg-boss";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "messaging-sync" });

export const MESSAGING_HISTORY_IMPORT_QUEUE = "messaging-history-import";
export const MESSAGING_WEBHOOK_ENSURE_QUEUE = "messaging-webhook-ensure";
/** Hourly, off the top of the hour. */
export const MESSAGING_WEBHOOK_ENSURE_CRON = "17 * * * *";

/** Job payload of MESSAGING_HISTORY_IMPORT_QUEUE. */
export interface MessagingHistoryImportJobData {
  /** The account's provider id (`messaging_accounts.external_id`). */
  accountExternalId: string;
  /** The pod owner of the account. */
  userId: string;
  /** Only this person's conversation (a channel was just opened for them). */
  entityId?: string;
  /** Resume from this chat page (a paused or handed-over run). */
  cursor?: string;
}

type HistoryImportRunner = (
  input: MessagingHistoryImportJobData
) => Promise<unknown>;
type WebhookEnsureRunner = () => Promise<unknown>;

let historyImportRunner: HistoryImportRunner | null = null;
let webhookEnsureRunner: WebhookEnsureRunner | null = null;

export function registerMessagingHistoryImportRunner(
  fn: HistoryImportRunner
): void {
  historyImportRunner = fn;
}

export function registerMessagingWebhookEnsureRunner(
  fn: WebhookEnsureRunner
): void {
  webhookEnsureRunner = fn;
}

export async function handleMessagingHistoryImport(
  job: PgBoss.Job
): Promise<void> {
  if (!historyImportRunner) {
    logger.warn("messaging-history-import runner not registered — skipping");
    return;
  }
  const data = job.data as MessagingHistoryImportJobData;
  if (!data?.accountExternalId || !data?.userId) {
    logger.warn({ data }, "messaging-history-import: malformed payload");
    return;
  }
  const result = await historyImportRunner(data);
  logger.info(
    { accountExternalId: data.accountExternalId, result },
    "messaging-history-import run finished"
  );
}

export async function handleMessagingWebhookEnsure(
  _job: PgBoss.Job
): Promise<void> {
  if (!webhookEnsureRunner) {
    logger.warn("messaging-webhook-ensure runner not registered — skipping");
    return;
  }
  try {
    await webhookEnsureRunner();
  } catch (err) {
    logger.error({ err }, "messaging-webhook-ensure failed (non-fatal)");
  }
}
