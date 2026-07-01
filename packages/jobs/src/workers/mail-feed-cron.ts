/**
 * Mail Feed Cron Worker
 *
 * Thin scheduler: on a cron tick it POSTs the api-side loopback endpoint
 * `/internal/mail-feed/run`, which does the capability-heavy work (gmail_search
 * + IS triage + posting into the Discord-bound Synap channel).
 *
 * The jobs package cannot import @synap/api (circular dep: api → jobs → database),
 * so — exactly like proactive-post.ts's external delivery — the actual logic runs
 * in the API process behind an internal-only, loopback endpoint gated by
 * BRIDGE_SECRET. This worker only triggers it.
 */

import type PgBoss from "pg-boss";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "mail-feed-cron" });

export const MAIL_FEED_CRON_QUEUE = "mail-feed-cron";

export async function handleMailFeedCron(_job: PgBoss.Job): Promise<void> {
  const apiUrl = process.env.API_INTERNAL_URL ?? "http://localhost:4000";
  const secret = process.env.BRIDGE_SECRET ?? "";

  try {
    const res = await fetch(`${apiUrl}/internal/mail-feed/run`, {
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
        "mail-feed run endpoint returned non-OK status"
      );
      return;
    }

    const body = (await res.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    logger.info({ result: body }, "mail-feed run complete");
  } catch (err) {
    logger.error({ err }, "mail-feed cron call failed");
  }
}
