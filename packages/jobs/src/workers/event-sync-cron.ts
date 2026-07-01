/**
 * Event Sync Cron Worker
 *
 * Thin scheduler: on a cron tick it POSTs the api-side loopback endpoint
 * `/internal/event-sync/run`, which does the capability-heavy work (event
 * entities + Stellar deadlines + Google Calendar → native Discord scheduled
 * events).
 *
 * The jobs package cannot import @synap/api (circular dep: api → jobs → database),
 * so — exactly like mail-feed-cron.ts — the actual logic runs in the API process
 * behind an internal-only, loopback endpoint gated by BRIDGE_SECRET. This worker
 * only triggers it.
 */

import type PgBoss from "pg-boss";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "event-sync-cron" });

export const EVENT_SYNC_CRON_QUEUE = "event-sync-cron";

export async function handleEventSyncCron(_job: PgBoss.Job): Promise<void> {
  const apiUrl = process.env.API_INTERNAL_URL ?? "http://localhost:4000";
  const secret = process.env.BRIDGE_SECRET ?? "";

  try {
    const res = await fetch(`${apiUrl}/internal/event-sync/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(secret ? { "X-Bridge-Secret": secret } : {}),
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.warn(
        { status: res.status, body: text },
        "event-sync run endpoint returned non-OK status"
      );
      return;
    }

    const body = (await res.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    logger.info({ result: body }, "event-sync run complete");
  } catch (err) {
    logger.error({ err }, "event-sync cron call failed");
  }
}
